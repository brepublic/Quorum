// @vitest-environment node

import {EventEmitter, once} from 'node:events';
import {Readable} from 'node:stream';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {describe, expect, it, vi} from 'vitest';
import {createLogger} from '../logger';
import type {IdentityService} from '../modules/identity/service';
import type {Stage7StorageAgentService} from '../modules/storage-agent/service';
import {createRequestHandler} from './app';

const authenticated = {sessionId: 'session', user: {id: '10000000-0000-4000-8000-000000000001',
  email: 'chair@example.com', displayName: 'Chair', status: 'ACTIVE', isSystemAdmin: false,
  sessionVersion: 1, mustChangePassword: false, createdAt: '2026-08-13T00:00:00.000Z', disabledAt: null}} as const;

class TestResponse extends EventEmitter {
  statusCode = 200; headersSent = false; body = ''; readonly headers = new Map<string, unknown>();
  setHeader(name: string, value: unknown): this {this.headers.set(name, value); return this;}
  end(body?: string): this {this.headersSent = true; if (body !== undefined) this.body += body;
    queueMicrotask(() => this.emit('finish')); return this;}
  destroy(): this {return this;}
}

async function send(storageAgent: Stage7StorageAgentService, options: {
  method: 'GET' | 'POST'; path: string; body?: unknown; headers?: Record<string, string>; identity?: IdentityService;
}) {
  const identity = options.identity ?? ({authenticate: vi.fn(async () => authenticated)} as unknown as IdentityService);
  const logs: string[] = [];
  const handler = createRequestHandler({health: {ready: async () => ({ready: true, checks: {
    database: {status: 'ok', migrationVersion: 20}, storage: {status: 'ok'}}})},
  logger: createLogger(line => logs.push(line)), version: 'test', databaseMigrationVersion: 20,
  identity, storageAgent, allowedOrigins: ['https://quorum.example.com']});
  const chunks = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))];
  const incoming = Readable.from(chunks) as unknown as IncomingMessage;
  Object.assign(incoming, {method: options.method, url: options.path, headers: {
    origin: 'https://quorum.example.com',
    cookie: '__Host-quorum_session=session; __Host-quorum_csrf=csrf',
    'x-csrf-token': 'csrf',
    ...options.headers
  }, socket: {remoteAddress: '127.0.0.1'}});
  const response = new TestResponse(); const finished = once(response, 'finish');
  handler(incoming, response as unknown as ServerResponse); await finished;
  return {response, logs, identity};
}

describe('stage 7 storage Agent HTTP boundary', () => {
  it('pairs with a one-time code without accepting a browser identity as the Agent', async () => {
    const pairing = {pairingCode: 'QRM-PAIR', deviceLabel: 'Chair laptop', devicePublicKey: 'a'.repeat(43)};
    const pair = vi.fn(async () => ({credential: 'qsa1.device.secret', host: {id: 'host'}}));
    const identity = {authenticate: vi.fn()} as unknown as IdentityService;
    const {response, logs} = await send({pair} as unknown as Stage7StorageAgentService,
      {method: 'POST', path: '/api/v1/storage-agent/pair', body: pairing, identity});
    expect(response.statusCode).toBe(201);
    expect(pair).toHaveBeenCalledWith(pairing, expect.objectContaining({requestId: expect.any(String)}));
    expect(identity.authenticate).not.toHaveBeenCalled();
    expect(logs.join('\n')).not.toContain(pairing.pairingCode);
    expect(logs.join('\n')).not.toContain('qsa1.device.secret');
  });

  it('requires the distinct QuorumAgent scheme and forwards lease generation', async () => {
    const heartbeat = vi.fn(async () => ({id: 'host', status: 'ACTIVE'}));
    const service = {heartbeat} as unknown as Stage7StorageAgentService;
    const accepted = await send(service, {method: 'POST', path: '/api/v1/storage-agent/heartbeat',
      body: {leaseGeneration: 7}, headers: {authorization: 'QuorumAgent qsa1.device.secret'}});
    expect(accepted.response.statusCode).toBe(200);
    expect(heartbeat).toHaveBeenCalledWith('qsa1.device.secret', {leaseGeneration: 7});

    const rejected = await send(service, {method: 'POST', path: '/api/v1/storage-agent/heartbeat',
      body: {leaseGeneration: 7}, headers: {authorization: 'Bearer qsa1.device.secret'}});
    expect(rejected.response.statusCode).toBe(401);
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });

  it('keeps host management on Session, Origin, and CSRF authorization', async () => {
    const committeeId = '20000000-0000-4000-8000-000000000001';
    const hostId = '30000000-0000-4000-8000-000000000001';
    const listHosts = vi.fn(async () => [{id: hostId}]);
    const createPairing = vi.fn(async () => ({code: 'QRM-SECRET', purpose: 'INITIAL'}));
    const revokeHost = vi.fn(async () => ({id: hostId, status: 'REVOKED'}));
    const service = {listHosts, createPairing, revokeHost} as unknown as Stage7StorageAgentService;
    expect((await send(service, {method: 'GET', path: `/api/v1/committees/${committeeId}/storage-hosts`}))
      .response.statusCode).toBe(200);
    const body = {baseRevision: 2, purpose: 'INITIAL'};
    expect((await send(service, {method: 'POST',
      path: `/api/v1/committees/${committeeId}/storage-agent/pairing-codes`, body})).response.statusCode).toBe(201);
    expect(createPairing).toHaveBeenCalledWith(authenticated, committeeId, body,
      expect.objectContaining({requestId: expect.any(String)}));
    expect((await send(service, {method: 'POST',
      path: `/api/v1/committees/${committeeId}/storage-hosts/${hostId}/revoke`, body: {baseRevision: 3}}))
      .response.statusCode).toBe(200);

    const forbidden = await send(service, {method: 'POST',
      path: `/api/v1/committees/${committeeId}/storage-agent/pairing-codes`, body,
      headers: {origin: 'https://attacker.example.com', authorization: 'QuorumAgent qsa1.device.secret'}});
    expect(forbidden.response.statusCode).toBe(403);
    expect(createPairing).toHaveBeenCalledTimes(1);
  });
});
