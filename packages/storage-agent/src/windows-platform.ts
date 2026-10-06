import {execFile, spawn} from 'node:child_process';
import {access} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execute = promisify(execFile);
export async function windowsPlatformHelper(): Promise<string> {
  const explicit = process.env.QUORUM_AGENT_PLATFORM;
  const candidates = explicit ? [explicit] : [join(dirname(process.execPath), 'quorum-agent-platform.exe'),
    fileURLToPath(new URL('../../storage-agent-desktop/target/debug/quorum-agent-platform.exe', import.meta.url))];
  for (const path of candidates) {try {await access(path); return path;} catch { /* Try the next supported location. */ }}
  throw new Error('WINDOWS_PLATFORM_UNAVAILABLE');
}
export async function protectPrivatePath(path: string): Promise<void> {
  if (process.platform !== 'win32') return;
  await execute(await windowsPlatformHelper(), ['--protect', path], {windowsHide: true, timeout: 10000});
}
export async function checkPrivatePath(path: string): Promise<void> {
  if (process.platform !== 'win32') return;
  await execute(await windowsPlatformHelper(), ['--check-private', path], {windowsHide: true, timeout: 10000});
}
export async function lockWindowsRoot(root: string): Promise<() => Promise<void>> {
  const helper = spawn(await windowsPlatformHelper(), ['--lock-root', root], {stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true});
  let held = false;
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {helper.kill(); reject(new Error('WINDOWS_PLATFORM_UNAVAILABLE'));}, 10000);
    helper.once('error', () => {clearTimeout(timeout); reject(new Error('WINDOWS_PLATFORM_UNAVAILABLE'));});
    helper.once('close', () => {clearTimeout(timeout); if (!held) reject(new Error('UNSAFE_AGENT_LOCK'));});
    helper.stdout!.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('\n')) {
        clearTimeout(timeout);
        if (output.trim() === 'LOCKED') {held = true; resolve();}
        else {helper.stdin!.end(); reject(new Error('AGENT_ALREADY_RUNNING'));}
      }
    });
  });
  // Losing a live lock must fail closed rather than leave an unlocked sync loop.
  let released = false;
  helper.once('close', () => {if (!released) process.exit(1);});
  return async () => {
    if (released) return;
    released = true;
    if (helper.exitCode !== null) return;
    await new Promise<void>(resolve => {helper.once('close', () => resolve()); helper.stdin!.end();});
  };
}
