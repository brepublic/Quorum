import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';

// Linux flock uses the inherited open-file description. Keeping our handle open
// retains the lock; the kernel releases it even after a crash. Never unlink it.
export const AGENT_LOCK_FILE = '.quorum-storage.lock';
export async function lockAgentRoot(root: string): Promise<() => Promise<void>> {
  if (process.platform !== 'linux') return async () => undefined;
  const handle = await open(join(root, AGENT_LOCK_FILE), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077)) throw new Error('UNSAFE_AGENT_LOCK');
    await new Promise<void>((resolve, reject) => {
      const child = spawn('flock', ['--exclusive', '--nonblock', '3'], {stdio: ['ignore', 'ignore', 'ignore', handle.fd]});
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error('AGENT_ALREADY_RUNNING')));
    });
    return () => handle.close();
  } catch (error) {await handle.close(); throw error;}
}
