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
});
