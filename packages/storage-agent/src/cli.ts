#!/usr/bin/env node

import {generateKeyPairSync} from 'node:crypto';
import {resolve} from 'node:path';
import {StorageAgentHttpClient} from './client.js';
import {readAgentConfig, readPrivateAgentFile, writeAgentConfig, type StorageAgentLocalConfig} from './config.js';
import {AgentFileStore} from './files.js';
import {StorageAgentRuntime, type AgentRuntimeLogger} from './runtime.js';
import {AgentDirectoryScanner} from './scanner.js';
import {AgentStateStore} from './state.js';

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

async function pair(values: Map<string, string>): Promise<void> {
  const serverUrl = required(values, 'server'); const rootPath = resolve(required(values, 'root'));
  const configPath = resolve(required(values, 'config'));
  const pairingCode = (await readPrivateAgentFile(resolve(required(values, 'pairing-code-file')))).trim();
  const deviceLabel = required(values, 'device-label');
  const keys = generateKeyPairSync('ed25519');
  const publicDer = keys.publicKey.export({format: 'der', type: 'spki'});
  const paired = await StorageAgentHttpClient.pair(serverUrl, {pairingCode, deviceLabel,
    devicePublicKey: publicDer.subarray(-32).toString('base64url')});
  await AgentStateStore.initialize(rootPath, {committeeId: paired.host.committeeId, deviceId: paired.host.deviceId});
  const config: StorageAgentLocalConfig = {schemaVersion: 1, serverUrl, credential: paired.credential,
    committeeId: paired.host.committeeId, deviceId: paired.host.deviceId,
    leaseGeneration: paired.host.leaseGeneration, rootPath,
    devicePrivateKey: keys.privateKey.export({format: 'pem', type: 'pkcs8'}).toString()};
  await writeAgentConfig(configPath, config);
  logger.info('storage_agent.paired', {leaseGeneration: paired.host.leaseGeneration});
}

async function start(values: Map<string, string>): Promise<void> {
  const config = await readAgentConfig(resolve(required(values, 'config')));
  const state = await AgentStateStore.initialize(config.rootPath,
    {committeeId: config.committeeId, deviceId: config.deviceId});
  const files = new AgentFileStore(state); const scanner = new AgentDirectoryScanner(state, files);
  const runtime = new StorageAgentRuntime(new StorageAgentHttpClient(config.serverUrl, config.credential),
    config.leaseGeneration, state, files, scanner, logger);
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
  logger.info('storage_agent.started', {leaseGeneration: config.leaseGeneration});
  await runtime.run(controller.signal);
  logger.info('storage_agent.stopped');
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2); const values = argumentsFor(rest);
  if (command === 'pair') await pair(values);
  else if (command === 'start') await start(values);
  else throw new Error('Use `pair` or `start`.');
}

main().catch(error => {
  logger.error('storage_agent.failed', {code: error instanceof Error ? error.name : 'UNKNOWN_ERROR'});
  process.exitCode = 1;
});
