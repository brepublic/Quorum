import {createHash, randomUUID} from 'node:crypto';
import {constants as fsConstants, type Stats} from 'node:fs';
import {link, lstat, mkdir, open, realpath, unlink, type FileHandle} from 'node:fs/promises';
import {dirname, relative, resolve, sep} from 'node:path';
import type {ApiErrorCode} from '@quorum/contracts';
import {resolveInternalStoragePath, validateInternalStorageKey} from './paths.js';
import type {DurableStagingStore} from './staging.js';

export class ProviderStorageError extends Error {
  constructor(readonly failureCode: string, readonly apiCode: ApiErrorCode, message: string,
    readonly cause?: unknown) {
    super(message);
    this.name = 'ProviderStorageError';
  }
}

export interface ServerVolumeOperations {
  link: typeof link;
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  open: typeof open;
  realpath: typeof realpath;
  unlink: typeof unlink;
  syncFile: (handle: FileHandle, path: string) => Promise<void>;
  syncDirectory: (handle: FileHandle, path: string) => Promise<void>;
}

const defaultOperations: ServerVolumeOperations = {
  link, lstat, mkdir, open, realpath, unlink,
  syncFile: handle => handle.sync(),
  syncDirectory: handle => handle.sync()
};

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function exists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}

function blobKey(blobId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(blobId)) {
    throw new ProviderStorageError('PROVIDER_BLOB_ID_INVALID', 'VALIDATION_FAILED', 'Blob ID is invalid.');
  }
  const compact = blobId.replaceAll('-', '').toLowerCase();
  return `blobs/${compact.slice(0, 2)}/${compact}`;
}

export class ServerVolumeStore {
  private canonicalRoot?: string;

  constructor(readonly rootPath: string, readonly maxFileBytes: number,
    private readonly operations: ServerVolumeOperations = defaultOperations) {}

  async initialize(): Promise<void> {
    await this.operations.mkdir(this.rootPath, {recursive: true, mode: 0o700});
    const stats = await this.operations.lstat(this.rootPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error('The server volume root must be a real directory.');
    }
    this.canonicalRoot = await this.operations.realpath(this.rootPath);
  }

  keyForBlob(blobId: string): string {
    return blobKey(blobId);
  }

  pathForKey(key: unknown): string {
    return resolveInternalStoragePath(this.canonicalRoot ?? resolve(this.rootPath), key);
  }

