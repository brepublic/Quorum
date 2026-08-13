import {randomUUID} from 'node:crypto';
import {watch, type FSWatcher} from 'node:fs';
import type {StorageAgentTask, StorageManifestEvent} from '@quorum/contracts';
import {StorageAgentHttpClient} from './client.js';
import {AgentApiError, AgentFileSystemError} from './errors.js';
import {AgentFileStore} from './files.js';
import {secureAgentTarget} from './paths.js';
import {AgentDirectoryScanner, type DetectedLocalChange} from './scanner.js';
import type {AgentStateStore} from './state.js';

function latest(events: StorageManifestEvent[]): Map<string, StorageManifestEvent> {
  const result = new Map<string, StorageManifestEvent>();
  for (const event of events) {
    const current = result.get(event.fileEntryId);
    if (!current || event.sequence > current.sequence) result.set(event.fileEntryId, event);
  }
  return result;
}

function due(task: StorageAgentTask, now = Date.now()): boolean {
  return task.status === 'PENDING' || task.status === 'IN_PROGRESS'
    || (task.status === 'RETRY' && Date.parse(task.nextAttemptAt) <= now);
}

function safeReason(error: unknown): string {
  if (error instanceof AgentFileSystemError || error instanceof AgentApiError) return error.code;
  return 'AGENT_OPERATION_FAILED';
}

export interface AgentRuntimeLogger {
  info(event: string, fields?: Record<string, string | number | boolean>): void;
  error(event: string, fields?: Record<string, string | number | boolean>): void;
}

const quietLogger: AgentRuntimeLogger = {info: () => undefined, error: () => undefined};

export class StorageAgentRuntime {
  private manifest = new Map<string, StorageManifestEvent>();
  private watcher?: FSWatcher;
  private wake?: () => void;

  constructor(private readonly client: StorageAgentHttpClient, private readonly leaseGeneration: number,
    private readonly state: AgentStateStore, private readonly files: AgentFileStore,
    private readonly scanner: AgentDirectoryScanner, private readonly logger: AgentRuntimeLogger = quietLogger) {}

  async synchronizeOnce(): Promise<void> {
    await this.client.heartbeat(this.leaseGeneration);
    const events = await this.loadManifest(); this.manifest = latest(events);
    const tombstones = [...this.manifest.values()].filter((event): event is Extract<StorageManifestEvent,
      {kind: 'DELETE'}> => event.kind === 'DELETE').sort((left, right) => left.sequence - right.sequence);
    for (const tombstone of tombstones) {
      try { await this.files.applyDelete(tombstone); }
      catch (error) {
        if (!(error instanceof AgentFileSystemError) || error.code !== 'LOCAL_CONTENT_CONFLICT') throw error;
      }
    }
    const tasks = await this.loadTasks();
    tasks.sort((left, right) => {
      const order = {DELETE_FILE: 0, STORE_BLOB: 1, UPLOAD_BLOB: 2};
      return order[left.type] - order[right.type] || left.sequence - right.sequence;
    });
    for (const task of tasks.filter(item => due(item))) await this.processTask(task);
    for (const task of tasks.filter(item => item.type === 'UPLOAD_BLOB' && item.status === 'COMPLETED'
      && Boolean(this.state.snapshot().pendingUploads[item.id]))) await this.recoverCompletedUpload(task);
    await this.reportOneLocalChange();
  }

  async run(signal: AbortSignal, options: {scanIntervalMs?: number; retryMaximumMs?: number} = {}): Promise<void> {
    const interval = options.scanIntervalMs ?? 30_000; const maximum = options.retryMaximumMs ?? 60_000;
    await this.files.cleanupTemporaryFiles(); this.startWatcher(); let delay = 1_000;
    try {
      while (!signal.aborted) {
        try {
          await this.synchronizeOnce(); delay = 1_000;
          await this.wait(interval, signal);
        } catch (error) {
          this.logger.error('storage_agent.cycle_failed', {code: safeReason(error)});
          if (error instanceof AgentApiError && error.code === 'STALE_STORAGE_LEASE') throw error;
          await this.wait(delay, signal); delay = Math.min(maximum, delay * 2);
        }
      }
    } finally { this.watcher?.close(); this.watcher = undefined; }
  }

  private async loadManifest(): Promise<StorageManifestEvent[]> {
    const events: StorageManifestEvent[] = []; let after = 0;
    while (true) {
      const page = await this.client.manifest(this.leaseGeneration, after, 100);
      if (page.events.some(event => !['UPSERT', 'DELETE'].includes(event.kind))
        || (page.hasMore && page.nextSequence <= after)) {
        throw new AgentApiError(502, 'UNKNOWN_PROTOCOL_STATE', 'Storage manifest response is invalid.');
      }
      events.push(...page.events); after = page.nextSequence;
      if (!page.hasMore) return events;
    }
  }

