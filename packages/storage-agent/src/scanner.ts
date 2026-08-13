import {basename, join, relative, sep} from 'node:path';
import {lstat, readdir} from 'node:fs/promises';
import type {StorageAgentLocalChange, StorageAgentLocalChangeResult} from '@quorum/contracts';
import {AgentFileSystemError} from './errors.js';
import {AgentFileStore} from './files.js';
import {normalizeAgentRelativePath} from './paths.js';
import {AGENT_METADATA_FILE, AGENT_TEMP_DIRECTORY, type AgentDirectoryState,
  type AgentStateStore, type TrackedAgentFile} from './state.js';

export interface DetectedLocalChange {
  relativePath: string;
  change: StorageAgentLocalChange;
}

interface ScannedFile {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  modifiedTimeMs: number;
}

function toRelative(root: string, path: string): string {
  return normalizeAgentRelativePath(relative(root, path).split(sep).join('/'));
}

async function scanDirectory(root: string, directory: string, files: AgentFileStore,
  result: Map<string, ScannedFile>): Promise<void> {
  const entries = await readdir(directory, {withFileTypes: true});
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (directory === root && [AGENT_METADATA_FILE, AGENT_TEMP_DIRECTORY].includes(entry.name)) continue;
    const path = join(directory, entry.name); const relativePath = toRelative(root, path);
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile()) || (stats.isFile() && stats.nlink !== 1)) {
      throw new AgentFileSystemError('UNSAFE_LOCAL_PATH', 'Agent storage contains an unsafe filesystem entry.');
    }
    if (stats.isDirectory()) await scanDirectory(root, path, files, result);
    else result.set(relativePath, {relativePath, ...await files.inspect(relativePath)});
  }
}

function trackedByPath(state: AgentDirectoryState): Map<string, TrackedAgentFile> {
  return new Map(Object.values(state.files).map(file => [file.relativePath, file]));
}

export class AgentDirectoryScanner {
  constructor(private readonly state: AgentStateStore, private readonly files: AgentFileStore) {}