  async commitFromStaging(input: {
    blobId: string;
    staging: DurableStagingStore;
    stagingKey: string;
    expectedSizeBytes: number;
    expectedSha256: string;
  }): Promise<{storageKey: string; sizeBytes: number; sha256: string}> {
    await this.ensureInitialized();
    const storageKey = blobKey(input.blobId);
    validateInternalStorageKey(input.stagingKey);
    if (!Number.isSafeInteger(input.expectedSizeBytes) || input.expectedSizeBytes < 0
      || input.expectedSizeBytes > this.maxFileBytes || !/^[a-f0-9]{64}$/.test(input.expectedSha256)) {
      throw new ProviderStorageError('PROVIDER_INPUT_INVALID', 'VALIDATION_FAILED', 'Provider input is invalid.');
    }
    let sourcePath: string;
    let targetPath: string;
    let partPath: string;
    try {
      await input.staging.verify(input.stagingKey, input.expectedSizeBytes, input.expectedSha256);
      sourcePath = input.staging.pathForKey(input.stagingKey);
      targetPath = await this.checkedTarget(storageKey);
      if (await this.targetExists(targetPath)) {
        const existing = await this.verify(storageKey, input.expectedSizeBytes, input.expectedSha256);
        return {storageKey, ...existing};
      }
      const partKey = `parts/${randomUUID().replaceAll('-', '')}`;
      partPath = await this.checkedTarget(partKey);
    } catch (error) {
      if (error instanceof ProviderStorageError) throw error;
      throw new ProviderStorageError('SERVER_VOLUME_PATH_INVALID', 'VALIDATION_FAILED',
        'Server volume path is invalid.', error);
    }
    let source: FileHandle | undefined;
    let target: FileHandle | undefined;
    let published = false;
    try {
      await this.regularFile(sourcePath);
      source = await this.operations.open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      target = await this.operations.open(partPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let copied = 0;
      while (true) {
        const read = await source.read(buffer, 0, buffer.length, null);
        if (!read.bytesRead) break;
        copied += read.bytesRead;
        if (copied > input.expectedSizeBytes || copied > this.maxFileBytes) {
          throw new ProviderStorageError('PROVIDER_SIZE_MISMATCH', 'VALIDATION_FAILED',
            'Provider content size does not match staging.');
        }
        hash.update(buffer.subarray(0, read.bytesRead));
        let offset = 0;
        while (offset < read.bytesRead) {
          const written = await target.write(buffer, offset, read.bytesRead - offset);
          if (written.bytesWritten < 1) throw new Error('The provider write made no progress.');
          offset += written.bytesWritten;
        }
      }
      const copiedHash = hash.digest('hex');
      if (copied !== input.expectedSizeBytes || copiedHash !== input.expectedSha256) {
        throw new ProviderStorageError('PROVIDER_INTEGRITY_MISMATCH', 'VALIDATION_FAILED',
          'Provider content does not match staging.');
      }
      await this.operations.syncFile(target, partPath);
      await source.close();
      source = undefined;
      await target.close();
      target = undefined;
      try {
        await this.operations.link(partPath, targetPath);
        published = true;
      } catch (error) {
        if (!exists(error)) throw error;
        await this.safeUnlink(partPath);
        const concurrent = await this.verify(storageKey, input.expectedSizeBytes, input.expectedSha256);
        return {storageKey, ...concurrent};
      }
      await this.operations.unlink(partPath);
      await this.syncDirectory(dirname(targetPath));
      const verified = await this.verify(storageKey, input.expectedSizeBytes, input.expectedSha256);
      return {storageKey, ...verified};
    } catch (error) {
      await source?.close().catch(() => undefined);
      await target?.close().catch(() => undefined);
      await this.safeUnlink(partPath);
      if (published) await this.safeUnlink(targetPath);
      if (error instanceof ProviderStorageError) throw error;
      throw new ProviderStorageError('SERVER_VOLUME_WRITE_FAILED', 'SERVICE_NOT_READY',
        'Server volume is unavailable.', error);
    }
  }

  async verify(storageKey: string, expectedSizeBytes: number, expectedSha256: string): Promise<{
    sizeBytes: number; sha256: string;
  }> {
    await this.ensureInitialized();
    const target = await this.checkedTarget(storageKey);
    try {
      const stats = await this.regularFile(target);
      if (stats.size > this.maxFileBytes) {
        throw new ProviderStorageError('PROVIDER_SIZE_MISMATCH', 'VALIDATION_FAILED',
          'Provider content size does not match staging.');
      }
      const handle = await this.operations.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let sizeBytes = 0;
      try {
        while (true) {
          const read = await handle.read(buffer, 0, buffer.length, null);
          if (!read.bytesRead) break;
          sizeBytes += read.bytesRead;
          hash.update(buffer.subarray(0, read.bytesRead));
        }
      } finally {
        await handle.close();
      }
      const sha256 = hash.digest('hex');
      if (sizeBytes !== expectedSizeBytes || sha256 !== expectedSha256) {
        throw new ProviderStorageError('PROVIDER_INTEGRITY_MISMATCH', 'SERVICE_NOT_READY',
          'Server volume content failed verification.');
      }
      return {sizeBytes, sha256};
    } catch (error) {
      if (error instanceof ProviderStorageError) throw error;
      throw new ProviderStorageError('SERVER_VOLUME_READ_FAILED', 'SERVICE_NOT_READY',
        'Server volume content is unavailable.', error);
    }
  }

  async *read(storageKey: string, expectedSizeBytes: number, expectedSha256: string): AsyncGenerator<Buffer> {
    await this.verify(storageKey, expectedSizeBytes, expectedSha256);
    const target = await this.checkedTarget(storageKey);
    const handle = await this.operations.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    try {
      while (true) {
        const result = await handle.read(buffer, 0, buffer.length, null);
        if (!result.bytesRead) break;
        yield Buffer.from(buffer.subarray(0, result.bytesRead));
      }
    } finally {
      await handle.close();
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.canonicalRoot) await this.initialize();
  }

  private async targetExists(target: string): Promise<boolean> {
    try {
      await this.regularFile(target);
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }

  private async checkedTarget(key: string): Promise<string> {
    const target = this.pathForKey(validateInternalStorageKey(key));
    await this.ensureSafeDirectory(dirname(target));
    return target;
  }

  private async ensureSafeDirectory(directory: string): Promise<void> {
    const root = this.canonicalRoot as string;
    if (directory === root) return;
    if (!within(root, directory)) throw new Error('The provider path escapes its root.');
    let current = root;
    for (const segment of relative(root, directory).split(sep)) {
      current = resolve(current, segment);
      let stats: Stats;
      try {
        stats = await this.operations.lstat(current);
      } catch (error) {
        if (!missing(error)) throw error;
        await this.operations.mkdir(current, {mode: 0o700});
        stats = await this.operations.lstat(current);
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error('The provider path contains an unsafe directory.');
      }
      const canonical = await this.operations.realpath(current);
      if (canonical !== root && !within(root, canonical)) throw new Error('The provider path escapes its root.');
    }
  }

  private async regularFile(target: string): Promise<Stats> {
    const stats = await this.operations.lstat(target);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
      throw new Error('The provider target is not a private regular file.');
    }
    return stats;
  }

  private async safeUnlink(target: string): Promise<void> {
    try {
      const stats = await this.operations.lstat(target);
      if (!stats.isSymbolicLink() && stats.isFile()) await this.operations.unlink(target);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await this.operations.open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      await this.operations.syncDirectory(handle, directory);
    } finally {
      await handle.close();
    }
  }
}
