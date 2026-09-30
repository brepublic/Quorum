import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {Link, MemoryRouter, useLocation} from 'react-router-dom';
import {afterEach, expect, it, vi} from 'vitest';
import type {AuthoritativeTimer, CommitteeWorkspaceSnapshot, TimerOwnerType} from '@quorum/contracts';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import {CommitteeWorkspaceProvider, useCommitteeWorkspace} from './CommitteeWorkspaceContext';
import {TimerControls} from './ProceedingsPanel';

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined; let host: HTMLDivElement | undefined;
afterEach(() => {act(() => root?.unmount()); root = undefined; host?.remove(); vi.useRealTimers();});

function TimerPage({api}: {api: SelfHostedApi}) {
  const {snapshot, run} = useCommitteeWorkspace(); const location = useLocation();
  return <><Link to="/timer">Timer</Link><Link to="/away">Away</Link>
    {snapshot && location.pathname === '/timer' && <TimerControls name="Timer" timer={snapshot.timers![0]}
      run={run} api={api} canChair />}</>;
}

it.each<TimerOwnerType>(['COMMITTEE', 'SPEAKER_LIST', 'CAUCUS', 'SPEECH', 'CRISIS'])(
  '%s counts while away, reloads from server state, and survives closing and revisiting', async ownerType => {
    vi.useFakeTimers({toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']});
    const startedAt = Date.now(); const commandTimer = vi.fn(); const disconnect = vi.fn();
    const openCommitteeEvents = vi.fn(() => disconnect);
    const api = {commandTimer, openCommitteeEvents, snapshot: vi.fn(async () => {
      const timer: AuthoritativeTimer = {id: 'timer', committeeId: 'committee', ownerType, ownerId: 'owner',
        running: Date.now() - startedAt < 120_000, startedAt: new Date(startedAt).toISOString(),
        remainingAtStartMs: 120_000, remainingMs: Math.max(0, 120_000 - (Date.now() - startedAt)),
        revision: 2, expiredAt: null, serverTime: new Date().toISOString()};
      return {timers: [timer], sync: {committeeEventSequence: 1}} as CommitteeWorkspaceSnapshot;
    })} as unknown as SelfHostedApi;
    const mount = async () => {
      host ??= document.createElement('div'); document.body.append(host); root = createRoot(host);
      await act(async () => {root!.render(<MemoryRouter initialEntries={['/timer']}>
        <CommitteeWorkspaceProvider committeeId="committee" api={api}><TimerPage api={api} /></CommitteeWorkspaceProvider>
      </MemoryRouter>);});
    };
    const unmount = () => {act(() => root!.unmount()); root = undefined;};
    const advance = async (milliseconds: number) => {await act(async () => {await vi.advanceTimersByTimeAsync(milliseconds);});};
    const navigate = async (path: string) => {await act(async () => {host!.querySelector<HTMLAnchorElement>(`a[href="/${path}"]`)!.click();});};
    const time = () => host!.querySelector('time')?.textContent;
    await mount(); expect(time()).toBe('2:00');
    await advance(10_000); expect(time()).toBe('1:50');
    await navigate('away'); await advance(20_000); await navigate('timer'); expect(time()).toBe('1:30');
    // A reload discards all page state and obtains a fresh server snapshot.
    unmount(); await advance(10_000); await mount(); expect(time()).toBe('1:20');
    // No page or event connection remains during the closed-browser interval.
    unmount(); await advance(30_000); await mount(); expect(time()).toBe('0:50');
    unmount(); await advance(60_000); await mount(); expect(time()).toBe('0:00');
    expect(api.snapshot).toHaveBeenCalledTimes(4);
    expect(commandTimer).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(3);
  });
