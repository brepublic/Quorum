import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {Router, Prompt} from 'react-router-dom';
import {createMemoryHistory} from 'history';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {CommitteeWorkspaceSnapshot} from '@quorum/contracts';
import {SelfHostedApiError, type CommitteeEventStreamCallbacks, type SelfHostedApi} from '../../services/self-hosted-api';
import {CommitteeWorkspaceProvider, useCommitteeWorkspace} from './CommitteeWorkspaceContext';

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement; let handlers: CommitteeEventStreamCallbacks;
let value: ReturnType<typeof useCommitteeWorkspace>;
let read: ReturnType<typeof vi.fn>; let disconnect: ReturnType<typeof vi.fn>;
let history: ReturnType<typeof createMemoryHistory>;
const snapshot = {sync: {committeeEventSequence: 7}} as CommitteeWorkspaceSnapshot;
function Probe({dirty}: {dirty: boolean}) {value = useCommitteeWorkspace(); return <><Prompt when={dirty} message="Discard draft?" /><input defaultValue="draft" /></>;}
async function mount(dirty = false) {
  const api = {snapshot: read, openCommitteeEvents: vi.fn((_id, _after, callbacks) => {handlers = callbacks; return disconnect;})} as unknown as SelfHostedApi;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Router history={history}><CommitteeWorkspaceProvider committeeId="one" api={api}>
    <Probe dirty={dirty} /></CommitteeWorkspaceProvider></Router>));
}
beforeEach(() => {vi.useFakeTimers(); read = vi.fn(async () => snapshot); disconnect = vi.fn();
  history = createMemoryHistory({initialEntries: ['/committees/one/settings'], getUserConfirmation: (_message, callback) => callback(false)});
});
afterEach(() => {act(() => root?.unmount()); host?.remove(); vi.useRealTimers(); vi.restoreAllMocks();});

