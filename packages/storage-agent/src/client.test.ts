// @vitest-environment node

import {describe, expect, it, vi} from 'vitest';
import {StorageAgentHttpClient} from './client';

const credential = 'qsa1.20000000-0000-4000-8000-000000000001.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const success = (data: unknown) => new Response(JSON.stringify({data, meta: {requestId: 'request'}}), {
  status: 200, headers: {'content-type': 'application/json'}});

describe('Chair Agent HTTP client', () => {
  it('passes lifetime cancellation to ordinary requests and rejects credential redirects', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBe(controller.signal);
      return success({files:[],nextId:null,observedAt:'now'});
    });
    const client = new StorageAgentHttpClient('https://quorum.example.com',credential,fetcher as typeof fetch,controller.signal);
    await client.fileStatus(7);
    controller.abort();
    expect((fetcher.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
  });

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

  it('polls resolved conflicts with the same device credential and lease fence', async () => {
    const fetcher = vi.fn(async () => success([]));
    const client = new StorageAgentHttpClient('https://quorum.example.com', credential, fetcher as typeof fetch);
    await client.conflicts(7);
    const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('https://quorum.example.com/api/v1/storage-agent/conflicts');
    expect(options.headers).toMatchObject({authorization: `QuorumAgent ${credential}`,
      'x-storage-lease-generation': '7'});
  });

  it('parses only wake events from the credentialed SSE stream', async () => {
    const stream = new ReadableStream<Uint8Array>({start(controller) {
      controller.enqueue(new TextEncoder().encode(': heartbeat\n\nevent: wake\ndata: {}\n'));
      controller.enqueue(new TextEncoder().encode('\nevent: ignored\ndata: {}\n\n'));
      controller.close();
    }});
    const fetcher = vi.fn(async () => new Response(stream, {status: 200,
      headers: {'content-type': 'text/event-stream'}}));
    const client = new StorageAgentHttpClient('https://quorum.example.com', credential, fetcher as typeof fetch);
    const wake = vi.fn();
    await client.events(7, new AbortController().signal, wake);
    expect(wake).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('https://quorum.example.com/api/v1/storage-agent/events');
    expect(options.headers).toMatchObject({authorization: `QuorumAgent ${credential}`,
      'x-storage-lease-generation': '7', accept: 'text/event-stream'});
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

  it.each(['not-json', '{}', 'null'])('classifies malformed responses as server response errors: %s', async body => {
    const fetcher = vi.fn(async () => new Response(body, {status: 200}));
    const client = new StorageAgentHttpClient('https://quorum.example.com', credential, fetcher as typeof fetch);
    await expect(client.manifest(7)).rejects.toMatchObject({code: 'INVALID_RESPONSE'});
    await expect(StorageAgentHttpClient.pair('https://quorum.example.com',
      {pairingCode: 'code', deviceLabel: 'Chair', devicePublicKey: 'key'}, fetcher as typeof fetch))
      .rejects.toMatchObject({code: 'INVALID_RESPONSE'});
  });

  it('preserves structured server reasons and network causes', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({error: {code: 'RESOURCE_CONFLICT',
      reason: 'CHAIR_HOST_ALREADY_PAIRED', message: 'Already paired.'}}), {status: 409}));
    const client = new StorageAgentHttpClient('https://quorum.example.com', credential, fetcher as typeof fetch);
    await expect(client.manifest(7)).rejects.toMatchObject({code: 'RESOURCE_CONFLICT',
      localization: {reason: 'CHAIR_HOST_ALREADY_PAIRED'}});
    const cause = Object.assign(new Error('private diagnostic'), {code: 'ECONNREFUSED'});
    fetcher.mockRejectedValueOnce(cause);
    await expect(client.manifest(7)).rejects.toMatchObject({code: 'NETWORK_ERROR', cause});
  });

  it('requires HTTPS except for an explicit loopback development endpoint', () => {
    expect(() => new StorageAgentHttpClient('http://quorum.example.com', credential)).toThrow();
    expect(() => new StorageAgentHttpClient('https://user:secret@quorum.example.com', credential)).toThrow();
    expect(() => new StorageAgentHttpClient('http://localhost:3000', credential)).not.toThrow();
  });
});
