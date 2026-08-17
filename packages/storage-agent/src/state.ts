import {randomUUID} from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import {lstat, mkdir, open, realpath, rename} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import type {StorageAgentLocalChange} from '@quorum/contracts';
import {AgentFileSystemError} from './errors.js';

export const AGENT_METADATA_FILE = '.quorum-storage.json';
export const AGENT_TEMP_DIRECTORY = '.quorum-tmp';

export interface TrackedAgentFile {
  fileEntryId: string;
  relativePath: string;
  revision: number;
  blobId: string;
  sizeBytes: number;
  sha256: string;
  modifiedTimeMs: number;
}

export interface PendingAgentUpload {
  taskId: string;
  requestId: string;
  manifestSequence: number;
  change: Extract<StorageAgentLocalChange, {kind: 'UPSERT'}>;
  relativePath: string;
  fileEntryId: string;
  fileRevision: number;
  sizeBytes: number;
  sha256: string;
}

export interface PendingAgentConflict {
  conflictId: string;
  relativePath: string;
  change: StorageAgentLocalChange;
  resolutionRequestId?: string;
}

export interface AgentDirectoryState {
  schemaVersion: 1;
  committeeId: string;
  deviceId: string;
  manifestSequence: number;
  files: Record<string, TrackedAgentFile>;
  pendingUploads: Record<string, PendingAgentUpload>;
  conflicts: Record<string, PendingAgentConflict>;
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validateState(value: unknown): AgentDirectoryState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentFileSystemError('INVALID_STORAGE_ROOT', 'Agent directory metadata is invalid.');
  }
  const state = value as Partial<AgentDirectoryState>;
  if (state.conflicts === undefined) state.conflicts = {};
  if (state.schemaVersion !== 1 || !validUuid(state.committeeId) || !validUuid(state.deviceId)
    || !Number.isSafeInteger(state.manifestSequence) || Number(state.manifestSequence) < 0
    || !state.files || typeof state.files !== 'object' || Array.isArray(state.files)
    || !state.pendingUploads || typeof state.pendingUploads !== 'object' || Array.isArray(state.pendingUploads)
    || !state.conflicts || typeof state.conflicts !== 'object' || Array.isArray(state.conflicts)) {
    throw new AgentFileSystemError('INVALID_STORAGE_ROOT', 'Agent directory metadata is invalid.');
  }
  return state as AgentDirectoryState;
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  } finally {
    await handle?.close();
  }
}

async function readMetadata(path: string): Promise<string> {
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new AgentFileSystemError('INVALID_STORAGE_ROOT', 'Agent directory metadata is unsafe.');
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1 || before.dev !== stats.dev || before.ino !== stats.ino) {
      throw new AgentFileSystemError('INVALID_STORAGE_ROOT', 'Agent directory metadata is unsafe.');
    }
    return await handle.readFile('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    if (error instanceof AgentFileSystemError) throw error;
    throw new AgentFileSystemError('INVALID_STORAGE_ROOT', 'Agent directory metadata could not be read safely.', error);
  } finally {
    await handle?.close();
  }
}

export class AgentStateStore {
  private constructor(readonly rootPath: string, private state: AgentDirectoryState) {}

  static async initialize(rootPath: string, identity: {committeeId: string; deviceId: string}): Promise<AgentStateStore> {
    await mkdir(rootPath, {recursive: true, mode: 0o700});
    const root = await lstat(rootPath);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new AgentFileSystemError('INVALID_STORAGE_ROOT', 'Agent storage root must be a real directory.');
    }
    const canonicalRoot = await realpath(rootPath);
    await mkdir(join(canonicalRoot, AGENT_TEMP_DIRECTORY), {recursive: true, mode: 0o700});
    const temporary = await lstat(join(canonicalRoot, AGENT_TEMP_DIRECTORY));
    if (!temporary.isDirectory() || temporary.isSymbolicLink()) {
      throw new AgentFileSystemError('INVALID_STORAGE_ROOT', 'Agent temporary directory is unsafe.');
    }
    const metadataPath = join(canonicalRoot, AGENT_METADATA_FILE);
    let state: AgentDirectoryState;
    try {
      state = validateState(JSON.parse(await readMetadata(metadataPath)));
      if (state.committeeId !== identity.committeeId || state.deviceId !== identity.deviceId) {
        throw new AgentFileSystemError('INVALID_STORAGE_ROOT', 'Agent storage root belongs to another host.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      state = {schemaVersion: 1, committeeId: identity.committeeId, deviceId: identity.deviceId,
        manifestSequence: 0, files: {}, pendingUploads: {}, conflicts: {}};
      const store = new AgentStateStore(canonicalRoot, state);
      await store.save(state);
      return store;
    }
    return new AgentStateStore(canonicalRoot, state);
  }

  snapshot(): AgentDirectoryState {
    return structuredClone(this.state);
  }

  async update(mutator: (state: AgentDirectoryState) => void): Promise<AgentDirectoryState> {
    const next = structuredClone(this.state);
    mutator(next);
    await this.save(validateState(next));
    return this.snapshot();
  }

  private async save(next: AgentDirectoryState): Promise<void> {
    const target = join(this.rootPath, AGENT_METADATA_FILE);
    const temporary = join(this.rootPath, AGENT_TEMP_DIRECTORY, `state-${randomUUID()}.tmp`);
    const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    this.state = next;
    await syncDirectory(dirname(target));
  }
}
