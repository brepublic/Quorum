import * as React from 'react';
import type {CommitteeWorkspaceSnapshot, RealtimeSyncState} from '@quorum/contracts';
import {useHistory, useLocation} from 'react-router-dom';
import {apiErrorText, t, useLanguage} from '../../i18n';
import {SelfHostedApiError, type SelfHostedApi} from '../../services/self-hosted-api';

interface CommitteeWorkspaceValue {
  snapshot?: CommitteeWorkspaceSnapshot;
  snapshotReceivedAt: number;
  lastSyncedAt?: number;
  error?: string;
  failure?: unknown;
  accessFailure?: SelfHostedApiError;
  realtimeStatus: RealtimeSyncState;
  syncFailed: boolean;
  networkOffline: boolean;
  working: boolean;
  writesBlocked: boolean;
  canWrite(): boolean;
  refresh(): Promise<CommitteeWorkspaceSnapshot | undefined>;
  retry(): void;
  run(operation: () => Promise<unknown>): Promise<void>;
}

const CommitteeWorkspaceContext = React.createContext<CommitteeWorkspaceValue | undefined>(undefined);

export function CommitteeWorkspaceProvider({committeeId, api, children}: React.PropsWithChildren<{
  committeeId: string; api: SelfHostedApi;
}>) {
  useLanguage();
  const history = useHistory();
  const location = useLocation();
  const pathnameRef = React.useRef(location.pathname);
  pathnameRef.current = location.pathname;
  const [snapshot, setSnapshot] = React.useState<CommitteeWorkspaceSnapshot>();
  const [snapshotReceivedAt, setSnapshotReceivedAt] = React.useState(0);
  const [lastSyncedAt, setLastSyncedAt] = React.useState<number>();
  const [realtimeStatus, setRealtimeStatus] = React.useState<RealtimeSyncState>('CONNECTING');
  const [syncFailed, setSyncFailed] = React.useState(false);
  const [networkOffline, setNetworkOffline] = React.useState(navigator.onLine === false);
  const [failure, setError] = React.useState<unknown>();
  const [accessFailure, setAccessFailure] = React.useState<SelfHostedApiError>();
  const [working, setWorking] = React.useState(false);
  const allowed = React.useRef(false);
  const refreshRef = React.useRef<CommitteeWorkspaceValue['refresh']>(async () => undefined);
  const retryRef = React.useRef(() => {});
  const refresh = React.useCallback(() => refreshRef.current(), []);
  const retry = React.useCallback(() => retryRef.current(), []);
  const canWrite = React.useCallback(() => allowed.current, []);

  React.useEffect(() => {setError(undefined);}, [location.pathname]);
  React.useEffect(() => {
    let active = true; let terminal = false; let deniedStatus: number | undefined; let connected = false; let synchronized = false;
    let current: CommitteeWorkspaceSnapshot | undefined; let epoch = 0;
    let disconnect: (() => void) | undefined;
    let request: AbortController | undefined;
    let inFlight: Promise<CommitteeWorkspaceSnapshot | undefined> | undefined;
    let refreshAgain = false; let retryTimer: number | undefined;
    const state = (next: RealtimeSyncState) => {
      allowed.current = active && !terminal && next === 'LIVE';
      if (active) setRealtimeStatus(next);
    };
    const deny = (error: SelfHostedApiError) => {
      if (!active || terminal) return;
      terminal = true; deniedStatus = error.status; connected = false; allowed.current = false;
      window.clearTimeout(retryTimer); disconnect?.(); request?.abort();
      state('RECONNECTING'); setAccessFailure(error);
      if (error.status === 401) {
        // Router navigation honors the existing draft/leave guards.
        history.replace('/login', {reauthenticate: true, returnTo: history.location.pathname + history.location.search + history.location.hash});
      }
    };
    const startStream = () => {
      if (!active || terminal || !current || disconnect || navigator.onLine === false) return;
      disconnect = api.openCommitteeEvents(committeeId, current.sync.committeeEventSequence, {
        onEvent: event => {if (active && !terminal && event.type !== 'sync.cursor_advanced') void read();},
        onState: next => {
          if (!active || terminal) return;
          if (next === 'LIVE') {
            if (!connected) {
              connected = true; synchronized = false; state('RESYNCING'); void read();
            } else if (synchronized) state('LIVE');
          } else if (next === 'RESYNCING') {
            synchronized = false; state('RESYNCING');
          } else {
            connected = false; synchronized = false; epoch++; state('RECONNECTING');
          }
        },
        onResyncRequired: async () => {
          const next = await read();
          if (!next) throw new Error('Snapshot unavailable');
          return next.sync.committeeEventSequence;
        },
        onAccessDenied: deny
      });
    };
    const read = (): Promise<CommitteeWorkspaceSnapshot | undefined> => {
      if (!active || terminal) return Promise.resolve(undefined);
      if (inFlight) {refreshAgain = true; return inFlight;}
      window.clearTimeout(retryTimer);
      inFlight = (async () => {
        let result: CommitteeWorkspaceSnapshot | undefined;
        do {
          refreshAgain = false;
          const readEpoch = epoch;
          request = new AbortController();
          const timeout = window.setTimeout(() => request?.abort(), 20_000);
          try {
            const next = await api.snapshot(committeeId, request.signal);
            if (!active || terminal) return undefined;
            current = next; result = next;
            setSnapshot(next); setSnapshotReceivedAt(performance.now()); setLastSyncedAt(Date.now());
            setSyncFailed(false); setError(undefined);
            if (connected && epoch === readEpoch) {synchronized = true; state('LIVE');}
          } catch (error) {
            if (!active || terminal) return undefined;
            synchronized = false; result = undefined;
            if (error instanceof SelfHostedApiError && [401, 403, 404].includes(error.status)) {deny(error); return undefined;}
            setSyncFailed(true);
            if (!current) setError(error);
            state(connected ? 'RESYNCING' : current ? 'RECONNECTING' : 'CONNECTING');
            retryTimer = window.setTimeout(() => void read(), 1_000);
            break;
          } finally {window.clearTimeout(timeout);}
        } while (refreshAgain && active && !terminal);
        return result;
      })().finally(() => {
        inFlight = undefined;
        startStream();
      });
      return inFlight;
    };
    const reconnect = () => {
      if (!active) return;
      if (terminal) {
        if (deniedStatus === 401 && history.location.pathname !== '/login') history.replace('/login', {reauthenticate: true,
          returnTo: history.location.pathname + history.location.search + history.location.hash});
        return;
      }
      epoch++; connected = false; synchronized = false;
      disconnect?.(); disconnect = undefined;
      setNetworkOffline(navigator.onLine === false);
      state(current ? 'RECONNECTING' : 'CONNECTING');
      if (navigator.onLine !== false) {startStream(); void read();}
    };
    const refocus = () => {if (!terminal) reconnect();};
    const visible = () => {if (document.visibilityState === 'visible') refocus();};
    refreshRef.current = read; retryRef.current = reconnect;
    state('CONNECTING'); void read();
    window.addEventListener('focus', refocus);
    window.addEventListener('online', reconnect);
    window.addEventListener('offline', reconnect);
    document.addEventListener('visibilitychange', visible);
    return () => {
      active = false; allowed.current = false; request?.abort(); disconnect?.(); window.clearTimeout(retryTimer);
      window.removeEventListener('focus', refocus);
      window.removeEventListener('online', reconnect);
      window.removeEventListener('offline', reconnect);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [api, committeeId, history]);

  const run = React.useCallback(async (operation: () => Promise<unknown>) => {
    if (!allowed.current) return;
    const operationPathname = pathnameRef.current;
    setWorking(true); setError(undefined);
    try {await operation(); await refresh();}
    catch (caught) {
      await refresh();
      if (pathnameRef.current === operationPathname) setError(caught);
    } finally {setWorking(false);}
  }, [refresh]);
  const value: CommitteeWorkspaceValue = {snapshot, snapshotReceivedAt, lastSyncedAt,
    error: failure ? t(apiErrorText(failure)) : undefined, failure, accessFailure, realtimeStatus, syncFailed,
    networkOffline, working, writesBlocked: realtimeStatus !== 'LIVE' || !!accessFailure, canWrite, refresh, retry, run};
  return <CommitteeWorkspaceContext.Provider value={value}>{children}</CommitteeWorkspaceContext.Provider>;
}

export function useCommitteeWorkspace() {
  const value = React.useContext(CommitteeWorkspaceContext);
  if (!value) throw new Error('Committee workspace context is unavailable.');
  return value;
}
