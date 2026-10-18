#!/usr/bin/env node
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {dirname, basename, join, resolve, relative, isAbsolute} from 'node:path';
import {lstat, mkdir, readFile, realpath, rm, writeFile, access, rename, readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {X509Certificate, randomUUID} from 'node:crypto';
import {connect} from 'node:tls';
import {request as httpsRequest} from 'node:https';
import {readAgentConfig, readPrivateAgentFile, writePrivateAgentFile, writeAgentConfig, type StorageAgentLocalConfig} from './config.js';
import {agentErrorCode} from './errors.js';
import {AGENT_METADATA_FILE, AgentStateStore} from './state.js';
import {AgentFileStore} from './files.js';
import {lockAgentRoot} from './runtime-lock.js';
import {type AgentPairingConfig, type AgentCommitteeCandidate} from '@quorum/contracts';
import {DesktopAccount, normalizeDesktopSite} from './desktop-auth.js';
import {desktopSite, rememberSite} from './desktop-setup.js';
import {desktopConfigDirectory, readPairingInput, proposedDirectory, allocateDirectory, rememberConfiguration, lastConfiguration} from './desktop-setup.js';

const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
let configPath = ''; let config: StorageAgentLocalConfig | undefined;
type DraftConfig = {schemaVersion: 1; kind: 'unpaired'; serverUrl: string; rootPath: string; caCertificatePath: string; scanIntervalMs: number; deviceLabel: string};
let draft: DraftConfig | undefined;
let draftSource = '';
let child: ChildProcessWithoutNullStreams | undefined;
let exiting = false;
let account: DesktopAccount | undefined;
let candidates: AgentCommitteeCandidate[] = [];
let selected: AgentCommitteeCandidate | undefined;
let selectedDirectory: {rootPath: string; ordinal: number} | undefined;
let pendingPair: {path: string; config: StorageAgentLocalConfig} | undefined;
let accountEmail = '';
let switching: {previous: StorageAgentLocalConfig; path: string; resume: boolean; revoked: boolean; targetPath: string} | undefined;
function switchState() {send({event: 'switching', active: !!switching, revoked: switching?.revoked ?? false,
  committeeName: switching?.previous.committeeName ?? switching?.previous.committeeId ?? '', serverUrl: switching?.previous.serverUrl ?? ''});}

async function logout() {const previous = account; account = undefined; accountEmail = ''; candidates = []; selected = undefined;
  if (previous) try {await previous.logout();} catch (error) {
    if (safeError(error) !== 'AUTHENTICATION_REQUIRED') send({event: 'error', code: 'ACCOUNT_LOGOUT_FAILED', stage: 'login'});
  }}
async function listCandidates() {
  if (!account) throw new Error('AUTHENTICATION_REQUIRED');
  stage = 'committees';
  candidates = await account.call<AgentCommitteeCandidate[]>('/api/v1/storage-agent/committees');
  send({event: 'candidates', email: accountEmail, candidates: candidates.filter(item => !switching || account!.origin !== switching.previous.serverUrl || item.id !== switching.previous.committeeId)});
}
let setup: {value: AgentPairingConfig; rootPath: string; ordinal: number; allocated: boolean; chosenRoot?: string} | undefined;
function publicConfig() {if (config) send({event: 'config', paired: true, committeeName: config.committeeName ?? config.committeeId, configPath, serverUrl: config.serverUrl,
  rootPath: config.rootPath, caCertificatePath: config.caCertificatePath ?? '',
  scanSeconds: (config.scanIntervalMs ?? 30000) / 1000,
  committeeUrl: new URL(`/committees/${config.committeeId}/files`, config.serverUrl).href});}
function publicDraft() {if (draft) send({event: 'config', paired: false, configPath,
  serverUrl: draft.serverUrl, rootPath: draft.rootPath, caCertificatePath: draft.caCertificatePath,
  scanSeconds: draft.scanIntervalMs / 1000, deviceLabel: draft.deviceLabel, committeeUrl: ''});}
async function canonical(path: string): Promise<string> {
  try {return await realpath(path);} catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return join(await canonical(dirname(path)), basename(path));
  }
}
async function checkDraftDestination(path: string, value: DraftConfig) {
  outside(await canonical(value.rootPath), await canonical(path));
  if (value.caCertificatePath) outside(await canonical(value.rootPath), await canonical(value.caCertificatePath));
}
async function unchangedDraft(path: string) {
  if (!draft || path !== configPath || await readPrivateAgentFile(path) !== draftSource) throw new Error('CONFIG_EXISTS');
}
async function checkOverwriteTarget(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('UNSAFE_PATH');
  } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
}
async function writeDesktopConfig(path: string, source: string, overwrite: boolean) {
  if (!overwrite) {await writePrivateAgentFile(path, source); return;}
  await checkOverwriteTarget(path);
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writePrivateAgentFile(temporary, source);
    await rename(temporary, path);
  } finally {await rm(temporary,{force:true});}
}
let stage = 'settings';
const safeError = agentErrorCode;
async function cert(path: string) {if (!path) return;
  const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('INVALID_CERTIFICATE');
  try {new X509Certificate(await readFile(path));} catch {throw new Error('INVALID_CERTIFICATE');}
}
async function fingerprint(address: string, caPath: string): Promise<string> {
  stage = 'tls';
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('HTTPS_REQUIRED');
  const ca = caPath ? await readFile(caPath) : undefined;
  return new Promise((res, rej) => {
    const socket = connect({host: url.hostname, port: Number(url.port || 443), servername: url.hostname,
      ...(ca ? {ca} : {}), rejectUnauthorized: true}, () => {
      const value = socket.getPeerCertificate().fingerprint256;
      socket.end(); value ? res(value) : rej(new Error('INVALID_CERTIFICATE'));
    });
    socket.setTimeout(10000, () => socket.destroy(new Error('TLS_TIMEOUT')));
    socket.on('error', rej);
  });
}
function outside(root: string, path: string) {
  const rel = relative(root, path); if (!rel || (rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(rel))) throw new Error('CONFIG_OUTSIDE_ROOT');
}
async function settings(input: Record<string, unknown>) {
  const serverUrl = String(input.serverUrl ?? ''); const rootPath = resolve(String(input.rootPath ?? ''));
  const caCertificatePath = String(input.caCertificatePath ?? '');
  stage = 'scan-interval';
  const seconds = Number(input.scanSeconds);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error('INVALID_SCAN_INTERVAL');
  stage = 'server-address';
  let u: URL;
  try {u = new URL(serverUrl);} catch {throw new Error('HTTPS_REQUIRED');}
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new Error('HTTPS_REQUIRED');
  stage = 'storage-directory';
  if (!String(input.rootPath ?? '').trim()) throw new Error('ROOT_REQUIRED');
  stage = 'ca-certificate';
  await cert(caCertificatePath);
  return {serverUrl: u.origin, rootPath, caCertificatePath, scanIntervalMs: seconds * 1000};
}
async function stop() {
  if (!child) return;
  send({event: 'state', state: 'STOPPING'});
  const running = child;
  if (running.exitCode !== null || running.signalCode !== null) return;
  await new Promise<void>(done => {
    const timeout = setTimeout(() => running.kill('SIGKILL'), 15000);
    running.once('close', () => {clearTimeout(timeout); done();});
    running.stdin.end();
    if (process.platform !== 'win32') running.kill('SIGTERM');
  });
}
async function start() {
  if (child) return;
  if (!config) throw new Error('CONFIG_REQUIRED');
  stage = 'storage-directory';
  // Restoring a config must never recreate a missing synchronized directory.
  const metadata = JSON.parse(await readPrivateAgentFile(join(config.rootPath, AGENT_METADATA_FILE)));
  if (metadata.committeeId !== config.committeeId || metadata.deviceId !== config.deviceId) throw new Error('ROOT_IDENTITY_MISMATCH');
  send({event: 'state', state: 'STARTING'});
  const running = spawn(process.execPath, [cli, 'start', '--config', configPath, '--desktop', 'true'], {
    env: {...process.env, NODE_EXTRA_CA_CERTS: config.caCertificatePath || process.env.NODE_EXTRA_CA_CERTS || ''}, stdio: 'pipe', windowsHide: true});
  child = running;
  createInterface({input: running.stdout}).on('line', line => {
    try {const event = JSON.parse(line); if (event.event === 'snapshot') send(event);} catch { /* no raw output */ }
  });
  createInterface({input: running.stderr}).on('line', line => {
    try {const data = JSON.parse(line);
      if (/^storage_agent\.[a-z_]{1,60}$/.test(data.event)) send({event: 'log',
        text: `${new Date().toISOString()} ${data.event} ${/^[A-Z0-9_]{1,80}$/.test(data.code) ? data.code : ''}`});} catch { /* no raw secrets */ }
  });
  running.on('error', () => send({event: 'error', code: 'START_FAILED'}));
  running.on('close', code => {if (child === running) child = undefined; send({event: 'state', state: 'EXITED'});
    if (code) send({event: 'error', code: 'AGENT_EXITED'});});
}
async function revoke(current: StorageAgentLocalConfig) {
    const unlock = await lockAgentRoot(current.rootPath);
    try {
      const ca = current.caCertificatePath ? await readFile(current.caCertificatePath) : undefined;
      const url = new URL('/api/v1/storage-agent/revoke', current.serverUrl);
      if (url.protocol !== 'https:') throw new Error('HTTPS_REQUIRED');
      await new Promise<void>((done, fail) => {
        const request = httpsRequest(url, {method: 'POST', ca, rejectUnauthorized: true,
          headers: {'content-type': 'application/json', authorization: `QuorumAgent ${current.credential}`,
            'x-storage-lease-generation': String(current.leaseGeneration)}}, response => {
          let body = '';
          response.on('data', chunk => {
            body += chunk;
            if (body.length > 65536) response.destroy(new Error('REVOKE_FAILED'));
          });
          response.on('error', fail);
          response.on('end', () => {
            try {
              const value = JSON.parse(body);
              if (response.statusCode === 200 && value.data?.revoked === true) done();
              else {const code = safeError({code:value.error?.code}); fail(new Error(code === 'OPERATION_FAILED' ? 'REVOKE_FAILED' : code));}
            } catch {fail(new Error('REVOKE_FAILED'));}
          });
        });
        request.setTimeout(15000, () => request.destroy(new Error('REVOKE_FAILED')));
        request.on('error', fail); request.end('{}');
      });
    } finally {await unlock();}
}
async function prepareAccountPair(input: Record<string, unknown>) {
  if (setup) return;
  if (!account || !selected) throw new Error('AUTHENTICATION_REQUIRED');
  if (switching && account.origin === switching.previous.serverUrl && selected.id === switching.previous.committeeId) throw new Error('INVALID_REFERENCE');
  if (selected.currentHost && input.transferConfirmed !== true) throw new Error('CHAIR_HOST_ALREADY_PAIRED');
  stage = 'pairing';
  const result = await account.call<{configuration: AgentPairingConfig}>(
    `/api/v1/committees/${selected.id}/storage-agent/pairing-codes`,
    {baseRevision: selected.revision, purpose: selected.currentHost ? 'TRANSFER' : 'INITIAL'});
  setup = {value: result.configuration, ...selectedDirectory!, allocated: false};
  const path = join(desktopConfigDirectory(), 'configurations', `${randomUUID()}.json`);
  if (switching) switching.targetPath = path; else configPath = path;
}
async function prepareSetupDirectory(input: Record<string, unknown>) {
  if (!setup) throw new Error('PAIRING_CONFIG_INVALID');
  stage = 'pairing-input';
  if (!pendingPair && Date.parse(setup.value.expiresAt) <= Date.now()) throw new Error('LINK_EXPIRED');
  stage = 'storage-directory';
  const chosen = resolve(String(input.rootPath || setup.rootPath));
  if (chosen === setup.rootPath && !setup.allocated) {
    try {await allocateDirectory(setup.value, chosen, setup.ordinal); setup.allocated = true;}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('DIRECTORY_EXISTS'); throw error;}
  }
  if (!pendingPair && chosen !== setup.chosenRoot) {
    try {if ((await readdir(chosen)).length > 0) throw new Error('DIRECTORY_NOT_EMPTY');}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  }
  setup.chosenRoot = chosen;
  return chosen;
}
async function command(input: Record<string, unknown>) {
  const action = input.command;
  stage = 'settings';
  if (pendingPair && !['pair', 'setup-pair', 'account-pair', 'switch-committee', 'stop'].includes(String(action))) {
    throw new Error('PAIRING_RECOVERY_REQUIRED');
  }
  if (action === 'begin-switch') {
    if (!config || switching) throw new Error('CONFIG_REQUIRED');
    switching = {previous: config, path: configPath, resume: !!child, revoked: false, targetPath: ''};
    await logout(); setup = undefined; switchState();
    send({event: 'account', page: 'login', serverUrl: config.serverUrl}); return;
  }
  if (action === 'cancel-switch') {
    if (!switching) return;
    const previous = switching;
    if (previous.revoked) await rememberConfiguration();
    await logout(); setup = undefined; switching = undefined; switchState();
    if (!previous.revoked) {
      config = previous.previous; configPath = previous.path; publicConfig();
      if (previous.resume) {if (child) send({event: 'state', state: 'RUNNING'}); else await start();}
    } else {send({event: 'unpaired'});}
    return;
  }
  if (action === 'switch-committee') {
    if (!switching) throw new Error('CONFIG_REQUIRED');
    await prepareAccountPair(input);
    if (!switching.revoked) {
      // Validate the chosen destination before interrupting the existing connection.
      const next = await settings({...input, serverUrl: setup!.value.serverUrl});
      const chosen = await prepareSetupDirectory(input);
      await mkdir(chosen, {recursive: true, mode: 0o700});
      const info = await lstat(chosen);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('UNSAFE_PATH');
      await access(chosen, constants.W_OK);
      outside(await canonical(chosen), await canonical(switching.targetPath));
      if (next.caCertificatePath) outside(await canonical(chosen), await canonical(next.caCertificatePath));
      await fingerprint(next.serverUrl, next.caCertificatePath);
      await stop(); stage = 'revoke'; await revoke(switching.previous);
      switching.revoked = true; config = undefined; configPath = switching.targetPath;
      switchState(); await rememberConfiguration();
    }
    configPath = switching.targetPath;
    try {await command({...input, command: 'setup-pair'});}
    finally {
      if (config || pendingPair) await logout();
      // Once the new identity is saved, a start failure belongs to that connection.
      if (config) {switching = undefined; switchState();}
    }
    return;
  }
  if (action === 'login') {
    if ((config || child) && !switching) throw new Error('STOP_AND_UNPAIR_FIRST');
    await logout();
    stage = 'server-address';
    const site = normalizeDesktopSite(String(input.serverUrl ?? ''));
    stage = 'ca-certificate'; await cert(String(input.caCertificatePath ?? ''));
    await rememberSite(site);
    account = new DesktopAccount(site, String(input.caCertificatePath ?? ''));
    stage = 'login';
    const result = await account.call<{user: {mustChangePassword: boolean; email: string}}>('/api/v1/auth/login',
      {email: String(input.email ?? ''), password: String(input.password ?? '')});
    accountEmail = result.user.email || String(input.email ?? '');
    send({event: 'account', email: accountEmail, page: result.user.mustChangePassword ? 'password' : 'committees', serverUrl: site});
    if (!result.user.mustChangePassword) await listCandidates();
    return;
  }
  if (action === 'change-password') {
    if (!account) throw new Error('AUTHENTICATION_REQUIRED');
    stage = 'login'; await account.call('/api/v1/auth/change-password', {newPassword: String(input.password ?? '')});
    send({event: 'account', page: 'committees', email: accountEmail, serverUrl: account.origin}); await listCandidates(); return;
  }
  if (action === 'list-committees') {await listCandidates(); return;}
  if (action === 'logout') {await logout(); setup = undefined; send({event: 'account', page: 'login', serverUrl: await desktopSite()}); return;}
  if (action === 'select-committee') {
    if (!account) throw new Error('AUTHENTICATION_REQUIRED');
    selected = candidates.find(item => item.id === input.committeeId);
    if (!selected) throw new Error('INVALID_REFERENCE');
    setup = undefined;
    const directory = await proposedDirectory({serverUrl: account.origin, committeeId: selected.id, committeeName: selected.name});
    selectedDirectory = directory;
    send({event: 'setup', serverUrl: account.origin, committeeName: selected.name, rootPath: directory.rootPath,
      committeeStatus: selected.status, storageProvider: selected.storageProvider, currentHost: selected.currentHost});
    return;
  }
  if (action === 'account-pair') {
    if (switching) throw new Error('STOP_AND_UNPAIR_FIRST');
    await prepareAccountPair(input);
    try {await command({...input, command: 'setup-pair'});}
    finally {if (config || pendingPair) await logout();}
    return;
  }
  if (action === 'stop') {await stop(); return;}
  if (action === 'restart') {await stop(); await start(); return;}
  if (action === 'start') {await start(); return;}
  if (action === 'restore') {
    const previous = await lastConfiguration();
    if (previous) {await command({command: 'load', configPath: previous}); if (config) await start();}
    else send({event: 'defaults', serverUrl: await desktopSite(), configPath: join(desktopConfigDirectory(), 'configurations', `${randomUUID()}.json`)});
    return;
  }
  if (action === 'open') {
    if (pendingPair) throw new Error('PAIRING_RECOVERY_REQUIRED');
    const target = String(input.target ?? '');
    stage = 'config-read';
    const value = await readPairingInput(target);
    if (!value) {
      if (child) throw new Error('STOP_FIRST');
      await command({command: 'load', configPath: target.startsWith('file:') ? fileURLToPath(target) : target});
      if (config) await start();
      return;
    }
    if (config?.committeeId === value.committeeId && config.serverUrl === value.serverUrl) {
      publicConfig(); if (!child) await start(); return;
    }
    if (child || config) throw new Error('STOP_AND_UNPAIR_FIRST');
    await logout();
    if (Date.parse(value.expiresAt) <= Date.now()) throw new Error('LINK_EXPIRED');
    if (!setup || setup.value.pairingCode !== value.pairingCode) {
      setup = {value, ...await proposedDirectory(value), allocated: false};
      configPath = join(desktopConfigDirectory(), 'configurations', `${randomUUID()}.json`);
    }
    send({event: 'setup', configPath, serverUrl: value.serverUrl, committeeName: value.committeeName,
      rootPath: setup.rootPath, purpose: value.purpose, expiresAt: value.expiresAt,
      committeeStatus: value.committeeStatus, storageProvider: value.storageProvider, accountSetup: false});
    return;
  }
  if (action === 'unpair') await stop();
  if (child) throw new Error('STOP_FIRST');
  if (action === 'setup-pair') {
    if (!setup) throw new Error('PAIRING_CONFIG_INVALID');
    if (config) {await rememberConfiguration(configPath); setup = undefined; await start(); return;}
    const chosen = await prepareSetupDirectory(input);
    await command({...input, rootPath: chosen, command: 'pair', configPath, serverUrl: setup.value.serverUrl,
      pairingCode: setup.value.pairingCode, committeeName: setup.value.committeeName});
    setup = undefined;
    await start(); return;
  }
  if (action === 'load') {
    if (!String(input.configPath ?? '').trim()) throw new Error('CONFIG_PATH_REQUIRED');
    const path = resolve(String(input.configPath));
    stage = 'config-read';
    let source: string;
    try {source = await readPrivateAgentFile(path);} catch (error) {
      if (safeError(error) === 'INVALID_STORAGE_ROOT') throw new Error('CONFIG_PRIVATE_REQUIRED');
      throw error;
    }
    const value = JSON.parse(source);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CONFIG_INVALID');
    if (value.kind === 'unpaired') {
      const keys = ['schemaVersion','kind','serverUrl','rootPath','caCertificatePath','scanIntervalMs','deviceLabel'];
      if (value.schemaVersion !== 1 || Object.keys(value).some(key => !keys.includes(key))
        || ['serverUrl','rootPath','caCertificatePath','deviceLabel'].some(key => typeof value[key] !== 'string')) throw new Error('INVALID_DRAFT');
      const next = await settings({...value, scanSeconds: value.scanIntervalMs / 1000});
      const loaded: DraftConfig = {schemaVersion: 1, kind: 'unpaired', ...next, deviceLabel: value.deviceLabel};
      await checkDraftDestination(path, loaded);
      config = undefined; draft = loaded; configPath = path; draftSource = source; setup = undefined; publicDraft(); await rememberConfiguration(path);
    } else {
      let loaded: StorageAgentLocalConfig;
      try {loaded = await readAgentConfig(path);} catch (error) {
        if (safeError(error) !== 'OPERATION_FAILED') throw error;
        throw new Error('CONFIG_INVALID');
      }
      configPath = path; config = loaded; draft = undefined; draftSource = ''; setup = undefined; publicConfig();
      await rememberConfiguration(path); await rememberSite(loaded.serverUrl);
    }
    return;
  }
  if (action === 'unpair-local') {
    if (!config) throw new Error('CONFIG_REQUIRED');
    config = undefined; draft = undefined; draftSource = ''; configPath = '';
    setup = undefined; await rememberConfiguration();
    send({event: 'unpaired'});
    return;
  }
  if (action === 'unpair') {
    if (!config) throw new Error('CONFIG_REQUIRED');
    stage = 'revoke';
    await revoke(config);
    config = undefined; draft = undefined; draftSource = ''; configPath = '';
    setup = undefined; await rememberConfiguration();
    send({event: 'unpaired'});
    return;
  }
  if (action === 'save' || action === 'save-as') {
    if (!config) {
      const pathInput = action === 'save-as' ? input.savePath : input.configPath;
      if (!String(pathInput ?? '').trim()) throw new Error('CONFIG_PATH_REQUIRED');
      const destination = resolve(String(pathInput));
      if (action === 'save' && draft && destination !== configPath) throw new Error('CONFIG_PATH_CHANGED');
      const next: DraftConfig = {schemaVersion: 1, kind: 'unpaired', ...await settings(input),
        deviceLabel: String(input.deviceLabel || 'Chair computer')};
      await checkDraftDestination(destination, next);
      const source = JSON.stringify(next, null, 2) + '\n';
      stage = 'config-write';
      await mkdir(dirname(destination), {recursive: true, mode: 0o700});
      if (action === 'save' && draft && input.overwrite !== true) {
        await unchangedDraft(destination);
        const temporary = destination + '.' + randomUUID() + '.tmp';
        try {await writePrivateAgentFile(temporary, source); await rename(temporary,destination);}
        finally {await rm(temporary,{force:true});}
      } else await writeDesktopConfig(destination, source, input.overwrite === true);
      draft = next; draftSource = source; configPath = destination; publicDraft(); await rememberConfiguration(destination); return;
    }
    if (!config) throw new Error('CONFIG_REQUIRED');
    const destination = action === 'save-as' ? resolve(String(input.savePath)) : configPath;
    if (action === 'save' && resolve(String(input.configPath)) !== configPath) throw new Error('CONFIG_PATH_CHANGED');
    const next = await settings(input);
    const meta = JSON.parse(await readPrivateAgentFile(join(next.rootPath, AGENT_METADATA_FILE)));
    if (meta.committeeId !== config.committeeId || meta.deviceId !== config.deviceId) throw new Error('ROOT_IDENTITY_MISMATCH');
    const root = await realpath(next.rootPath); outside(root, await realpath(configPath));
    if (next.caCertificatePath) outside(root, await realpath(next.caCertificatePath));
    // Compare canonical paths on both sides: Windows temp paths can use an 8.3
    // alias for the same directory, which must not be locked twice as a move.
    const movedRoot = root !== await canonical(config.rootPath);
    // A moved directory must include every tracked and pending file. A partial
    // copy would otherwise be interpreted as deliberate shared-file deletion.
    if (movedRoot) {
      const movedState = await AgentStateStore.initialize(root, {committeeId: config.committeeId, deviceId: config.deviceId});
      const store = new AgentFileStore(movedState);
      for (const entry of [...Object.values(movedState.snapshot().files), ...Object.values(movedState.snapshot().pendingUploads)]) {
        const actual = await store.inspect(entry.relativePath);
        if (actual.sizeBytes !== entry.sizeBytes || actual.sha256 !== entry.sha256) throw new Error('MOVE_COMPLETE_DIRECTORY');
      }
      for (const conflict of Object.values(movedState.snapshot().conflicts)) {
        if (conflict.change.kind !== 'DELETE') await store.inspect(conflict.relativePath);
      }
    }
    let oldUnlock: (() => Promise<void>) | undefined;
    if (movedRoot) {
      try {await lstat(config.rootPath); oldUnlock = await lockAgentRoot(config.rootPath);}
      catch(error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    }
    let unlock: (() => Promise<void>) | undefined;
    try {
      unlock = await lockAgentRoot(root);
      if (new URL(config.serverUrl).origin !== next.serverUrl) throw new Error('STOP_AND_UNPAIR_FIRST');
      stage = 'config-write';
      const updated = {...config, ...next};
      if (action === 'save-as') {
        if (!String(input.savePath ?? '').trim()) throw new Error('UNSAFE_PATH');
        stage = 'config-write';
      await mkdir(dirname(destination), {recursive: true, mode: 0o700});
        outside(root, join(await realpath(dirname(destination)), basename(destination)));
        await writeDesktopConfig(destination, JSON.stringify(updated, null, 2) + '\n', input.overwrite === true);
      } else {await checkOverwriteTarget(destination); await writeAgentConfig(destination, updated); }
      configPath = destination; config = updated; publicConfig(); await rememberConfiguration(destination);
    } finally {await unlock?.(); await oldUnlock?.();}
    return;
  }
  if (action === 'pair') {
    if (pendingPair) {
      stage = 'local-state';
      await AgentStateStore.initialize(pendingPair.config.rootPath,
        {committeeId: pendingPair.config.committeeId, deviceId: pendingPair.config.deviceId});
      stage = 'config-write';
      await writeAgentConfig(pendingPair.path, pendingPair.config);
      config = pendingPair.config; configPath = pendingPair.path; draft = undefined; draftSource = '';
      pendingPair = undefined; publicConfig(); await rememberConfiguration(configPath); return;
    }
    const next = await settings(input);
    stage = 'pairing-input';
    if (!String(input.pairingCode ?? '').trim()) throw new Error('PAIRING_CODE_REQUIRED');
    if (!String(input.deviceLabel ?? '').trim()) throw new Error('DEVICE_LABEL_REQUIRED');
    stage = 'config-write';
    if (!String(input.configPath ?? '').trim()) throw new Error('CONFIG_PATH_REQUIRED');
    const path = resolve(String(input.configPath));
    const replacingDraft = !!draft && path === configPath;
    if (input.overwrite === true) await checkOverwriteTarget(path);
    else if (replacingDraft) await unchangedDraft(path);
    else try {await lstat(path); throw new Error('CONFIG_EXISTS');} catch(e) {if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;}
    stage = 'storage-directory';
    await mkdir(next.rootPath, {recursive: true, mode: 0o700});
    const rootInfo = await lstat(next.rootPath); if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('UNSAFE_PATH');
    const root = await realpath(next.rootPath); outside(root, path);
    if (next.caCertificatePath) outside(root, resolve(next.caCertificatePath));
    try {await lstat(join(root, AGENT_METADATA_FILE)); throw new Error('ROOT_ALREADY_PAIRED');} catch(e) {if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;}
    await access(root, constants.W_OK); await mkdir(dirname(path), {recursive: true, mode: 0o700});
    outside(root, join(await realpath(dirname(path)), basename(path)));
    await fingerprint(next.serverUrl, next.caCertificatePath);
    const codePath = join(dirname(path), `.pairing-${randomUUID()}`);
    const pairedPath = (replacingDraft || input.overwrite === true) ? join(dirname(path), `.paired-${randomUUID()}.json`) : path;
    stage = 'local-state';
    const unlock = await lockAgentRoot(root);
    try {
      stage = 'config-write';
      await writePrivateAgentFile(codePath, String(input.pairingCode ?? ''));
      stage = 'server-pairing';
      await new Promise<void>((res, rej) => {
        let failure = 'PAIRING_FAILED';
        const pairing = spawn(process.execPath, [cli, 'pair', '--server', next.serverUrl, '--root', root,
          '--config', pairedPath, '--pairing-code-file', codePath, '--device-label', String(input.deviceLabel || 'Chair computer')],
          {env: {...process.env, NODE_EXTRA_CA_CERTS: next.caCertificatePath}, stdio: ['ignore','ignore','pipe','ipc'], windowsHide: true});
        pairing.on('message', message => {
          const value = message as {event?: string; config?: StorageAgentLocalConfig};
          if (value.event === 'paired-config' && value.config) pendingPair = {path, config: {...value.config, ...next,
            ...(typeof input.committeeName === 'string' ? {committeeName: input.committeeName} : {})}};
        });
        let output = '';
        pairing.stderr!.on('data', chunk => {
          output += chunk.toString();
          if (output.length > 65536) output = '';
          let end: number;
          while ((end = output.indexOf('\n')) >= 0) {
            const line = output.slice(0,end); output = output.slice(end+1);
            try {const event = JSON.parse(line);
              if (event.event === 'storage_agent.failed') {
                failure = safeError({code:event.code});
                if (['server-pairing','local-state','config-write'].includes(event.stage)) stage = event.stage;
              }
            } catch { /* no raw child output */ }
          }
        });
        pairing.on('error', rej); pairing.on('close', code => code === 0 ? res() : rej(new Error(failure)));
      });
      stage = 'config-write';
      const paired = {...await readAgentConfig(pairedPath), ...next,
        ...(typeof input.committeeName === 'string' ? {committeeName: input.committeeName} : {})};
      if (input.overwrite === true) await checkOverwriteTarget(path);
      else if (replacingDraft) await unchangedDraft(path);
      await writeAgentConfig(path, paired);
      pendingPair = undefined;
      config = paired; draft = undefined; draftSource = ''; configPath = path; publicConfig(); await rememberConfiguration(path);
    } finally {await unlock(); await rm(codePath, {force: true}); if (pairedPath !== path) await rm(pairedPath,{force:true});}
  }
}
const input = createInterface({input: process.stdin, crlfDelay: Infinity});
let pending = Promise.resolve();
input.on('line', line => {
  if (line.length > 65536 || exiting) return;
  pending = pending.then(async () => {
    send({event: 'busy', value: true});
    let operation = 'unknown';
    try {
      const input = JSON.parse(line);
      if (['begin-switch','cancel-switch','switch-committee','login','logout','change-password','list-committees','select-committee','account-pair','open','restore','setup-pair','load','save','save-as','pair','unpair','unpair-local','start','stop','restart'].includes(input.command)) operation = input.command;
      await command(input); send({event:'completed',operation});
    } catch (error) {
      if (safeError(error) === 'AUTHENTICATION_REQUIRED' && operation !== 'login' && operation !== 'unpair' && (operation !== 'switch-committee' || stage === 'pairing')) {
        account?.clear(); account = undefined; candidates = []; selected = undefined;
        send({event: 'account', page: 'login', serverUrl: await desktopSite()});
      }
      send({event:'error',code:safeError(error),operation,stage: pendingPair ? 'paired-local-recovery' : stage});
    }
    finally {send({event: 'busy', value: false});}
  });
});
async function shutdown() {if (exiting) return; exiting = true; await pending; await stop(); try {await logout();} catch { /* Account cookies are cleared even when offline. */ } process.exit(0);}
input.on('close', () => void shutdown());
process.on('SIGTERM', () => void shutdown()); process.on('SIGINT', () => void shutdown());
process.stdout.on('error', () => void shutdown());
send({event: 'state', state: 'STOPPED'});
