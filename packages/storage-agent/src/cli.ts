#!/usr/bin/env node

import {agentErrorCode} from './errors.js';
import {lockAgentRoot} from './runtime-lock.js';
import {runDesktop} from './desktop-runtime.js';
import {generateKeyPairSync} from 'node:crypto';
import {resolve} from 'node:path';
import {StorageAgentHttpClient} from './client.js';
import {readAgentConfig, readPrivateAgentFile, writeAgentConfig, type StorageAgentLocalConfig} from './config.js';
import {AgentFileStore} from './files.js';
import {StorageAgentRuntime, type AgentRuntimeLogger} from './runtime.js';
import {AgentDirectoryScanner} from './scanner.js';
import {AgentStateStore} from './state.js';
import {publicAgentStatus} from './status.js';

function argumentsFor(values: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]; const value = values[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Agent command arguments are invalid.');
    result.set(key.slice(2), value);
  }
  return result;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name); if (!value) throw new Error(`--${name} is required.`); return value;
}

const logger: AgentRuntimeLogger = {
  info(event, fields = {}) { process.stdout.write(`${JSON.stringify({event, ...fields})}\n`); },
  error(event, fields = {}) { process.stderr.write(`${JSON.stringify({event, ...fields})}\n`); }
};

let failureStage = 'runtime';
async function pair(values: Map<string, string>): Promise<void> {
  const serverUrl = required(values, 'server'); const rootPath = resolve(required(values, 'root'));
  const configPath = resolve(required(values, 'config'));
  const pairingCode = (await readPrivateAgentFile(resolve(required(values, 'pairing-code-file')))).trim();
  const deviceLabel = required(values, 'device-label');
  const keys = generateKeyPairSync('ed25519');
  const publicDer = keys.publicKey.export({format: 'der', type: 'spki'});
  failureStage = 'server-pairing';
  const paired = await StorageAgentHttpClient.pair(serverUrl, {pairingCode, deviceLabel,
    devicePublicKey: publicDer.subarray(-32).toString('base64url')});
  failureStage = 'local-state';
  await AgentStateStore.initialize(rootPath, {committeeId: paired.host.committeeId, deviceId: paired.host.deviceId});
  const config: StorageAgentLocalConfig = {schemaVersion: 1, serverUrl, credential: paired.credential,
    committeeId: paired.host.committeeId, deviceId: paired.host.deviceId,
    leaseGeneration: paired.host.leaseGeneration, rootPath,
    devicePrivateKey: keys.privateKey.export({format: 'pem', type: 'pkcs8'}).toString()};
  failureStage = 'config-write';
  await writeAgentConfig(configPath, config);
  logger.info('storage_agent.paired', {leaseGeneration: paired.host.leaseGeneration});
}

async function start(values: Map<string, string>): Promise<void> {
  const config = await readAgentConfig(resolve(required(values, 'config')));
  const state = await AgentStateStore.initialize(config.rootPath,
    {committeeId: config.committeeId, deviceId: config.deviceId});
  const unlock = await lockAgentRoot(config.rootPath);
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
  const desktop = values.get('desktop') === 'true';
  if (desktop) {process.stdin.resume(); process.stdin.once('end', () => controller.abort());}
  const selectedLogger: AgentRuntimeLogger = desktop ? {
    info(event, fields = {}) {process.stderr.write(JSON.stringify({event, ...fields}) + '\n');},
    error(event, fields = {}) {process.stderr.write(JSON.stringify({event, ...fields}) + '\n');}
  } : logger;
  selectedLogger.info('storage_agent.started');
  try {
    if (desktop) await runDesktop(config, state, controller.signal, selectedLogger);
    else {
      const files = new AgentFileStore(state);
      const runtime = new StorageAgentRuntime(new StorageAgentHttpClient(config.serverUrl, config.credential, fetch, controller.signal),
        config.leaseGeneration, state, files, new AgentDirectoryScanner(state, files), selectedLogger);
      await runtime.run(controller.signal, {scanIntervalMs: config.scanIntervalMs});
    }
  } finally {controller.abort(); await unlock(); if (desktop) process.stdin.pause();}
  selectedLogger.info('storage_agent.stopped');
}

async function status(values: Map<string, string>): Promise<void> {
  const config = await readAgentConfig(resolve(required(values, 'config')));
  const state = await AgentStateStore.initialize(config.rootPath,
    {committeeId: config.committeeId, deviceId: config.deviceId});
  logger.info('storage_agent.status', {...publicAgentStatus(state.snapshot(), config.leaseGeneration)});
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2); const values = argumentsFor(rest);
  if (command === 'pair') await pair(values);
  else if (command === 'start') await start(values);
  else if (command === 'status') await status(values);
  else throw new Error('Use `pair`, `start`, or `status`.');
}

main().catch(error => {
  logger.error('storage_agent.failed', {code: agentErrorCode(error), stage: failureStage});
  process.exitCode = 1;
});
