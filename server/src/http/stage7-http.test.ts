// @vitest-environment node

import {EventEmitter, once} from 'node:events';
import {Readable} from 'node:stream';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {describe, expect, it, vi} from 'vitest';
import {createLogger} from '../logger';
import type {IdentityService} from '../modules/identity/service';
import type {Stage7StorageAgentService} from '../modules/storage-agent/service';
import type {Stage7StorageTaskService} from '../modules/storage-agent/task-service';
import type {Stage7LocalChangeService} from '../modules/storage-agent/local-change-service';
import type {Stage7ConflictService} from '../modules/storage-agent/conflict-service';
import {createRequestHandler} from './app';
import {AppError} from './errors';

const authenticated = {sessionId: 'session', user: {id: '10000000-0000-4000-8000-000000000001',
  email: 'chair@example.com', displayName: 'Chair', status: 'ACTIVE', isSystemAdmin: false,
  sessionVersion: 1, mustChangePassword: false, createdAt: '2026-08-13T00:00:00.000Z', disabledAt: null}} as const;

class TestResponse extends EventEmitter {
  statusCode = 200; headersSent = false; body = ''; readonly headers = new Map<string, unknown>();
  setHeader(name: string, value: unknown): this {this.headers.set(name, value); return this;}
  write(chunk: Uint8Array | string): boolean {this.headersSent = true;
    this.body += Buffer.from(chunk).toString('utf8'); return true;}
  end(body?: string): this {this.headersSent = true; if (body !== undefined) this.body += body;
    queueMicrotask(() => this.emit('finish')); return this;}
  destroy(): this {return this;}
}

