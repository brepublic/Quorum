import type {StorageAgentFileStatus, StorageAgentTask} from '@quorum/contracts';
import {StorageAgentHttpClient} from './client.js';
import type {StorageAgentLocalConfig} from './config.js';
import {AgentFileStore} from './files.js';
import {StorageAgentRuntime, type AgentActivity, type AgentRuntimeLogger} from './runtime.js';
import {AgentDirectoryScanner} from './scanner.js';
import {AgentStateStore} from './state.js';
import {desktopFiles} from './desktop-status.js';

export async function runDesktop(config: StorageAgentLocalConfig, state: AgentStateStore,
  parentSignal: AbortSignal, logger: AgentRuntimeLogger): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal.addEventListener('abort', abort, {once: true});
  if (parentSignal.aborted) abort();
  const signal = controller.signal;
  const client = new StorageAgentHttpClient(config.serverUrl, config.credential, fetch, signal);
  const files = new AgentFileStore(state);
  let remote: StorageAgentFileStatus[] = []; let tasks: StorageAgentTask[] = [];
  let verified = new Set<string>(); let fresh = false; let updatedAt = ''; let lastConnected = '';
  const activities = new Map<string, AgentActivity>();
  const emit = () => process.stdout.write(JSON.stringify({event: 'snapshot', connected: fresh, updatedAt,
    lastConnected, files: desktopFiles(remote, state.snapshot(), tasks, verified, activities, fresh)}) + '\n');
  let lastEmit = 0; let pollAgain = false;
  const runtime = new StorageAgentRuntime(client, config.leaseGeneration, state, files,
    new AgentDirectoryScanner(state, files), logger, {
      connected() {lastConnected = new Date().toISOString();},
      activity(value) {
        activities.set(value.fileEntryId, value);
        if (value.phase === 'complete' || value.phase === 'failed') pollAgain = true;
        if (Date.now() - lastEmit > 100 || value.phase !== 'transfer') {lastEmit = Date.now(); emit();}
      }
    });
  const poll = async () => {
    const terminal = [...activities].filter(([,a]) => a.phase === 'complete' || a.phase === 'failed');
    const deadline = new AbortController();
    const cancel = () => deadline.abort();
    signal.addEventListener('abort', cancel, {once: true});
    if (signal.aborted) cancel();
    const timer = setTimeout(cancel, 10000);
    const statusClient = new StorageAgentHttpClient(config.serverUrl, config.credential, fetch, deadline.signal);
    try {
      const next: StorageAgentFileStatus[] = []; let after = ''; const seen = new Set<string>();
      do {const page = await statusClient.fileStatus(config.leaseGeneration, after);
        next.push(...page.files); updatedAt = page.observedAt; after = page.nextId ?? '';
        if (after && seen.has(after)) throw new Error('Invalid file status cursor'); seen.add(after);
      } while (after && !signal.aborted);
      const nextTasks: StorageAgentTask[] = []; let sequence = 0;
      while (!signal.aborted) {const page = await statusClient.tasks(config.leaseGeneration, sequence);
        nextTasks.push(...page.tasks); if (!page.hasMore) break;
        if (page.nextSequence <= sequence) throw new Error('Invalid task cursor'); sequence = page.nextSequence;
      }
      const checked = new Set<string>();
      for (const [id, tracked] of Object.entries(state.snapshot().files)) {
        if (signal.aborted) break;
        try {const actual = await files.inspect(tracked.relativePath);
          if (actual.sizeBytes === tracked.sizeBytes && actual.sha256 === tracked.sha256) checked.add(id);
        } catch { /* Missing/changed files are not ready. */ }
      }
      remote = next; tasks = nextTasks; verified = checked; fresh = true; lastConnected = new Date().toISOString();
      for (const [id, a] of terminal) {if (activities.get(id) === a) activities.delete(id);}
    } catch {fresh = false;}
    finally {clearTimeout(timer); signal.removeEventListener('abort', cancel);}
    emit();
  };
  const monitor = (async () => {
    while (!signal.aborted) {
      pollAgain = false; await poll();
      for (let i=0; i<30 && !pollAgain && !signal.aborted; i++) await new Promise(resolve => setTimeout(resolve, 100));
    }
  })();
  try {await runtime.run(signal, {scanIntervalMs: config.scanIntervalMs});}
  finally {controller.abort(); await monitor; parentSignal.removeEventListener('abort', abort);}
}
