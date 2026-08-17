import {createReadStream} from 'node:fs';
import type {StorageAgentConflict, StorageAgentLocalChange, StorageAgentLocalChangeResult, StorageAgentPairingResult,
  StorageAgentTask, StorageAgentTaskPage, StorageManifestPage} from '@quorum/contracts';
import {AgentApiError} from './errors.js';

interface SuccessEnvelope<T> {data: T; meta: {requestId: string}}
interface ErrorEnvelope {error?: {code?: string; message?: string; details?: unknown}}
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
  let body: ErrorEnvelope = {};
  try { body = await response.json() as ErrorEnvelope; } catch { /* bounded generic error */ }
  return new AgentApiError(response.status, body.error?.code ?? 'HTTP_ERROR',
    body.error?.message ?? 'Storage Agent request failed.', body.error?.details);
}

export class StorageAgentHttpClient {
  private readonly base: URL;

  constructor(baseUrl: string, private readonly credential: string, private readonly fetcher: Fetch = fetch) {
    this.base = serverUrl(baseUrl);
    if (!/^qsa1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(credential)) {
      throw new Error('Storage Agent credential is invalid.');
    }
  }

  static async pair(baseUrl: string, body: {pairingCode: string; deviceLabel: string; devicePublicKey: string},
    fetcher: Fetch = fetch): Promise<StorageAgentPairingResult> {
    const base = serverUrl(baseUrl);
    const response = await fetcher(new URL('/api/v1/storage-agent/pair', base), {method: 'POST',
      headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
    if (!response.ok) throw await error(response);
    return (await response.json() as SuccessEnvelope<StorageAgentPairingResult>).data;
  }

  heartbeat(leaseGeneration: number): Promise<unknown> {
    return this.json('/api/v1/storage-agent/heartbeat', {method: 'POST', body: {leaseGeneration}});
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

  async upload(task: StorageAgentTask, claimToken: string, path: string): Promise<StorageAgentTask> {
    if (task.expectedSizeBytes === null || !task.expectedSha256) throw new Error('Storage task has no content metadata.');
    const response = await this.fetcher(new URL('/api/v1/storage-agent/blobs', this.base), {
      method: 'POST', headers: this.headers({'content-type': 'application/octet-stream',
        'content-length': String(task.expectedSizeBytes), 'x-content-sha256': task.expectedSha256,
        'x-storage-task-id': task.id, 'x-storage-lease-generation': String(task.leaseGeneration),
        'x-storage-file-revision': String(task.fileRevision), 'x-storage-task-claim': claimToken}),
      body: createReadStream(path) as unknown as BodyInit, duplex: 'half'
    } as RequestInit & {duplex: 'half'});
    if (!response.ok) throw await error(response);
    return (await response.json() as SuccessEnvelope<StorageAgentTask>).data;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {authorization: `QuorumAgent ${this.credential}`, ...extra};
  }

  private async json<T>(path: string, options: {method: 'GET' | 'POST'; headers?: Record<string, string>;
    body?: unknown}): Promise<T> {
    const response = await this.fetcher(new URL(path, this.base), {method: options.method,
      headers: this.headers({...options.headers, ...(options.body === undefined ? {} : {'content-type': 'application/json'})}),
      ...(options.body === undefined ? {} : {body: JSON.stringify(options.body)})});
    if (!response.ok) throw await error(response);
    return (await response.json() as SuccessEnvelope<T>).data;
  }
}
