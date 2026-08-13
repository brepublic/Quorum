import {beforeEach, describe, expect, it, vi} from 'vitest';
import {parseSseFrame, selfHostedApi, SelfHostedApiError} from './self-hosted-api';

describe('self-hosted stage 4 API client', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'cookie', {configurable: true, value: '__Host-quorum_csrf=csrf-token'});
    vi.stubGlobal('crypto', {randomUUID: () => 'request-key'});
  });

  it('parses typed SSE frames and ignores heartbeat comments', () => {
    expect(parseSseFrame(': heartbeat')).toEqual({id: undefined, type: undefined});
    expect(parseSseFrame('id: 9\nevent: committee.updated\ndata: {"id":9}')).toEqual({
      id: 9, type: 'committee.updated', data: {id: 9}
    });
  });

  it('sends CSRF, revision, and idempotency headers for commands', async () => {
    const fetchMock = vi.fn(async () => ({ok: true, status: 201,
      json: async () => ({data: {id: 'note'}, meta: {requestId: 'one'}})}));
    vi.stubGlobal('fetch', fetchMock);
    await selfHostedApi.createNote('committee', {content: 'Plain text'});
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/committees/committee/notes', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', headers: expect.objectContaining({
        'x-csrf-token': 'csrf-token', 'idempotency-key': 'request-key', 'content-type': 'application/json'
      }), body: JSON.stringify({content: 'Plain text'})
    }));
  });

  it('preserves stable API errors so callers can revalidate after revision conflicts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ok: false, status: 409,
      json: async () => ({error: {code: 'REVISION_CONFLICT', message: 'Changed.', requestId: 'two',
        details: {currentRevision: 4}}})})));
    await expect(selfHostedApi.updateNote('note', 3, {content: 'stale'})).rejects.toEqual(expect.objectContaining({
      name: 'SelfHostedApiError', status: 409, code: 'REVISION_CONFLICT', requestId: 'two', details: {currentRevision: 4}
    } satisfies Partial<SelfHostedApiError>));
  });

  it('sends file revisions and stable idempotency keys and exposes only the attachment route', async () => {
    const fetchMock = vi.fn(async () => ({ok: true, status: 200,
      json: async () => ({data: {id: 'file', status: 'PENDING_REVIEW'}, meta: {requestId: 'file-request'}})}));
    vi.stubGlobal('fetch', fetchMock);
    await selfHostedApi.submitFileForReview('file', 7, 'review-key');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/files/file/submit-review', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', body: JSON.stringify({baseRevision: 7}),
      headers: expect.objectContaining({'x-csrf-token': 'csrf-token', 'idempotency-key': 'review-key'})
    }));
    expect(selfHostedApi.fileDownloadUrl('file id')).toBe('/api/v1/files/file%20id/download');
  });

  it('replays a caller-provided upload creation key unchanged', async () => {
    const fetchMock = vi.fn(async () => ({ok: true, status: 201,
      json: async () => ({data: {id: 'upload', status: 'CREATED'}, meta: {requestId: 'upload'}})}));
    vi.stubGlobal('fetch', fetchMock);
    const input = {logicalName: '工作文件', originalName: 'paper.pdf', mediaType: 'application/pdf',
      expectedSizeBytes: 3, sha256: 'a'.repeat(64)};
    await selfHostedApi.createFileUpload('committee', input, 'same-upload-key');
    await selfHostedApi.createFileUpload('committee', input, 'same-upload-key');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(call[1].headers).toEqual(expect.objectContaining({'idempotency-key': 'same-upload-key'}));
    }
  });

  it('keeps Chair host pairing and revocation on CSRF-protected committee commands', async () => {
    const fetchMock = vi.fn(async () => ({ok: true, status: 200,
      json: async () => ({data: {}, meta: {requestId: 'agent'}})}));
    vi.stubGlobal('fetch', fetchMock);
    await selfHostedApi.createStoragePairingCode('committee', 4, 'TRANSFER');
    await selfHostedApi.revokeStorageHost('committee', 'host', 5);
    expect(fetchMock.mock.calls[0]).toEqual(['/api/v1/committees/committee/storage-agent/pairing-codes',
      expect.objectContaining({method: 'POST', body: JSON.stringify({baseRevision: 4, purpose: 'TRANSFER'}),
        headers: expect.objectContaining({'x-csrf-token': 'csrf-token'})})]);
    expect(fetchMock.mock.calls[1]).toEqual(['/api/v1/committees/committee/storage-hosts/host/revoke',
      expect.objectContaining({method: 'POST', body: JSON.stringify({baseRevision: 5}),
        headers: expect.objectContaining({'x-csrf-token': 'csrf-token'})})]);
  });

  it('streams a File through XHR with Cookie credentials, CSRF, progress, cancellation support, and a caller key', async () => {
    class FakeRequest {
      static latest: FakeRequest;
      readonly upload: {onprogress?: (event: ProgressEvent) => void} = {};
      readonly headers = new Map<string, string>();
      withCredentials = false; status = 0; responseText = ''; body?: Document | XMLHttpRequestBodyInit | null;
      method = ''; url = '';
      onload?: () => void; onerror?: () => void; onabort?: () => void;
      constructor() { FakeRequest.latest = this; }
      open(method: string, url: string): void { this.method = method; this.url = url; }
      setRequestHeader(name: string, value: string): void { this.headers.set(name, value); }
      send(body?: Document | XMLHttpRequestBodyInit | null): void {
        this.body = body; this.upload.onprogress?.({loaded: 3, total: 3, lengthComputable: true} as ProgressEvent);
        this.status = 200; this.responseText = JSON.stringify({data: {id: 'upload', status: 'STAGED'},
          meta: {requestId: 'upload-request'}}); this.onload?.();
      }
      abort(): void { this.onabort?.(); }
    }
    vi.stubGlobal('XMLHttpRequest', FakeRequest);
    const progress = vi.fn(); const file = new File(['abc'], 'paper.txt', {type: 'text/plain'});
    await expect(selfHostedApi.uploadFileContent('upload', file, 'content-key', {onProgress: progress}))
      .resolves.toEqual(expect.objectContaining({status: 'STAGED'}));
    expect(FakeRequest.latest.withCredentials).toBe(true);
    expect(FakeRequest.latest.headers).toEqual(new Map([
      ['x-csrf-token', 'csrf-token'], ['idempotency-key', 'content-key']
    ]));
    expect(FakeRequest.latest.body).toBe(file);
    expect(progress.mock.calls).toEqual([[0, 3], [3, 3]]);
  });
});
