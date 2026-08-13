// @vitest-environment node

import {describe, expect, it, vi} from 'vitest';
import {StorageAgentHttpClient} from './client';

const credential = 'qsa1.20000000-0000-4000-8000-000000000001.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const success = (data: unknown) => new Response(JSON.stringify({data, meta: {requestId: 'request'}}), {
  status: 200, headers: {'content-type': 'application/json'}});

describe('Chair Agent HTTP client', () => {
  it('keeps device authorization on every fenced request without putting it in the URL', async () => {
    const fetcher = vi.fn(async () => success({events: [], nextSequence: 0, hasMore: false}));
    const client = new StorageAgentHttpClient('https://quorum.example.com', credential, fetcher as typeof fetch);
    await client.manifest(7, 0, 25);
    const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('https://quorum.example.com/api/v1/storage-agent/manifest?after=0&limit=25');
    expect(options.headers).toMatchObject({authorization: `QuorumAgent ${credential}`,
      'x-storage-lease-generation': '7'});
    expect(url.toString()).not.toContain(credential);
  });

  it('turns a durable Chair conflict response back into its typed result', async () => {
    const details = {status: 'CONFLICT', changeRequestId: 'change', conflictId: 'conflict',
      reasonCode: 'REVISION_CONFLICT'};
    const fetcher = vi.fn(async () => new Response(JSON.stringify({error: {code: 'CHAIR_DECISION_REQUIRED',
      message: 'Conflict.', details}}), {status: 422, headers: {'content-type': 'application/json'}}));
    const client = new StorageAgentHttpClient('https://quorum.example.com', credential, fetcher as typeof fetch);
    await expect(client.localChange(7, 'request', 3, {kind: 'DELETE',
      fileEntryId: '30000000-0000-4000-8000-000000000001', baseRevision: 1})).resolves.toEqual(details);
  });

  it('requires HTTPS except for an explicit loopback development endpoint', () => {
    expect(() => new StorageAgentHttpClient('http://quorum.example.com', credential)).toThrow();
    expect(() => new StorageAgentHttpClient('https://user:secret@quorum.example.com', credential)).toThrow();
    expect(() => new StorageAgentHttpClient('http://localhost:3000', credential)).not.toThrow();
  });
});