  async detectOne(): Promise<DetectedLocalChange | null> {
    const snapshot = this.state.snapshot(); const scanned = new Map<string, ScannedFile>();
    await scanDirectory(this.state.rootPath, this.state.rootPath, this.files, scanned);
    const paths = trackedByPath(snapshot);
    const pendingPaths = new Set(Object.values(snapshot.pendingUploads).map(item => item.relativePath));
    for (const item of Object.values(snapshot.conflicts)) pendingPaths.add(item.relativePath);
    const missing = Object.values(snapshot.files).filter(file => !scanned.has(file.relativePath))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const untracked = [...scanned.values()].filter(file => !paths.has(file.relativePath) && !pendingPaths.has(file.relativePath))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    for (const tracked of missing) {
      const renamed = untracked.find(file => file.sizeBytes === tracked.sizeBytes && file.sha256 === tracked.sha256);
      if (renamed) return {relativePath: renamed.relativePath, change: {kind: 'RENAME',
        fileEntryId: tracked.fileEntryId, baseRevision: tracked.revision, logicalName: renamed.relativePath}};
    }
    const deleted = missing[0];
    if (deleted) return {relativePath: deleted.relativePath,
      change: {kind: 'DELETE', fileEntryId: deleted.fileEntryId, baseRevision: deleted.revision}};
    for (const tracked of Object.values(snapshot.files).sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath))) {
      const actual = scanned.get(tracked.relativePath);
      if (!actual || pendingPaths.has(tracked.relativePath)) continue;
      if (actual.sizeBytes !== tracked.sizeBytes || actual.sha256 !== tracked.sha256) {
        return {relativePath: actual.relativePath, change: {kind: 'UPSERT', fileEntryId: tracked.fileEntryId,
          baseRevision: tracked.revision, logicalName: actual.relativePath, originalName: basename(actual.relativePath),
          mediaType: 'application/octet-stream', sizeBytes: actual.sizeBytes, sha256: actual.sha256}};
      }
    }
    const created = untracked[0];
    if (created) return {relativePath: created.relativePath, change: {kind: 'UPSERT',
      logicalName: created.relativePath, originalName: basename(created.relativePath),
      mediaType: 'application/octet-stream', sizeBytes: created.sizeBytes, sha256: created.sha256}};
    return null;
  }

  async recordResult(detected: DetectedLocalChange, requestId: string, manifestSequence: number,
    result: StorageAgentLocalChangeResult): Promise<void> {
    if (result.status === 'CONFLICT') {
      await this.state.update(state => { state.conflicts[result.conflictId] = {
        conflictId: result.conflictId, relativePath: detected.relativePath, change: detected.change}; });
      return;
    }
    if (result.status === 'PENDING_CONTENT') {
      if (detected.change.kind !== 'UPSERT' || result.task.expectedSizeBytes === null || !result.task.expectedSha256) {
        throw new AgentFileSystemError('LOCAL_CONTENT_INVALID', 'Agent upload task does not match its local change.');
      }
      const change = detected.change;
      await this.state.update(state => {
        state.pendingUploads[result.task.id] = {taskId: result.task.id, requestId, manifestSequence,
          change, relativePath: detected.relativePath, fileEntryId: result.task.fileEntryId,
          fileRevision: result.task.fileRevision, sizeBytes: result.task.expectedSizeBytes as number,
          sha256: result.task.expectedSha256 as string};
      });
      return;
    }
    if (detected.change.kind === 'DELETE') {
      const fileEntryId = detected.change.fileEntryId;
      await this.state.update(state => { delete state.files[fileEntryId]; });
      return;
    }
    if (detected.change.kind === 'RENAME') {
      const fileEntryId = detected.change.fileEntryId;
      const inspected = await this.files.inspect(detected.relativePath);
      await this.state.update(state => {
        const tracked = state.files[fileEntryId];
        if (!tracked) return;
        tracked.relativePath = detected.relativePath; tracked.revision = result.fileRevision;
        tracked.sizeBytes = inspected.sizeBytes; tracked.sha256 = inspected.sha256;
        tracked.modifiedTimeMs = inspected.modifiedTimeMs;
      });
    }
  }

  async completePending(taskId: string, fileEntryId: string, fileRevision: number, blobId: string): Promise<void> {
    const pending = this.state.snapshot().pendingUploads[taskId];
    if (!pending) throw new AgentFileSystemError('LOCAL_CONTENT_CONFLICT', 'Pending local upload is unavailable.');
    const inspected = await this.files.inspect(pending.relativePath);
    if (inspected.sizeBytes !== pending.sizeBytes || inspected.sha256 !== pending.sha256) {
      throw new AgentFileSystemError('LOCAL_CONTENT_CONFLICT', 'Pending local upload changed before completion.');
    }
    await this.state.update(state => {
      state.files[fileEntryId] = {fileEntryId, relativePath: pending.relativePath, revision: fileRevision,
        blobId, sizeBytes: inspected.sizeBytes, sha256: inspected.sha256, modifiedTimeMs: inspected.modifiedTimeMs};
      delete state.pendingUploads[taskId];
    });
  }

  async moveConflict(conflictId: string, logicalName: string): Promise<void> {
    const pending = this.state.snapshot().conflicts[conflictId];
    if (!pending) return;
    const expected = pending.change.kind === 'UPSERT'
      ? {sizeBytes: pending.change.sizeBytes, sha256: pending.change.sha256}
      : pending.change.kind === 'RENAME' ? this.state.snapshot().files[pending.change.fileEntryId] : undefined;
    if (!expected) throw new AgentFileSystemError('LOCAL_CONTENT_CONFLICT', 'Conflict content is unavailable.');
    if (pending.relativePath !== logicalName) await this.files.moveConflict(pending.relativePath, logicalName, expected);
    await this.state.update(state => { const current = state.conflicts[conflictId];
      if (current) current.relativePath = logicalName; });
  }

  async completeConflict(conflictId: string): Promise<void> {
    await this.state.update(state => { delete state.conflicts[conflictId]; });
  }
}
