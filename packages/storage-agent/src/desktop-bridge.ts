#!/usr/bin/env node
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {dirname, basename, join, resolve, relative, isAbsolute} from 'node:path';
import {lstat, mkdir, readFile, realpath, rm, writeFile, access, rename} from 'node:fs/promises';
import {constants} from 'node:fs';
import {X509Certificate, randomUUID} from 'node:crypto';
import {connect} from 'node:tls';
import {request as httpsRequest} from 'node:https';
import {readAgentConfig, readPrivateAgentFile, writeAgentConfig, type StorageAgentLocalConfig} from './config.js';
import {agentErrorCode} from './errors.js';
import {AGENT_METADATA_FILE, AgentStateStore} from './state.js';
import {AgentFileStore} from './files.js';
import {lockAgentRoot} from './runtime-lock.js';

const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
let configPath = ''; let config: StorageAgentLocalConfig | undefined;
type DraftConfig = {schemaVersion: 1; kind: 'unpaired'; serverUrl: string; rootPath: string; caCertificatePath: string; scanIntervalMs: number; deviceLabel: string};
let draft: DraftConfig | undefined;
let draftSource = '';
let child: ChildProcessWithoutNullStreams | undefined;
let exiting = false;
function publicConfig() {if (config) send({event: 'config', paired: true, configPath, serverUrl: config.serverUrl,
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
  const rel = relative(root, path); if (!rel || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel))) throw new Error('CONFIG_OUTSIDE_ROOT');
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
  await new Promise<void>(done => {
    const timeout = setTimeout(() => running.kill('SIGKILL'), 15000);
    running.once('close', () => {clearTimeout(timeout); done();});
    running.stdin.end(); running.kill('SIGTERM');
  });
}
async function start() {
  if (child) return;
  if (!config) throw new Error('CONFIG_REQUIRED');
  send({event: 'state', state: 'STARTING'});
  const running = spawn(process.execPath, [cli, 'start', '--config', configPath, '--desktop', 'true'], {
    env: {...process.env, NODE_EXTRA_CA_CERTS: config.caCertificatePath || process.env.NODE_EXTRA_CA_CERTS || ''}, stdio: 'pipe'});
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
async function command(input: Record<string, unknown>) {
  const action = input.command;
  stage = 'settings';
  if (action === 'stop') {await stop(); return;}
  if (action === 'restart') {await stop(); await start(); return;}
  if (action === 'start') {await start(); return;}
  if (child) throw new Error('STOP_FIRST');
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
      config = undefined; draft = loaded; configPath = path; draftSource = source; publicDraft();
    } else {
      let loaded: StorageAgentLocalConfig;
      try {loaded = await readAgentConfig(path);} catch (error) {
        if (safeError(error) !== 'OPERATION_FAILED') throw error;
        throw new Error('CONFIG_INVALID');
      }
      configPath = path; config = loaded; draft = undefined; draftSource = ''; publicConfig();
    }
    return;
  }
  if (action === 'unpair-local') {
    if (!config) throw new Error('CONFIG_REQUIRED');
    config = undefined; draft = undefined; draftSource = ''; configPath = '';
    send({event: 'unpaired', preserveSettings: true});
    return;
  }
  if (action === 'unpair') {
    if (!config) throw new Error('CONFIG_REQUIRED');
    stage = 'revoke';
    const current = config;
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
      config = undefined; draft = undefined; draftSource = ''; configPath = '';
      send({event: 'unpaired'});
    } finally {await unlock();}
    return;
  }
  if (action === 'save' || action === 'save-as') {
    if (!config) {
      const pathInput = action === 'save-as' ? input.savePath : input.configPath;
      if (!String(pathInput ?? '').trim()) throw new Error('CONFIG_PATH_REQUIRED');
      const destination = resolve(String(pathInput));
      if (action === 'save' && draft && destination !== configPath) throw new Error('CONFIG_PATH_CHANGED');
      const next: DraftConfig = {schemaVersion: 1, kind: 'unpaired', ...await settings(input),
        deviceLabel: String(input.deviceLabel || 'Linux Chair computer')};
      await checkDraftDestination(destination, next);
      const source = JSON.stringify(next, null, 2) + '\n';
      stage = 'config-write';
      await mkdir(dirname(destination), {recursive: true, mode: 0o700});
      if (action === 'save' && draft) {
        await unchangedDraft(destination);
        const temporary = destination + '.' + randomUUID() + '.tmp';
        try {await writeFile(temporary, source, {flag:'wx',mode:0o600}); await rename(temporary,destination);}
        finally {await rm(temporary,{force:true});}
      } else await writeFile(destination, source, {flag:'wx',mode:0o600});
      draft = next; draftSource = source; configPath = destination; publicDraft(); return;
    }
    if (!config) throw new Error('CONFIG_REQUIRED');
    const destination = action === 'save-as' ? resolve(String(input.savePath)) : configPath;
    if (action === 'save' && resolve(String(input.configPath)) !== configPath) throw new Error('CONFIG_PATH_CHANGED');
    const next = await settings(input);
    const meta = JSON.parse(await readPrivateAgentFile(join(next.rootPath, AGENT_METADATA_FILE)));
    if (meta.committeeId !== config.committeeId || meta.deviceId !== config.deviceId) throw new Error('ROOT_IDENTITY_MISMATCH');
    const root = await realpath(next.rootPath); outside(root, await realpath(configPath));
    if (next.caCertificatePath) outside(root, await realpath(next.caCertificatePath));
    // A moved directory must include every tracked and pending file. A partial
    // copy would otherwise be interpreted as deliberate shared-file deletion.
    if (root !== config.rootPath) {
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
    if (root !== config.rootPath) {
      try {await lstat(config.rootPath); oldUnlock = await lockAgentRoot(config.rootPath);}
      catch(error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    }
    let unlock: (() => Promise<void>) | undefined;
    try {
      unlock = await lockAgentRoot(root);
      if (new URL(config.serverUrl).origin !== next.serverUrl) {
        // Before sending a credential to a new address, require the old service's
        // authenticated TLS certificate. Different certificates require pairing.
        if (await fingerprint(config.serverUrl, config.caCertificatePath ?? '') !== await fingerprint(next.serverUrl, next.caCertificatePath))
          throw new Error('SERVER_CERTIFICATE_CHANGED');
      }
      stage = 'config-write';
      const updated = {...config, ...next};
      if (action === 'save-as') {
        if (!String(input.savePath ?? '').trim()) throw new Error('UNSAFE_PATH');
        stage = 'config-write';
      await mkdir(dirname(destination), {recursive: true, mode: 0o700});
        outside(root, join(await realpath(dirname(destination)), basename(destination)));
        await writeFile(destination, JSON.stringify(updated, null, 2) + '\n', {flag: 'wx', mode: 0o600});
      } else await writeAgentConfig(destination, updated);
      configPath = destination; config = updated; publicConfig();
    } finally {await unlock?.(); await oldUnlock?.();}
    return;
  }
  if (action === 'pair') {
    const next = await settings(input);
    stage = 'pairing-input';
    if (!String(input.pairingCode ?? '').trim()) throw new Error('PAIRING_CODE_REQUIRED');
    if (!String(input.deviceLabel ?? '').trim()) throw new Error('DEVICE_LABEL_REQUIRED');
    stage = 'config-write';
    if (!String(input.configPath ?? '').trim()) throw new Error('CONFIG_PATH_REQUIRED');
    const path = resolve(String(input.configPath));
    const replacingDraft = !!draft && path === configPath;
    if (replacingDraft) await unchangedDraft(path);
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
    const pairedPath = replacingDraft ? join(dirname(path), `.paired-${randomUUID()}.json`) : path;
    stage = 'local-state';
    const unlock = await lockAgentRoot(root);
    try {
      stage = 'config-write';
      await writeFile(codePath, String(input.pairingCode ?? ''), {flag: 'wx', mode: 0o600});
      stage = 'server-pairing';
      await new Promise<void>((res, rej) => {
        let failure = 'PAIRING_FAILED';
        const pairing = spawn(process.execPath, [cli, 'pair', '--server', next.serverUrl, '--root', root,
          '--config', pairedPath, '--pairing-code-file', codePath, '--device-label', String(input.deviceLabel || 'Linux Chair')],
          {env: {...process.env, NODE_EXTRA_CA_CERTS: next.caCertificatePath}, stdio: ['ignore','ignore','pipe']});
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
      const paired = {...await readAgentConfig(pairedPath), ...next};
      if (replacingDraft) await unchangedDraft(path);
      await writeAgentConfig(path, paired);
      config = paired; draft = undefined; draftSource = ''; configPath = path; publicConfig();
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
      if (['load','save','save-as','pair','unpair','unpair-local','start','stop','restart'].includes(input.command)) operation = input.command;
      await command(input); send({event:'completed',operation});
    } catch (error) {
      send({event:'error',code:safeError(error),operation,stage});
    }
    finally {send({event: 'busy', value: false});}
  });
});
async function shutdown() {if (exiting) return; exiting = true; await pending; await stop(); process.exit(0);}
input.on('close', () => void shutdown());
process.on('SIGTERM', () => void shutdown()); process.on('SIGINT', () => void shutdown());
process.stdout.on('error', () => void shutdown());
send({event: 'state', state: 'STOPPED'});
