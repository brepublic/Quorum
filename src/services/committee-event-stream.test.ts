import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {selfHostedApi, type CommitteeEventStreamCallbacks} from './self-hosted-api';

let stop: (() => void) | undefined;
let streams: ReadableStreamDefaultController<Uint8Array>[];
let handlers: CommitteeEventStreamCallbacks;
const encode = (text: string) => new TextEncoder().encode(text);
const flush = async () => {for (let i = 0; i < 10; i++) await Promise.resolve();};
beforeEach(() => {
  vi.useFakeTimers(); streams = [];
  handlers = {onActivity: vi.fn(), onFailure: vi.fn(), onState: vi.fn(), onEvent: vi.fn(), onAccessDenied: vi.fn(), onResyncRequired: vi.fn(async () => 20)};
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => new Response(new ReadableStream({start(controller) {
    streams.push(controller);
    options.signal.addEventListener('abort', () => {try {controller.error(new DOMException('Aborted', 'AbortError'));} catch {}}, {once: true});
  }}), {headers: {'content-type': 'text/event-stream'}})));
});
afterEach(() => {stop?.(); stop = undefined; vi.useRealTimers(); vi.unstubAllGlobals();});
const open = async () => {stop = selfHostedApi.openCommitteeEvents('committee', 7, handlers); await flush();};

describe('committee connection health', () => {
  it('leaves live immediately on clean EOF and reconnects after one second', async () => {
    await open(); expect(handlers.onState).toHaveBeenLastCalledWith('LIVE');
    streams[0].close(); await flush();
    expect(handlers.onState).toHaveBeenLastCalledWith('RECONNECTING');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(2); expect(handlers.onState).toHaveBeenLastCalledWith('LIVE');
  });
  it('times out silent connections and accepts fragmented heartbeat frames', async () => {
    await open(); await vi.advanceTimersByTimeAsync(30_000);
    streams[0].enqueue(encode(': heartbeat 1\r')); streams[0].enqueue(encode('\n\r\n')); await flush();
    expect(handlers.onActivity).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(44_999); expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(handlers.onState).toHaveBeenLastCalledWith('RECONNECTING');
    expect(handlers.onFailure).toHaveBeenCalledWith(expect.objectContaining({code: 'REQUEST_TIMEOUT'}));
    await vi.advanceTimersByTimeAsync(1000); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([401, 403, 404])('stops retrying and reports access failure %s', async status => {
    vi.mocked(fetch).mockResolvedValue(new Response('', {status})); await open();
    expect(handlers.onAccessDenied).toHaveBeenCalledWith(expect.objectContaining({status}));
    await vi.advanceTimersByTimeAsync(60_000); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['committee.updated', 'unknown.event'])('resynchronizes a gap or unknown event then restores health (%s)', async type => {
    await open(); streams[0].enqueue(encode(`id: 9\nevent: ${type}\ndata: {"id":9}\n\n`)); await flush();
    expect(handlers.onResyncRequired).toHaveBeenCalledOnce();
    expect(handlers.onEvent).not.toHaveBeenCalled(); expect(handlers.onState).toHaveBeenLastCalledWith('LIVE');
  });
  it('refreshes an expired cursor before opening a replacement connection', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', {status: 410})); await open();
    expect(handlers.onResyncRequired).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('after=20&'), expect.anything());
  });
  it('rejects a successful HTML response instead of treating it as a live stream', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('<html></html>', {headers: {'content-type': 'text/html'}}));
    await open(); expect(handlers.onState).not.toHaveBeenCalledWith('LIVE');
    expect(handlers.onState).toHaveBeenLastCalledWith('RECONNECTING');
  });
  it('gives independent stream owners different IDs while reusing the ID for reconnects', async () => {
    await open(); const first = new URL(String(vi.mocked(fetch).mock.calls[0][0]), 'https://local.test').searchParams.get('clientId');
    streams[0].close(); await vi.advanceTimersByTimeAsync(1000);
    const retried = new URL(String(vi.mocked(fetch).mock.calls[1][0]), 'https://local.test').searchParams.get('clientId');
    expect(retried).toBe(first); stop!(); await open();
    const other = new URL(String(vi.mocked(fetch).mock.calls[2][0]), 'https://local.test').searchParams.get('clientId');
    expect(other).not.toBe(first);
  });
  it('does not reconnect or publish state after disposal', async () => {
    await open(); stop!(); const calls = vi.mocked(handlers.onState).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(1); expect(handlers.onState).toHaveBeenCalledTimes(calls);
  });
});