async function send(storageAgent: Stage7StorageAgentService, options: {
  method: 'GET' | 'POST'; path: string; body?: unknown; rawBody?: Buffer; headers?: Record<string, string>;
  identity?: IdentityService; storageTasks?: Stage7StorageTaskService; storageLocalChanges?: Stage7LocalChangeService;
  storageConflicts?: Stage7ConflictService;
}) {
  const identity = options.identity ?? ({authenticate: vi.fn(async () => authenticated)} as unknown as IdentityService);
  const logs: string[] = [];
  const handler = createRequestHandler({health: {ready: async () => ({ready: true, checks: {
    database: {status: 'ok', migrationVersion: 20}, storage: {status: 'ok'}}})},
  logger: createLogger(line => logs.push(line)), version: 'test', databaseMigrationVersion: 20,
  identity, storageAgent, storageTasks: options.storageTasks, storageLocalChanges: options.storageLocalChanges,
  storageConflicts: options.storageConflicts,
  allowedOrigins: ['https://quorum.example.com']});
  const chunks = options.rawBody ? [options.rawBody]
    : options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))];
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

  it('forwards fenced manifest cursors and task claims without browser authentication', async () => {
    const manifest = vi.fn(async () => ({events: [], nextSequence: 12, hasMore: false}));
    const claim = vi.fn(async () => ({id: 'task', status: 'IN_PROGRESS'}));
    const storageTasks = {manifest, claim} as unknown as Stage7StorageTaskService;
    const service = {} as Stage7StorageAgentService;
    const headers = {authorization: 'QuorumAgent qsa1.device.secret', 'x-storage-lease-generation': '7'};
    const listed = await send(service, {method: 'GET', path: '/api/v1/storage-agent/manifest?after=12&limit=25',
      headers, storageTasks});
    expect(listed.response.statusCode).toBe(200);
    expect(manifest).toHaveBeenCalledWith('qsa1.device.secret', 7, 12, 25);
    const body = {leaseGeneration: 7, fileRevision: 3, requestId: '40000000-0000-4000-8000-000000000001'};
    const claimed = await send(service, {method: 'POST',
      path: '/api/v1/storage-agent/tasks/30000000-0000-4000-8000-000000000001/claim', body,
      headers: {authorization: headers.authorization}, storageTasks});
    expect(claimed.response.statusCode).toBe(200);
    expect(claim).toHaveBeenCalledWith('qsa1.device.secret', '30000000-0000-4000-8000-000000000001', body);
    expect(listed.identity.authenticate).not.toHaveBeenCalled();
  });

  it('forwards local changes through Agent credentials without a browser Session', async () => {
    const submit = vi.fn(async () => { throw new AppError({code: 'CHAIR_DECISION_REQUIRED',
      message: 'Conflict.', details: {conflictId: 'conflict', reasonCode: 'MANIFEST_STALE'}}); });
    const storageLocalChanges = {submit} as unknown as Stage7LocalChangeService;
    const identity = {authenticate: vi.fn()} as unknown as IdentityService;
    const body = {leaseGeneration: 7, requestId: '40000000-0000-4000-8000-000000000001',
      manifestSequence: 11, change: {kind: 'DELETE', fileEntryId: '50000000-0000-4000-8000-000000000001',
        baseRevision: 2}};
    const result = await send({} as Stage7StorageAgentService, {method: 'POST',
      path: '/api/v1/storage-agent/local-changes', body,
      headers: {authorization: 'QuorumAgent qsa1.device.secret'}, identity, storageLocalChanges});
    expect(result.response.statusCode).toBe(422);
    expect(JSON.parse(result.response.body).error).toMatchObject({code: 'CHAIR_DECISION_REQUIRED',
      details: {conflictId: 'conflict'}});
    expect(submit).toHaveBeenCalledWith('qsa1.device.secret', body,
      expect.objectContaining({requestId: expect.any(String)}));
    expect(identity.authenticate).not.toHaveBeenCalled();
  });

  it('separates Agent conflict polling from CSRF-protected Chair resolution', async () => {
    const committeeId = '20000000-0000-4000-8000-000000000001';
    const conflictId = '30000000-0000-4000-8000-000000000001';
    const listForAgent = vi.fn(async () => [{id: conflictId, status: 'RESOLVED'}]);
    const list = vi.fn(async () => [{id: conflictId, status: 'PENDING'}]);
    const resolve = vi.fn(async () => ({id: conflictId, status: 'RESOLVED'}));
    const storageConflicts = {listForAgent, list, resolve} as unknown as Stage7ConflictService;
    const agent = await send({} as Stage7StorageAgentService, {method: 'GET',
      path: '/api/v1/storage-agent/conflicts', headers: {authorization: 'QuorumAgent qsa1.device.secret',
        'x-storage-lease-generation': '7'}, storageConflicts});
    expect(agent.response.statusCode).toBe(200);
    expect(listForAgent).toHaveBeenCalledWith('qsa1.device.secret', 7);
    const browser = await send({} as Stage7StorageAgentService, {method: 'GET',
      path: `/api/v1/committees/${committeeId}/storage-agent-conflicts`, storageConflicts});
    expect(browser.response.statusCode).toBe(200); expect(list).toHaveBeenCalledWith(authenticated, committeeId);
    const body = {baseRevision: 1, leaseGeneration: 7, fileRevision: 3, action: 'ACCEPT_LOCAL'};
    const decided = await send({} as Stage7StorageAgentService, {method: 'POST',
      path: `/api/v1/committees/${committeeId}/storage-agent-conflicts/${conflictId}/resolve`, body,
      headers: {'idempotency-key': 'resolve-key'}, storageConflicts});
    expect(decided.response.statusCode).toBe(200);
    expect(resolve).toHaveBeenCalledWith(authenticated, committeeId, conflictId, body, 'resolve-key',
      expect.objectContaining({requestId: expect.any(String)}));
  });

  it('streams Agent upload bytes and provider blob bytes through task-scoped headers', async () => {
    const receiveContent = vi.fn(async (_credential, input) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input.source) chunks.push(Buffer.from(chunk));
      return {id: input.taskId, status: 'IN_PROGRESS', received: Buffer.concat(chunks).toString('utf8')};
    });
    const streamBlob = vi.fn(async (_credential, input, destination) => {
      expect(input).toMatchObject({blobId: '50000000-0000-4000-8000-000000000001', leaseGeneration: 8,
        fileRevision: 4, claimToken: '60000000-0000-4000-8000-000000000001'});
      destination.start({sizeBytes: 4, sha256: 'a'.repeat(64)});
      await destination.write(Buffer.from('blob'));
    });
    const storageTasks = {receiveContent, streamBlob} as unknown as Stage7StorageTaskService;
    const service = {} as Stage7StorageAgentService;
    const headers = {authorization: 'QuorumAgent qsa1.device.secret',
      'x-storage-task-id': '30000000-0000-4000-8000-000000000001',
      'x-storage-lease-generation': '8', 'x-storage-file-revision': '4',
      'x-storage-task-claim': '60000000-0000-4000-8000-000000000001',
      'x-content-sha256': 'a'.repeat(64), 'content-length': '4'};
    const uploaded = await send(service, {method: 'POST', path: '/api/v1/storage-agent/blobs',
      rawBody: Buffer.from('blob'), headers, storageTasks});
    expect(uploaded.response.statusCode).toBe(200);
    expect(receiveContent).toHaveBeenCalledWith('qsa1.device.secret', expect.objectContaining({
      taskId: headers['x-storage-task-id'], leaseGeneration: 8, fileRevision: 4,
      claimToken: headers['x-storage-task-claim'], expectedSha256: headers['x-content-sha256'], contentLength: 4
    }));
    const downloaded = await send(service, {method: 'GET',
      path: '/api/v1/storage-agent/blobs/50000000-0000-4000-8000-000000000001', headers, storageTasks});
    expect(downloaded.response.statusCode).toBe(200);
    expect(downloaded.response.body).toBe('blob');
    expect(downloaded.response.headers.get('x-content-sha256')).toBe('a'.repeat(64));
  });
});