describe('committee synchronization', () => {
  it('requires a fresh snapshot after connecting, blocks writes and preserves drafts until it succeeds', async () => {
    await mount(); expect(value.realtimeStatus).toBe('CONNECTING');
    let complete!: (next: CommitteeWorkspaceSnapshot) => void;
    read.mockImplementationOnce(() => new Promise(resolve => {complete = resolve;}));
    await act(async () => handlers.onState('LIVE'));
    expect(value.realtimeStatus).toBe('RESYNCING'); expect(value.writesBlocked).toBe(true);
    const operation = vi.fn(); await act(async () => value.run(operation)); expect(operation).not.toHaveBeenCalled();
    await act(async () => complete(snapshot)); expect(value.realtimeStatus).toBe('LIVE');
    expect(value.lastSyncedAt).toBeDefined(); await act(async () => value.run(operation)); expect(operation).toHaveBeenCalledOnce();
    act(() => handlers.onState('RECONNECTING')); expect(value.writesBlocked).toBe(true);
    expect(host.querySelector('input')?.value).toBe('draft');
  });
  it('leaves green when data refresh fails and returns to live after retry', async () => {
    await mount(); await act(async () => handlers.onState('LIVE'));
    read.mockRejectedValueOnce(new Error('network'));
    await act(async () => {await value.refresh();});
    expect(value.realtimeStatus).toBe('RESYNCING'); expect(value.syncFailed).toBe(true);
    await act(async () => {await vi.advanceTimersByTimeAsync(1000);});
    expect(value.realtimeStatus).toBe('LIVE'); expect(value.syncFailed).toBe(false);
  });
  it('does not turn green from an old refresh after the stream disconnects', async () => {
    await mount(); await act(async () => handlers.onState('LIVE'));
    let complete!: (next: CommitteeWorkspaceSnapshot) => void;
    read.mockImplementationOnce(() => new Promise(resolve => {complete = resolve;}));
    act(() => {void value.refresh(); handlers.onState('RECONNECTING');});
    await act(async () => complete(snapshot)); expect(value.realtimeStatus).toBe('RECONNECTING');
  });
  it('refreshes on focus without disconnecting and reconnects on network recovery', async () => {
    await mount(); await act(async () => handlers.onState('LIVE'));
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(disconnect).not.toHaveBeenCalled(); expect(value.realtimeStatus).toBe('LIVE');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => window.dispatchEvent(new Event('offline'))); expect(value.networkOffline).toBe(true);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    await act(async () => window.dispatchEvent(new Event('online')));
    await act(async () => handlers.onState('LIVE')); expect(value.realtimeStatus).toBe('LIVE');
  });
  it('coalesces visible and focus notifications while preserving live edits', async () => {
    await mount(); await act(async () => handlers.onState('LIVE')); read.mockClear();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => {document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus'));});
    expect(read).toHaveBeenCalledTimes(1); expect(disconnect).not.toHaveBeenCalled();
    expect(value.writesBlocked).toBe(false);
  });
  it('reuses a pending focus refresh but follows up when a business event arrives', async () => {
    await mount(); await act(async () => handlers.onState('LIVE')); read.mockClear();
    let complete!: (next: CommitteeWorkspaceSnapshot) => void;
    read.mockImplementationOnce(() => new Promise(resolve => {complete = resolve;}));
    const receivedAt = value.snapshotReceivedAt;
    act(() => {window.dispatchEvent(new Event('focus'));});
    await act(async () => {await vi.advanceTimersByTimeAsync(200); window.dispatchEvent(new Event('focus'));});
    expect(read).toHaveBeenCalledTimes(1);
    act(() => handlers.onEvent({type: 'committee.updated'} as never));
    expect(value.snapshotReceivedAt).toBe(receivedAt);
    const updated = {...snapshot, sync: {committeeEventSequence: 8}};
    read.mockResolvedValueOnce(updated);
    await act(async () => complete(snapshot));
    expect(read).toHaveBeenCalledTimes(2); expect(value.snapshot).toBe(updated);
  });
  it('reconnects on return after sleep but keeps a stream with recent heartbeats', async () => {
    await mount(); await act(async () => handlers.onState('LIVE'));
    vi.setSystemTime(Date.now() + 60_000);
    act(() => handlers.onActivity?.());
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(disconnect).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 45_000);
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(disconnect).toHaveBeenCalledTimes(1); expect(value.writesBlocked).toBe(true);
  });
  it('retains a refresh failure reason and clears it after recovery', async () => {
    await mount(); await act(async () => handlers.onState('LIVE'));
    const error = new SelfHostedApiError(503, 'SERVICE_NOT_READY', '');
    read.mockRejectedValueOnce(error);
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(value.syncFailure).toBe(error); expect(value.writesBlocked).toBe(true);
    await act(async () => {await vi.advanceTimersByTimeAsync(1000);});
    expect(value.syncFailure).toBeUndefined(); expect(value.writesBlocked).toBe(false);
  });
  it('reports a snapshot timeout without losing the draft', async () => {
    await mount(); await act(async () => handlers.onState('LIVE'));
    read.mockImplementationOnce((_id, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    act(() => {window.dispatchEvent(new Event('focus'));});
    await act(async () => {await vi.advanceTimersByTimeAsync(20_000);});
    expect(value.syncFailure).toMatchObject({code: 'REQUEST_TIMEOUT'});
    expect(value.writesBlocked).toBe(true); expect(host.querySelector('input')?.value).toBe('draft');
  });
  it('automatically routes authentication failures to login with a return address', async () => {
    await mount(); act(() => handlers.onAccessDenied(new SelfHostedApiError(401, 'AUTHENTICATION_REQUIRED', '')));
    expect(history.location.pathname).toBe('/login');
    expect(history.location.state).toEqual({reauthenticate: true, returnTo: '/committees/one/settings'});
  });
  it('honors the existing leave protection before redirecting a dirty page', async () => {
    await mount(true); act(() => handlers.onAccessDenied(new SelfHostedApiError(401, 'AUTHENTICATION_REQUIRED', '')));
    expect(history.location.pathname).toBe('/committees/one/settings'); expect(host.querySelector('input')?.value).toBe('draft');
    expect(value.writesBlocked).toBe(true);
  });
  it.each([403, 404])('reports permanent access loss and stops the stream (%s)', async status => {
    await mount(); act(() => handlers.onAccessDenied(new SelfHostedApiError(status, 'NOT_FOUND', '')));
    expect(disconnect).toHaveBeenCalledOnce(); expect(value.accessFailure?.status).toBe(status);
    const before = read.mock.calls.length; await act(async () => {await vi.advanceTimersByTimeAsync(60_000);});
    expect(read).toHaveBeenCalledTimes(before);
  });
});
