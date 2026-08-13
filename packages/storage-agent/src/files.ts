import {createHash, randomUUID} from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import {lstat, open, readdir, rename, rm, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import type {StorageManifestEvent} from '@quorum/contracts';
import {AgentFileSystemError} from './errors.js';
import {secureAgentTarget} from './paths.js';
import {AGENT_TEMP_DIRECTORY, type AgentStateStore, type TrackedAgentFile} from './state.js';

async function hashRegularFile(path: string): Promise<{sizeBytes: number; sha256: string; modifiedTimeMs: number}> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new AgentFileSystemError('UNSAFE_LOCAL_PATH', 'Local content is not a private regular file.');
  }
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const hash = createHash('sha256'); let sizeBytes = 0;
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const {bytesRead} = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead)); sizeBytes += bytesRead;
    }
  } finally {
    await handle.close();
  }
  const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || before.dev !== after.dev
    || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new AgentFileSystemError('LOCAL_CONTENT_CONFLICT', 'Local content changed while it was being read.');
  }
  return {sizeBytes, sha256: hash.digest('hex'), modifiedTimeMs: after.mtimeMs};
}

async function missing(path: string): Promise<boolean> {
  try { await lstat(path); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

async function requireUnchanged(rootPath: string, tracked: TrackedAgentFile): Promise<void> {
  const target = await secureAgentTarget(rootPath, tracked.relativePath);
  if (await missing(target.absolutePath)) {
    throw new AgentFileSystemError('LOCAL_CONTENT_CONFLICT', 'Tracked local content is missing.');
  }
  const actual = await hashRegularFile(target.absolutePath);
  if (actual.sizeBytes !== tracked.sizeBytes || actual.sha256 !== tracked.sha256) {
    throw new AgentFileSystemError('LOCAL_CONTENT_CONFLICT', 'Tracked local content has local changes.');
  }
}

async function requireExpected(rootPath: string, relativePath: string,
  expected: {sizeBytes: number; sha256: string}): Promise<void> {
  const target = await secureAgentTarget(rootPath, relativePath);
  if (await missing(target.absolutePath)) {
    throw new AgentFileSystemError('LOCAL_CONTENT_CONFLICT', 'Conflict content is missing.');
  }
  const actual = await hashRegularFile(target.absolutePath);
  if (actual.sizeBytes !== expected.sizeBytes || actual.sha256 !== expected.sha256) {
    throw new AgentFileSystemError('LOCAL_CONTENT_CONFLICT', 'Conflict content changed after the decision.');
  }
}

async function writeVerified(path: string, source: AsyncIterable<Uint8Array | string>, expectedSize: number,
  expectedSha256: string): Promise<void> {
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY
    | fsConstants.O_NOFOLLOW, 0o600);
  const hash = createHash('sha256'); let size = 0;
  try {
    for await (const value of source) {
      const chunk = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
      size += chunk.length;
      if (size > expectedSize) {
        throw new AgentFileSystemError('LOCAL_CONTENT_INVALID', 'Downloaded content exceeds its declared size.');
      }
      hash.update(chunk); await handle.write(chunk);
    }
    if (size !== expectedSize || hash.digest('hex') !== expectedSha256) {
      throw new AgentFileSystemError('LOCAL_CONTENT_INVALID', 'Downloaded content failed integrity verification.');
    }
    await handle.sync();
  } catch (error) {
    throw error instanceof AgentFileSystemError ? error
      : new AgentFileSystemError('LOCAL_WRITE_FAILED', 'Downloaded content could not be written.', error);
  } finally {
    await handle.close();
  }
}

export class AgentFileStore {
  constructor(private readonly state: AgentStateStore) {}

  get rootPath(): string { return this.state.rootPath; }

  async cleanupTemporaryFiles(): Promise<void> {
    const directory = join(this.rootPath, AGENT_TEMP_DIRECTORY);
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const path = join(directory, entry.name);
      const stats = await lstat(path);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new AgentFileSystemError('INVALID_STORAGE_ROOT', 'Agent temporary directory contains an unsafe entry.');
      }
      await rm(path);
    }
  }

  async applyDelete(event: Extract<StorageManifestEvent, {kind: 'DELETE'}>, options: {force?: boolean} = {}): Promise<void> {
    const tracked = this.state.snapshot().files[event.fileEntryId];
    if (tracked) {
      const target = await secureAgentTarget(this.rootPath, tracked.relativePath);
      if (!await missing(target.absolutePath)) {
        if (!options.force) await requireUnchanged(this.rootPath, tracked);
        await unlink(target.absolutePath);
      }
    }
    await this.state.update(state => {
      delete state.files[event.fileEntryId];
      state.manifestSequence = Math.max(state.manifestSequence, event.sequence);
    });
  }

  async applyUpsert(event: Extract<StorageManifestEvent, {kind: 'UPSERT'}>,
    source: AsyncIterable<Uint8Array | string>, options: {force?: boolean; conflictPath?: string;
      conflictExpected?: {sizeBytes: number; sha256: string}} = {}): Promise<void> {
    const snapshot = this.state.snapshot(); const tracked = snapshot.files[event.fileEntryId];
    if (tracked && !options.force) await requireUnchanged(this.rootPath, tracked);
    if (options.force && options.conflictPath === event.logicalName && options.conflictExpected) {
      await requireExpected(this.rootPath, options.conflictPath, options.conflictExpected);
    }
    const target = await secureAgentTarget(this.rootPath, event.logicalName, {createParents: true});
    const sameTarget = tracked?.relativePath === target.relativePath;
    const resolvedTarget = options.force && options.conflictPath === target.relativePath;
    if (!sameTarget && !await missing(target.absolutePath) && !resolvedTarget) {
      throw new AgentFileSystemError('LOCAL_CONTENT_CONFLICT', 'Server content collides with an untracked local file.');
    }
    if (sameTarget && !await missing(target.absolutePath)) {
      const stats = await lstat(target.absolutePath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
        throw new AgentFileSystemError('UNSAFE_LOCAL_PATH', 'Server target is not a private regular file.');
      }
    }
    const temporary = join(this.rootPath, AGENT_TEMP_DIRECTORY, `blob-${randomUUID()}.partial`);
    try {
      await writeVerified(temporary, source, event.sizeBytes, event.sha256);
      await secureAgentTarget(this.rootPath, event.logicalName, {createParents: true});
      if (tracked && !options.force) await requireUnchanged(this.rootPath, tracked);
      if (options.force && options.conflictPath === event.logicalName && options.conflictExpected) {
        await requireExpected(this.rootPath, options.conflictPath, options.conflictExpected);
      }
      if (!sameTarget && !await missing(target.absolutePath) && !resolvedTarget) {
        throw new AgentFileSystemError('LOCAL_CONTENT_CONFLICT', 'Server target changed during download.');
      }
      await rename(temporary, target.absolutePath);
      const verified = await hashRegularFile(target.absolutePath);
      if (verified.sizeBytes !== event.sizeBytes || verified.sha256 !== event.sha256) {
        throw new AgentFileSystemError('LOCAL_CONTENT_INVALID', 'Published local content failed verification.');
      }
      if (tracked && tracked.relativePath !== target.relativePath) {
        const old = await secureAgentTarget(this.rootPath, tracked.relativePath);
        if (!await missing(old.absolutePath)) await unlink(old.absolutePath);
      }
      await this.state.update(state => {
        state.files[event.fileEntryId] = {fileEntryId: event.fileEntryId, relativePath: target.relativePath,
          revision: event.fileRevision, blobId: event.blobId, sizeBytes: event.sizeBytes,
          sha256: event.sha256, modifiedTimeMs: verified.modifiedTimeMs};
        state.manifestSequence = Math.max(state.manifestSequence, event.sequence);
      });
    } finally {
      await rm(temporary, {force: true});
    }
  }

  async inspect(relativePath: string): Promise<{sizeBytes: number; sha256: string; modifiedTimeMs: number}> {
    const target = await secureAgentTarget(this.rootPath, relativePath);
    return hashRegularFile(target.absolutePath);
  }

  async discardConflict(relativePath: string, expected?: {sizeBytes: number; sha256: string}): Promise<void> {
    const target = await secureAgentTarget(this.rootPath, relativePath);
    if (await missing(target.absolutePath)) return;
    if (expected) await requireExpected(this.rootPath, relativePath, expected);
    else await hashRegularFile(target.absolutePath);
    await unlink(target.absolutePath);
  }

  async moveConflict(relativePath: string, targetPath: string,
    expected: {sizeBytes: number; sha256: string}): Promise<void> {
    const source = await secureAgentTarget(this.rootPath, relativePath);
    const target = await secureAgentTarget(this.rootPath, targetPath, {createParents: true});
    if (await missing(source.absolutePath)) {
      if (await missing(target.absolutePath)) {
        throw new AgentFileSystemError('LOCAL_CONTENT_CONFLICT', 'Conflict content is missing.');
      }
      const recovered = await hashRegularFile(target.absolutePath);
      if (recovered.sizeBytes !== expected.sizeBytes || recovered.sha256 !== expected.sha256) {
        throw new AgentFileSystemError('LOCAL_CONTENT_CONFLICT', 'Conflict target does not match the pending content.');
      }
      return;
    }
    const inspected = await hashRegularFile(source.absolutePath);
    if (inspected.sizeBytes !== expected.sizeBytes || inspected.sha256 !== expected.sha256) {
      throw new AgentFileSystemError('LOCAL_CONTENT_CONFLICT', 'Conflict content changed after the decision.');
    }
    if (!await missing(target.absolutePath)) {
      throw new AgentFileSystemError('LOCAL_CONTENT_CONFLICT', 'Conflict target already exists.');
    }
    await rename(source.absolutePath, target.absolutePath);
  }
}
