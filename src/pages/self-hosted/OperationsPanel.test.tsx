import * as React from 'react';
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';
import OperationsPanel from './OperationsPanel';

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { if (root) act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; });

describe('operations status panel', () => {
  it('shows capacity and fixed queue aggregates without operational paths', async () => {
    const api = {operationsStatus: vi.fn(async () => ({database: {schemaCompatibility: 26, serverTime: '2026-08-14T00:00:00Z'},
      storage: {state: 'warning' as const, usageRatio: 0.82, availableBytes: 100},
      accounts: {active: 2, disabled: 1, anonymized: 0}, committees: {active: 1, paused: 0, archived: 2, deleting: 0},
      queues: {blobDelete: 3, uploadStaging: 0, migration: 0, agentTasks: 2, committeeDeletion: 0},
      retention: {lastStatus: 'COMPLETED', lastCompletedAt: '2026-08-14T00:00:00Z'}}))};
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<OperationsPanel api={api as never} />); await Promise.resolve(); });
    expect(container.textContent).toContain('存储使用率 82%');
    expect(container.textContent).toContain('主席电脑任务');
    expect(container.textContent).not.toMatch(/storage_key|\/var\/lib|credential/i);
  });
});
