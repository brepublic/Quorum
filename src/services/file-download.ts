import {saveAs} from 'file-saver';
import type {DownloadReadiness} from '@quorum/contracts';
import {abortableDelay, requestWithPolicy, RequestTimeout} from './request-policy';

const active = new Set<AbortController>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
export const downloadActivity = {
  count: () => active.size,
  subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
  cancel() {active.forEach(controller => controller.abort());}
};

async function cancellable<T>(operation: Promise<T>, signal: AbortSignal, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException('Cancelled', 'AbortError'));
      signal.addEventListener('abort', abort, {once: true});
      if (signal.aborted) abort();
      timer = setTimeout(() => reject(new RequestTimeout()), milliseconds);
    })]);
  } finally {clearTimeout(timer); signal.removeEventListener('abort', abort);}
}

/** Keep HTTP errors inside the application. Save only after receiving the entire file. */
export async function downloadPreparedFile(prepare: () => Promise<DownloadReadiness>,
  readiness: () => Promise<DownloadReadiness>, url: string): Promise<void> {
  const controller = new AbortController(); const signal = controller.signal;
  active.add(controller); notify();
  try {
    const deadline = Date.now() + 120_000;
    let state = await cancellable(prepare(), signal, 30_000);
    while (state.status === 'PREPARING') {
      if (Date.now() >= deadline) throw new RequestTimeout();
      await abortableDelay(Math.min(10, Math.max(1, state.retryAfterSeconds ?? 2)) * 1000, signal);
      state = await cancellable(readiness(), signal, Math.max(1, Math.min(30_000, deadline - Date.now())));
    }
    if (state.status !== 'READY') throw Object.assign(new Error('File unavailable'), {code: state.code ?? 'FILE_CONTENT_UNAVAILABLE',reason:state.reason,details:state.details});
    const response = await requestWithPolicy(async requestSignal => {
      let result: Response;
      try {result = await fetch(url, {credentials: 'same-origin', signal: requestSignal});}
      catch (error) {if (requestSignal.aborted) throw error; throw Object.assign(new Error(), {code: 'NETWORK_ERROR'});}
      if (!result.ok) {
        const payload = await result.json().catch(() => undefined);
        throw Object.assign(new Error(), {code: payload?.error?.code ?? 'HTTP_ERROR', status: result.status,
          reason: payload?.error?.reason, requestId: payload?.error?.requestId, details: payload?.error?.details});
      }
      return result;
    }, {read: true, signal});
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('content-disposition') ?? '')?.[1];
    const plain = /filename="([^"\r\n]+)"/i.exec(response.headers.get('content-disposition') ?? '')?.[1];
    let name = plain ?? 'download';
    try {if (encoded) name = decodeURIComponent(encoded);} catch { /* use the plain filename */ }
    let blob: Blob;
    if (!response.body) blob = await cancellable(response.blob(), signal, 30_000);
    else {
      const reader = response.body.getReader(); const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const chunk = await cancellable(reader.read(), signal, 30_000);
          if (chunk.done) break;
          chunks.push(chunk.value);
        }
        blob = new Blob(chunks, {type: response.headers.get('content-type') ?? 'application/octet-stream'});
      } finally {await reader.cancel().catch(() => {});}
    }
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const expected = response.headers.get('content-length');
    if (expected !== null && !response.headers.has('content-encoding') && Number(expected) !== blob.size) throw Object.assign(new Error(), {code: 'NETWORK_ERROR'});
    saveAs(blob, name);
  } finally {controller.abort(); active.delete(controller); notify();}
}
