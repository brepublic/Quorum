import type {ApiErrorBody} from '@quorum/contracts';
import {createReadStream} from 'node:fs';
import type {StorageAgentConflict, StorageAgentLocalChange, StorageAgentLocalChangeResult, StorageAgentPairingResult,
  StorageAgentTask, StorageAgentTaskPage, StorageAgentFileStatusPage, StorageManifestPage} from '@quorum/contracts';
import {AgentApiError} from './errors.js';

interface SuccessEnvelope<T> {data: T; meta: {requestId: string}}
interface ErrorEnvelope {error?: Partial<ApiErrorBody['error']>}
type Fetch = typeof fetch;

function serverUrl(value: string): URL {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !local)) {
    throw new Error('Agent server URL must be HTTPS without credentials, query, or fragment.');
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  return url;
}

async function error(response: Response): Promise<AgentApiError> {
  let body: ErrorEnvelope | null = null;
  try {body = await response.json() as ErrorEnvelope;} catch { /* no raw response text */ }
  if (!body?.error || typeof body.error.code !== 'string' || typeof body.error.message !== 'string') {
    return new AgentApiError(response.status, 'INVALID_RESPONSE', 'The server response was invalid.');
  }
  return new AgentApiError(response.status, body.error.code, body.error.message, body.error.details, body.error);
}

async function responseData<T>(response: Response): Promise<T> {
  if (!response.ok) throw await error(response);
  let body: unknown;
  try {body = await response.json();}
  catch {throw new AgentApiError(response.status, 'INVALID_RESPONSE', 'The server response was invalid.');}
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('data' in body)) {
    throw new AgentApiError(response.status, 'INVALID_RESPONSE', 'The server response was invalid.');
  }
  return (body as SuccessEnvelope<T>).data;
}

async function connect(fetcher: Fetch, input: Parameters<Fetch>[0], init: Parameters<Fetch>[1]): Promise<Response> {
  try {return await fetcher(input, init);}
  catch (cause) {
    if (init?.signal?.aborted && init.signal.reason?.name === 'AbortError') throw cause;
    throw Object.assign(new Error('Unable to connect to the server.', {cause}), {code: 'NETWORK_ERROR'});
  }
}

export class StorageAgentHttpClient {
  private readonly base: URL;
  private readonly fetcher: Fetch;

  constructor(baseUrl: string, private readonly credential: string, fetcher: Fetch = fetch,
    signal?: AbortSignal) {
    this.fetcher = (input, init) => connect(fetcher, input, {...init, redirect: 'error',
      signal: init?.signal ?? signal});
    this.base = serverUrl(baseUrl);
    if (!/^qsa1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(credential)) {
      throw new Error('Storage Agent credential is invalid.');
    }
  }

