import {createHash, randomUUID} from 'node:crypto';
import {constants as fsConstants, type Stats} from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
  type FileHandle
} from 'node:fs/promises';
import {dirname, relative, resolve, sep} from 'node:path';
import type {ApiErrorCode} from '@quorum/contracts';
import {resolveInternalStoragePath, validateInternalStorageKey} from './paths.js';

export interface StagedContent {
  sizeBytes: number;
  sha256: string;
}

export class UploadStreamError extends Error {
  constructor(
    readonly failureCode: string,
    readonly apiCode: ApiErrorCode,
    message: string,
    readonly receivedSizeBytes: number,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'UploadStreamError';
  }
}

export interface StagingOperations {
  link: typeof link;
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  open: typeof open;
  realpath: typeof realpath;
  unlink: typeof unlink;
}

const defaultOperations: StagingOperations = {link, lstat, mkdir, open, realpath, unlink};

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}

export class DurableStagingStore {
  private canonicalRoot?: string;

  constructor(
    readonly rootPath: string,
    readonly maxFileBytes: number,
    readonly maxRequestBytes: number,
    private readonly operations: StagingOperations = defaultOperations
  ) {}

  async initialize(): Promise<void> {
    await this.operations.mkdir(this.rootPath, {recursive: true, mode: 0o700});
    const rootStats = await this.operations.lstat(this.rootPath);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw new Error('The durable staging root must be a real directory.');
    }
    this.canonicalRoot = await this.operations.realpath(this.rootPath);
  }

  pathForKey(key: unknown): string {
    const root = this.canonicalRoot ?? resolve(this.rootPath);
    return resolveInternalStoragePath(root, key);
  }

  async exists(key: string): Promise<boolean> {
    await this.ensureInitialized();
    const target = await this.checkedTarget(key);
    try {
      const stats = await this.operations.lstat(target);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error('The staging target is not a regular file.');
      }
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }

  async write(input: {
    key: string;
    source: AsyncIterable<Uint8Array | string>;
    expectedSizeBytes: number;
    expectedSha256: string;
    contentLength?: number;
  }): Promise<StagedContent> {
    await this.ensureInitialized();
    validateInternalStorageKey(input.key);
    this.preflight(input.expectedSizeBytes, input.contentLength);
    let target: string;
    let partPath: string;
    try {
      target = await this.checkedTarget(input.key);
      const partKey = `parts/${randomUUID().replaceAll('-', '')}`;
      partPath = await this.checkedTarget(partKey);
    } catch (error) {
      throw new UploadStreamError('STAGING_PATH_INVALID', 'VALIDATION_FAILED',
        'Staging path is invalid.', 0, error);
    }
    let handle: FileHandle | undefined;
    let received = 0;
    try {
      handle = await this.operations.open(partPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
      const hash = createHash('sha256');
      try {
        for await (const chunk of input.source) {
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
          received += buffer.length;
          if (received > this.maxRequestBytes || received > this.maxFileBytes) {
            throw new UploadStreamError('UPLOAD_TOO_LARGE', 'PAYLOAD_TOO_LARGE',
              'Upload exceeds the configured limit.', received);
          }
          if (received > input.expectedSizeBytes) {
            throw new UploadStreamError('UPLOAD_SIZE_MISMATCH', 'VALIDATION_FAILED',
              'Upload size does not match the declared size.', received);
          }
          hash.update(buffer);
          let offset = 0;
          while (offset < buffer.length) {
            try {
              const result = await handle.write(buffer, offset, buffer.length - offset);
              if (result.bytesWritten < 1) throw new Error('The staging write made no progress.');
              offset += result.bytesWritten;
            } catch (error) {
              throw new UploadStreamError('STAGING_WRITE_FAILED', 'SERVICE_NOT_READY',
                'Durable staging is unavailable.', received, error);
            }
          }
        }
      } catch (error) {
        if (error instanceof UploadStreamError) throw error;
        throw new UploadStreamError('UPLOAD_INTERRUPTED', 'BAD_REQUEST', 'Upload did not complete.', received, error);
      }
      if (received !== input.expectedSizeBytes) {
        throw new UploadStreamError('UPLOAD_SIZE_MISMATCH', 'VALIDATION_FAILED',
          'Upload size does not match the declared size.', received);
      }
      const actualHash = hash.digest('hex');
      if (actualHash !== input.expectedSha256) {
        throw new UploadStreamError('UPLOAD_HASH_MISMATCH', 'VALIDATION_FAILED',
          'Upload SHA-256 does not match.', received);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.operations.link(partPath, target);
      await this.operations.unlink(partPath);
      await this.syncDirectory(dirname(target));
      return {sizeBytes: received, sha256: actualHash};
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await this.safeUnlink(partPath);
      if (error instanceof UploadStreamError) throw error;
      throw new UploadStreamError('STAGING_WRITE_FAILED', 'SERVICE_NOT_READY',
        'Durable staging is unavailable.', received, error);
    }
  }

  async verify(key: string, expectedSizeBytes: number, expectedSha256: string): Promise<StagedContent> {
    await this.ensureInitialized();
    let target: string;
    let stats: Stats;
    try {
      target = await this.checkedTarget(key);
      stats = await this.regularFile(target);
    } catch (error) {
      throw new UploadStreamError('STAGING_PATH_INVALID', 'VALIDATION_FAILED',
        'Staging path is invalid.', 0, error);
    }
    if (stats.size > this.maxFileBytes || stats.size > this.maxRequestBytes) {
      throw new UploadStreamError('UPLOAD_TOO_LARGE', 'PAYLOAD_TOO_LARGE',
        'Upload exceeds the configured limit.', stats.size);
    }
    const handle = await this.operations.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const hash = createHash('sha256');
    let received = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    try {
      while (true) {
        const result = await handle.read(buffer, 0, buffer.length, null);
        if (!result.bytesRead) break;
        received += result.bytesRead;
        hash.update(buffer.subarray(0, result.bytesRead));
      }
    } finally {
      await handle.close();
    }
    if (received !== expectedSizeBytes) {
      throw new UploadStreamError('UPLOAD_SIZE_MISMATCH', 'VALIDATION_FAILED',
        'Upload size does not match the declared size.', received);
    }
    const actualHash = hash.digest('hex');
    if (actualHash !== expectedSha256) {
      throw new UploadStreamError('UPLOAD_HASH_MISMATCH', 'VALIDATION_FAILED',
        'Upload SHA-256 does not match.', received);
    }
    return {sizeBytes: received, sha256: actualHash};
  }

  async *read(key: string, expectedSizeBytes: number, expectedSha256: string): AsyncGenerator<Buffer> {
    await this.verify(key, expectedSizeBytes, expectedSha256);
    const target = await this.checkedTarget(key);
    await this.regularFile(target);
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

  async remove(key: string): Promise<void> {
    await this.ensureInitialized();
    let target: string;
    try {
      target = await this.checkedTarget(key);
      const stats = await this.operations.lstat(target);
      if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('The staging target is not a regular file.');
      await this.operations.unlink(target);
    } catch (error) {
      if (missing(error)) return;
      throw new UploadStreamError('STAGING_CLEANUP_FAILED', 'SERVICE_NOT_READY',
        'Durable staging cleanup failed.', 0, error);
    }
  }

  private preflight(expectedSizeBytes: number, contentLength?: number): void {
    if (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 0) {
      throw new UploadStreamError('UPLOAD_SIZE_MISMATCH', 'VALIDATION_FAILED',
        'Upload size does not match the declared size.', 0);
    }
    if (expectedSizeBytes > this.maxFileBytes || expectedSizeBytes > this.maxRequestBytes
      || (contentLength !== undefined && (contentLength > this.maxFileBytes || contentLength > this.maxRequestBytes))) {
      throw new UploadStreamError('UPLOAD_TOO_LARGE', 'PAYLOAD_TOO_LARGE',
        'Upload exceeds the configured limit.', 0);
    }
    if (contentLength !== undefined && contentLength !== expectedSizeBytes) {
      throw new UploadStreamError('UPLOAD_SIZE_MISMATCH', 'VALIDATION_FAILED',
        'Upload size does not match the declared size.', 0);
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.canonicalRoot) await this.initialize();
  }

  private async checkedTarget(key: string): Promise<string> {
    const target = this.pathForKey(key);
    await this.ensureSafeDirectory(dirname(target));
    return target;
  }

  private async ensureSafeDirectory(directory: string): Promise<void> {
    const root = this.canonicalRoot as string;
    if (directory === root) return;
    if (!within(root, directory)) throw new Error('The staging path escapes its root.');
    const segments = relative(root, directory).split(sep);
    let current = root;
    for (const segment of segments) {
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
        throw new Error('The staging path contains an unsafe directory.');
      }
      const canonical = await this.operations.realpath(current);
      if (canonical !== root && !within(root, canonical)) {
        throw new Error('The staging path escapes its root.');
      }
    }
  }

  private async regularFile(target: string): Promise<Stats> {
    const stats = await this.operations.lstat(target);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error('The staging target is not a regular file.');
    }
    return stats;
  }

  private async safeUnlink(target: string): Promise<void> {
    try {
      const stats = await this.operations.lstat(target);
      if (!stats.isFile() || stats.isSymbolicLink()) return;
      await this.operations.unlink(target);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await this.operations.open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
