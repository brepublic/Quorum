/** One bounded retry policy per request, including reading its response body. */
export class RequestTimeout extends Error {
  readonly code = 'REQUEST_TIMEOUT';
  constructor() {super('The request timed out.'); this.name = 'RequestTimeout';}
}

export function isTemporaryFailure(error: unknown): boolean {
  const value = error as {code?: string; status?: number};
  return value?.code === 'NETWORK_ERROR' || value?.code === 'REQUEST_TIMEOUT'
    || [408, 429, 502, 503, 504].includes(value?.status ?? 0);
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new DOMException('Cancelled', 'AbortError'));};
    const timer = setTimeout(() => {signal?.removeEventListener('abort', abort); resolve();}, ms);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once: true});
  });
}

export async function requestWithPolicy<T>(operation: (signal: AbortSignal) => Promise<T>,
  options: {signal?: AbortSignal; read?: boolean; repeatable?: boolean} = {}): Promise<T> {
  const attempts = options.read || options.repeatable ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, {once: true});
    if (options.signal?.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise<never>((_, reject) => {
          rejectAbort = () => reject(new DOMException('Cancelled', 'AbortError'));
          controller.signal.addEventListener('abort', rejectAbort, {once: true});
          if (controller.signal.aborted) rejectAbort();
          timer = setTimeout(() => {reject(new RequestTimeout()); controller.abort();}, options.read ? 8_000 : 15_000);
        })
      ]);
    } catch (error) {
      if (options.signal?.aborted || !isTemporaryFailure(error) || attempt === attempts - 1) throw error;
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
    }
    await abortableDelay(attempt === 0 ? 1_000 : 3_000, options.signal);
  }
  throw new RequestTimeout();
}