  static async pair(baseUrl: string, body: {pairingCode: string; deviceLabel: string; devicePublicKey: string},
    fetcher: Fetch = fetch): Promise<StorageAgentPairingResult> {
    const base = serverUrl(baseUrl);
    const response = await connect(fetcher, new URL('/api/v1/storage-agent/pair', base), {method: 'POST',
      redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
    return responseData<StorageAgentPairingResult>(response);
  }

  heartbeat(leaseGeneration: number): Promise<unknown> {
    return this.json('/api/v1/storage-agent/heartbeat', {method: 'POST', body: {
      leaseGeneration, agentProtocolVersion: 2, capabilities: ['SSE_WAKE', 'CACHE_REFILL']
    }});
  }

  async events(leaseGeneration: number, signal: AbortSignal, wake: () => void): Promise<void> {
    const response = await this.fetcher(new URL('/api/v1/storage-agent/events', this.base), {
      method: 'GET', signal, headers: this.headers({accept: 'text/event-stream',
        'x-storage-lease-generation': String(leaseGeneration)})
    });
    if (!response.ok) throw await error(response);
    if (!response.body) throw new AgentApiError(502, 'INCOMPLETE_RESPONSE', 'Storage Agent event response is empty.');
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, {stream: true}).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (event.split('\n').some(line => line === 'event: wake')) wake();
        boundary = buffer.indexOf('\n\n');
      }
    }
  }

  fileStatus(leaseGeneration: number, after = ''): Promise<StorageAgentFileStatusPage> {
    return this.json(`/api/v1/storage-agent/file-status?after=${encodeURIComponent(after)}`, {method: 'GET',
      headers: {'x-storage-lease-generation': String(leaseGeneration)}});
  }

  manifest(leaseGeneration: number, after = 0, limit = 100): Promise<StorageManifestPage> {
    return this.json(`/api/v1/storage-agent/manifest?after=${after}&limit=${limit}`, {method: 'GET',
      headers: {'x-storage-lease-generation': String(leaseGeneration)}});
  }

  tasks(leaseGeneration: number, after = 0, limit = 100): Promise<StorageAgentTaskPage> {
    return this.json(`/api/v1/storage-agent/tasks?after=${after}&limit=${limit}`, {method: 'GET',
      headers: {'x-storage-lease-generation': String(leaseGeneration)}});
  }

  claim(task: StorageAgentTask, requestId: string): Promise<StorageAgentTask> {
    return this.json(`/api/v1/storage-agent/tasks/${task.id}/claim`, {method: 'POST', body: {
      leaseGeneration: task.leaseGeneration, fileRevision: task.fileRevision, requestId}});
  }

  complete(task: StorageAgentTask, claimToken: string, requestId: string): Promise<StorageAgentTask> {
    return this.json(`/api/v1/storage-agent/tasks/${task.id}/complete`, {method: 'POST', body: {
      leaseGeneration: task.leaseGeneration, fileRevision: task.fileRevision, claimToken, requestId}});
  }

  fail(task: StorageAgentTask, claimToken: string, requestId: string, failureCode: string,
    failureReason?: string): Promise<StorageAgentTask> {
    return this.json(`/api/v1/storage-agent/tasks/${task.id}/fail`, {method: 'POST', body: {
      leaseGeneration: task.leaseGeneration, fileRevision: task.fileRevision, claimToken, requestId,
      failureCode, ...(failureReason ? {failureReason} : {})}});
  }

  async localChange(leaseGeneration: number, requestId: string, manifestSequence: number,
    change: StorageAgentLocalChange, resolutionConflictId?: string): Promise<StorageAgentLocalChangeResult> {
    try {
      return await this.json('/api/v1/storage-agent/local-changes', {method: 'POST', body: {
        leaseGeneration, requestId, manifestSequence, change, ...(resolutionConflictId ? {resolutionConflictId} : {})}});
    } catch (caught) {
      if (caught instanceof AgentApiError && caught.code === 'CHAIR_DECISION_REQUIRED'
        && caught.details && typeof caught.details === 'object'
        && (caught.details as {status?: string}).status === 'CONFLICT') {
        return caught.details as StorageAgentLocalChangeResult;
      }
      throw caught;
    }
  }

  conflicts(leaseGeneration: number): Promise<StorageAgentConflict[]> {
    return this.json('/api/v1/storage-agent/conflicts', {method: 'GET',
      headers: {'x-storage-lease-generation': String(leaseGeneration)}});
  }

  async download(task: StorageAgentTask, claimToken: string): Promise<AsyncIterable<Uint8Array>> {
    if (!task.blobId) throw new Error('Storage task has no blob.');
    const response = await this.fetcher(new URL(`/api/v1/storage-agent/blobs/${task.blobId}`, this.base), {
      headers: this.headers({'x-storage-task-id': task.id, 'x-storage-lease-generation': String(task.leaseGeneration),
        'x-storage-file-revision': String(task.fileRevision), 'x-storage-task-claim': claimToken})});
    if (!response.ok) throw await error(response);
    if (!response.body) throw new AgentApiError(502, 'INCOMPLETE_RESPONSE', 'Storage Agent blob response is empty.');
    return response.body as unknown as AsyncIterable<Uint8Array>;
  }

  async upload(task: StorageAgentTask, claimToken: string, path: string,
    progress?: (bytes: number) => void): Promise<StorageAgentTask> {
    if (task.expectedSizeBytes === null || !task.expectedSha256) throw new Error('Storage task has no content metadata.');
    const response = await this.fetcher(new URL('/api/v1/storage-agent/blobs', this.base), {
      method: 'POST', headers: this.headers({'content-type': 'application/octet-stream',
        'content-length': String(task.expectedSizeBytes), 'x-content-sha256': task.expectedSha256,
        'x-storage-task-id': task.id, 'x-storage-lease-generation': String(task.leaseGeneration),
        'x-storage-file-revision': String(task.fileRevision), 'x-storage-task-claim': claimToken}),
      body: (async function* () {let sent = 0; for await (const chunk of createReadStream(path)) {
        sent += chunk.length; progress?.(sent); yield chunk;
      }})() as unknown as BodyInit, duplex: 'half'
    } as RequestInit & {duplex: 'half'});
    return responseData<StorageAgentTask>(response);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {authorization: `QuorumAgent ${this.credential}`, ...extra};
  }

  private async json<T>(path: string, options: {method: 'GET' | 'POST'; headers?: Record<string, string>;
    body?: unknown}): Promise<T> {
    const response = await this.fetcher(new URL(path, this.base), {method: options.method,
      headers: this.headers({...options.headers, ...(options.body === undefined ? {} : {'content-type': 'application/json'})}),
      ...(options.body === undefined ? {} : {body: JSON.stringify(options.body)})});
    return responseData<T>(response);
  }
}
