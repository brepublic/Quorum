import {constants} from 'node:fs';
import {open, mkdir, readFile, writeFile, rename, lstat} from 'node:fs/promises';
import {join, dirname, resolve} from 'node:path';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {parseAgentPairingConfig, type AgentPairingConfig} from '@quorum/contracts';
import {normalizeDesktopSite} from './desktop-auth.js';

export function desktopConfigDirectory(): string {
  const base = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'quorum-agent');
}
type Preferences = {lastConfig?: string; serverUrl?: string; ordinals: Record<string, number>};
async function preferences(): Promise<Preferences> {
  try {
    const value = JSON.parse(await readFile(join(desktopConfigDirectory(), 'desktop-state.json'), 'utf8'));
    if (!value || !value.ordinals || typeof value.ordinals !== 'object' || Array.isArray(value.ordinals)
      || (value.lastConfig !== undefined && typeof value.lastConfig !== 'string')) throw new Error();
    if (value.serverUrl !== undefined && (typeof value.serverUrl !== 'string' || normalizeDesktopSite(value.serverUrl) !== value.serverUrl)) throw new Error();
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {ordinals: {}};
    throw new Error('DESKTOP_STATE_INVALID');
  }
}
async function savePreferences(value: Preferences) {
  const directory = desktopConfigDirectory();
  await mkdir(directory, {recursive: true, mode: 0o700});
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(value), {mode: 0o600, flag: 'wx'});
  await rename(temporary, join(directory, 'desktop-state.json'));
}
export async function rememberConfiguration(path?: string) {
  const value = await preferences(); value.lastConfig = path; await savePreferences(value);
}
export async function lastConfiguration() {return (await preferences()).lastConfig;}
export async function desktopSite() {return (await preferences()).serverUrl ?? 'https://quorum.sramun.org';}
export async function rememberSite(site: string) {
  const value = await preferences(); value.serverUrl = normalizeDesktopSite(site); await savePreferences(value);
  return value.serverUrl;
}

/** Downloaded pairing files have no long-lived credentials and need not be mode 0600. */
export async function readPairingInput(target: string): Promise<AgentPairingConfig | undefined> {
  let source: string;
  if (target.startsWith('quorum-agent:')) {
    const url = new URL(target);
    if (url.protocol !== 'quorum-agent:' || url.hostname !== 'pair' || url.pathname || url.search
      || url.username || url.password || url.port || target.length > 32768) throw new Error('PAIRING_CONFIG_INVALID');
    source = decodeURIComponent(url.hash.slice(1));
  } else {
    const path = target.startsWith('file:') ? fileURLToPath(target) : resolve(target);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 16384) throw new Error('PAIRING_CONFIG_INVALID');
      source = await handle.readFile('utf8');
    } finally {await handle.close();}
    const value = JSON.parse(source);
    if (value?.kind !== 'quorum-agent-pairing') return undefined;
  }
  return parseAgentPairingConfig(JSON.parse(source));
}
function directoryName(name: string) {
  return name.replace(/[\x00-\x1f\x7f/\\<>:"|?*]/g, '_').replace(/^\.+|[. ]+$/g, '').trim().slice(0, 80) || 'Committee';
}
function documentsDirectory(): string {
  if (process.platform === 'win32') {
    const powershell = join(process.env.SystemRoot || 'C:\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetFolderPath("MyDocuments")'],
      {encoding: 'utf8', timeout: 5000, windowsHide: true}).trim() || join(homedir(), 'Documents');
  }
  try {
    const value = execFileSync('xdg-user-dir', ['DOCUMENTS'], {encoding: 'utf8', timeout: 3000}).trim();
    if (value.startsWith('/') && value !== homedir()) return value;
  } catch { /* Environments without xdg-user-dirs use the conventional Documents folder. */ }
  return join(homedir(), 'Documents');
}
function ordinalKey(config: Pick<AgentPairingConfig, 'serverUrl' | 'committeeId' | 'committeeName'>) {return `${config.serverUrl}/${config.committeeId}`;}
export async function proposedDirectory(config: Pick<AgentPairingConfig, 'serverUrl' | 'committeeId' | 'committeeName'>): Promise<{rootPath: string; ordinal: number}> {
  const saved = (await preferences()).ordinals[ordinalKey(config)];
  let ordinal = typeof saved === 'number' && Number.isSafeInteger(saved) && saved >= 0 ? saved + 1 : 1;
  const parent = join(documentsDirectory(), 'Quorum');
  for (;;) {
    const rootPath = join(parent, `${directoryName(config.committeeName)}-${ordinal}`);
    try {await lstat(rootPath); ordinal++;}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {rootPath, ordinal}; throw error;}
  }
}
export async function allocateDirectory(config: Pick<AgentPairingConfig, 'serverUrl' | 'committeeId' | 'committeeName'>, rootPath: string, ordinal: number) {
  await mkdir(dirname(rootPath), {recursive: true, mode: 0o700});
  // Exclusive creation protects another committee and concurrently created folders.
  await mkdir(rootPath, {mode: 0o700});
  const value = await preferences();
  value.ordinals[ordinalKey(config)] = Math.max(value.ordinals[ordinalKey(config)] || 0, ordinal);
  await savePreferences(value);
}