  private async loadTasks(): Promise<StorageAgentTask[]> {
    const tasks: StorageAgentTask[] = []; let after = 0;
    while (true) {
      const page = await this.client.tasks(this.leaseGeneration, after, 100);
      if (page.tasks.some(task => !['STORE_BLOB', 'UPLOAD_BLOB', 'DELETE_FILE'].includes(task.type)
        || !['PENDING', 'IN_PROGRESS', 'RETRY', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status))
        || (page.hasMore && page.nextSequence <= after)) {
        throw new AgentApiError(502, 'UNKNOWN_PROTOCOL_STATE', 'Storage task response is invalid.');
      }
      tasks.push(...page.tasks); after = page.nextSequence;
      if (!page.hasMore) return tasks;
    }
  }

  private async processTask(task: StorageAgentTask): Promise<void> {
    let claimed: StorageAgentTask;
    try { claimed = task.status === 'IN_PROGRESS' && task.claimToken ? task : await this.client.claim(task, randomUUID()); }
    catch (error) {
      if (error instanceof AgentApiError && error.code === 'RESOURCE_CONFLICT') return;
      throw error;
    }
    if (!claimed.claimToken) throw new Error('Claimed task has no token.');
    const token = claimed.claimToken;
    try {
      if (claimed.type === 'DELETE_FILE') {
        const event = this.manifest.get(claimed.fileEntryId);
        if (!event || event.kind !== 'DELETE' || event.fileRevision !== claimed.fileRevision) {
          throw new AgentFileSystemError('LOCAL_CONTENT_INVALID', 'Delete task does not match the latest manifest.');
        }
        await this.files.applyDelete(event);
      } else if (claimed.type === 'STORE_BLOB') {
        const event = this.manifest.get(claimed.fileEntryId);
        if (!event || event.kind !== 'UPSERT' || event.fileRevision !== claimed.fileRevision
          || event.blobId !== claimed.blobId) {
          throw new AgentFileSystemError('LOCAL_CONTENT_INVALID', 'Store task does not match the latest manifest.');
        }
        await this.files.applyUpsert(event, await this.client.download(claimed, token));
      } else {
        const pending = this.state.snapshot().pendingUploads[claimed.id];
        if (!pending || pending.fileRevision !== claimed.fileRevision || pending.sha256 !== claimed.expectedSha256) {
          throw new AgentFileSystemError('LOCAL_CONTENT_CONFLICT', 'Local upload task has no matching local content.');
        }
        const target = await secureAgentTarget(this.state.rootPath, pending.relativePath);
        const inspected = await this.files.inspect(pending.relativePath);
        if (inspected.sizeBytes !== pending.sizeBytes || inspected.sha256 !== pending.sha256) {
          throw new AgentFileSystemError('LOCAL_CONTENT_CONFLICT', 'Local upload changed after it was queued.');
        }
        await this.client.upload(claimed, token, target.absolutePath);
      }
      await this.client.complete(claimed, token, randomUUID());
      if (claimed.type === 'UPLOAD_BLOB') await this.recoverCompletedUpload(claimed);
    } catch (error) {
      const code = safeReason(error);
      if (error instanceof AgentFileSystemError && error.code === 'LOCAL_CONTENT_CONFLICT') {
        await this.reportOneLocalChange();
      }
      await this.client.fail(claimed, token, randomUUID(), code).catch(() => undefined);
      throw error;
    }
  }

  private async recoverCompletedUpload(task: StorageAgentTask): Promise<void> {
    const pending = this.state.snapshot().pendingUploads[task.id];
    if (!pending || !task.blobId) return;
    const replay = await this.client.localChange(this.leaseGeneration, pending.requestId,
      pending.manifestSequence, pending.change);
    if (replay.status !== 'COMPLETED') {
      throw new AgentFileSystemError('LOCAL_CONTENT_INVALID', 'Completed upload did not finalize its local change.');
    }
    await this.scanner.completePending(task.id, replay.fileEntryId, replay.fileRevision, task.blobId);
  }

  private async reportOneLocalChange(): Promise<void> {
    const detected: DetectedLocalChange | null = await this.scanner.detectOne();
    if (!detected) return;
    const requestId = randomUUID(); const manifestSequence = Math.max(0,
      ...[...this.manifest.values()].map(event => event.sequence));
    const result = await this.client.localChange(this.leaseGeneration, requestId, manifestSequence, detected.change);
    await this.scanner.recordResult(detected, requestId, manifestSequence, result);
  }

  private startWatcher(): void {
    const changed = () => {
      this.logger.info('storage_agent.filesystem_changed');
      this.wake?.();
    };
    try {
      this.watcher = watch(this.state.rootPath, {recursive: true}, changed);
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined; });
    } catch {
      try {
        this.watcher = watch(this.state.rootPath, changed);
        this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined; });
      } catch { this.watcher = undefined; }
    }
  }

  private wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(done, milliseconds); this.wake = done;
      const runtime = this;
      function done() { clearTimeout(timer); signal.removeEventListener('abort', done);
        if (runtime.wake === done) runtime.wake = undefined; resolve(); }
      signal.addEventListener('abort', done, {once: true});
    });
  }
}
