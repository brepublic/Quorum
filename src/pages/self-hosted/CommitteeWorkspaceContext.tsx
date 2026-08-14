import * as React from 'react';
import type {CommitteeWorkspaceSnapshot} from '@quorum/contracts';
import {t} from '../../i18n';
import {SelfHostedApiError, type SelfHostedApi} from '../../services/self-hosted-api';
import type {RealtimeStatus} from './WorkspaceNavigation';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface CommitteeWorkspaceValue {
  snapshot?: CommitteeWorkspaceSnapshot;
  error?: string;
  realtimeStatus: RealtimeStatus;
  working: boolean;
  refresh(): Promise<CommitteeWorkspaceSnapshot | undefined>;
  run(operation: () => Promise<unknown>): Promise<void>;
}

const CommitteeWorkspaceContext = React.createContext<CommitteeWorkspaceValue | undefined>(undefined);

export function CommitteeWorkspaceProvider({committeeId, api, children}: React.PropsWithChildren<{
  committeeId: string; api: SelfHostedApi;
}>) {
  const [snapshot, setSnapshot] = React.useState<CommitteeWorkspaceSnapshot>();
  const [streamAfter, setStreamAfter] = React.useState<number>();
  const [realtimeStatus, setRealtimeStatus] = React.useState<RealtimeStatus>('CONNECTING');
  const [error, setError] = React.useState<string>();
  const [working, setWorking] = React.useState(false);

  const refresh = React.useCallback(async () => {
    try {
      const next = await api.snapshot(committeeId);
      setSnapshot(next);
      setStreamAfter(current => current ?? next.sync.committeeEventSequence);
      setError(undefined);
      return next;
    } catch (caught) {
      setError(errorText(caught));
      return undefined;
    }
  }, [api, committeeId]);

  React.useEffect(() => {
    void refresh();
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [refresh]);

  React.useEffect(() => {
    if (streamAfter === undefined) return;
    return api.openCommitteeEvents(committeeId, streamAfter, {
      onEvent: event => { if (event.type !== 'sync.cursor_advanced') void refresh(); },
      onState: setRealtimeStatus,
      onResyncRequired: async () => (await refresh())?.sync.committeeEventSequence ?? streamAfter
    });
  }, [api, committeeId, refresh, streamAfter]);

  const run = React.useCallback(async (operation: () => Promise<unknown>) => {
    setWorking(true); setError(undefined);
    try {
      await operation();
      await refresh();
    } catch (caught) {
      if (caught instanceof SelfHostedApiError && caught.code === 'REVISION_CONFLICT') {
        await refresh();
        setError(t('Committee data changed. Review the latest state and try again.'));
      } else {
        await refresh();
        setError(errorText(caught));
      }
    } finally {
      setWorking(false);
    }
  }, [refresh]);

  const value = React.useMemo<CommitteeWorkspaceValue>(() => ({snapshot, error, realtimeStatus, working, refresh, run}),
    [snapshot, error, realtimeStatus, working, refresh, run]);
  return <CommitteeWorkspaceContext.Provider value={value}>{children}</CommitteeWorkspaceContext.Provider>;
}

export function useCommitteeWorkspace() {
  const value = React.useContext(CommitteeWorkspaceContext);
  if (!value) throw new Error('Committee workspace context is unavailable.');
  return value;
}
