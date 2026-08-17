import {lstat, mkdir, realpath} from 'node:fs/promises';
import {isAbsolute, join, posix, relative, resolve, sep, win32} from 'node:path';
import {AGENT_METADATA_FILE, AGENT_TEMP_DIRECTORY} from './state.js';
import {AgentFileSystemError} from './errors.js';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const RESERVED = new Set([AGENT_METADATA_FILE.toLowerCase(), AGENT_TEMP_DIRECTORY.toLowerCase()]);

export function normalizeAgentRelativePath(value: unknown, _platform: NodeJS.Platform = process.platform): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500 || value.includes('\0')) {
    throw new AgentFileSystemError('UNSAFE_LOCAL_PATH', 'Local relative path is invalid.');
  }
  if (isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value)
    || /^[a-z]:/i.test(value) || value.startsWith('\\\\')) {
    throw new AgentFileSystemError('UNSAFE_LOCAL_PATH', 'Absolute local paths are not allowed.');
  }
  const portable = value.replaceAll('\\', '/');
  const parts = portable.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new AgentFileSystemError('UNSAFE_LOCAL_PATH', 'Local relative path contains an unsafe segment.');
  }
  if (RESERVED.has(parts[0]!.toLowerCase())) {
    throw new AgentFileSystemError('UNSAFE_LOCAL_PATH', 'Agent metadata paths are reserved.');
  }
  if (parts.some(part => WINDOWS_RESERVED.test(part)
    || part.endsWith('.') || part.endsWith(' ') || part.includes(':'))) {
    throw new AgentFileSystemError('UNSAFE_LOCAL_PATH', 'Local path is not portable across supported hosts.');
  }
  return parts.join('/');
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}

export async function secureAgentTarget(rootPath: string, value: unknown, options: {createParents?: boolean} = {}): Promise<{
  relativePath: string; absolutePath: string;
}> {
  const relativePath = normalizeAgentRelativePath(value);
  const root = await realpath(rootPath);
  const parts = relativePath.split('/');
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new AgentFileSystemError('UNSAFE_LOCAL_PATH', 'Local path parent is not a real directory.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !options.createParents) throw error;
      await mkdir(current, {mode: 0o700});
    }
    const canonical = await realpath(current);
    if (!within(root, canonical)) {
      throw new AgentFileSystemError('UNSAFE_LOCAL_PATH', 'Local path escapes the storage root.');
    }
  }
  const absolutePath = resolve(root, ...parts);
  if (!within(root, absolutePath)) {
    throw new AgentFileSystemError('UNSAFE_LOCAL_PATH', 'Local path escapes the storage root.');
  }
  return {relativePath, absolutePath};
}
