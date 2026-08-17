import {constants as fsConstants} from 'node:fs';
import {chmod, lstat, mkdir, open, rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentFileSystemError} from './errors.js';

export interface StorageAgentLocalConfig {
  schemaVersion: 1;
  serverUrl: string;
  credential: string;
  committeeId: string;
  deviceId: string;
  leaseGeneration: number;
  rootPath: string;
  devicePrivateKey: string;
}

function valid(value: unknown): StorageAgentLocalConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Agent config is invalid.');
  const config = value as Partial<StorageAgentLocalConfig>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (config.schemaVersion !== 1 || typeof config.serverUrl !== 'string' || typeof config.credential !== 'string'
    || !uuid.test(config.committeeId ?? '') || !uuid.test(config.deviceId ?? '')
    || !Number.isSafeInteger(config.leaseGeneration) || Number(config.leaseGeneration) < 1
    || typeof config.rootPath !== 'string' || !config.rootPath
    || typeof config.devicePrivateKey !== 'string' || !config.devicePrivateKey.includes('PRIVATE KEY')) {
    throw new Error('Agent config is invalid.');
  }
  return config as StorageAgentLocalConfig;
}

export async function readAgentConfig(path: string): Promise<StorageAgentLocalConfig> {
  return valid(JSON.parse(await readPrivateAgentFile(path)));
}

export async function readPrivateAgentFile(path: string): Promise<string> {
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new AgentFileSystemError('INVALID_STORAGE_ROOT', 'Agent config must be a private regular file.');
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1 || before.dev !== stats.dev || before.ino !== stats.ino
      || (process.platform !== 'win32' && (stats.mode & 0o077) !== 0)) {
      throw new AgentFileSystemError('INVALID_STORAGE_ROOT', 'Agent config must be a private regular file.');
    }
    return await handle.readFile('utf8');
  } catch (error) {
    if (error instanceof AgentFileSystemError) throw error;
    throw new AgentFileSystemError('INVALID_STORAGE_ROOT', 'Agent config could not be read safely.', error);
  } finally {
    await handle?.close();
  }
}

export async function writeAgentConfig(path: string, config: StorageAgentLocalConfig): Promise<void> {
  valid(config); await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try { await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
  if (process.platform !== 'win32') await chmod(path, 0o600);
}
