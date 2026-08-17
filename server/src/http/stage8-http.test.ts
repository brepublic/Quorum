// @vitest-environment node

import {EventEmitter, once} from 'node:events';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {Readable} from 'node:stream';
import {describe, expect, it, vi} from 'vitest';
import {createLogger} from '../logger';
import type {IdentityService} from '../modules/identity/service';
import type {Stage8ArchiveService} from '../modules/operations/archive-service';
import type {Stage8DeletionService} from '../modules/operations/deletion-service';
import {createRequestHandler} from './app';

const committeeId = '20000000-0000-4000-8000-000000000001';
const authenticated = {sessionId: 'session', user: {id: '10000000-0000-4000-8000-000000000001',
  email: 'owner@example.com', displayName: 'Owner', status: 'ACTIVE', isSystemAdmin: false,
  sessionVersion: 1, mustChangePassword: false, createdAt: '2026-08-13T00:00:00Z', disabledAt: null}} as const;

class TestResponse extends EventEmitter {
  statusCode = 200; headersSent = false; body = ''; readonly headers = new Map<string, string | number | readonly string[]>();
  setHeader(name: string, value: string | number | readonly string[]): this {this.headers.set(name.toLowerCase(), value); return this;}
  write(value: string | Buffer): boolean {this.headersSent = true; this.body += value.toString(); return true;}
  end(value?: string): this {if (value) this.body += value; this.headersSent = true; queueMicrotask(() => this.emit('finish')); return this;}
  destroy(): this {return this;}
}

describe('stage 8 archive HTTP boundary', () => {
  it('requires the destructive write boundary and returns the durable deletion job', async () => {
    const identity = {authenticate: vi.fn(async () => authenticated)} as unknown as IdentityService;
    const requestDeletion = vi.fn(async () => ({id: '30000000-0000-4000-8000-000000000001', committeeId,
      status: 'PENDING' as const, requestedAt: '2026-08-14T00:00:00.000Z', completedAt: null, failureCode: null}));
    const handler = createRequestHandler({health: {ready: async () => ({ready: true,
      checks: {database: {status: 'ok', migrationVersion: 24}, storage: {status: 'ok'}}})},
    logger: createLogger(() => undefined), version: 'test', databaseMigrationVersion: 24, identity,
    archives: {} as Stage8ArchiveService,
    committeeDeletions: {requestDeletion} as unknown as Stage8DeletionService,
    allowedOrigins: ['https://quorum.example']});
    const body = {baseRevision: 9, confirmationName: 'Security Council'};
    const incoming = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
    Object.assign(incoming, {method: 'DELETE', url: `/api/v1/committees/${committeeId}`, headers: {
      origin: 'https://quorum.example', cookie: '__Host-quorum_session=session; __Host-quorum_csrf=csrf',
      'x-csrf-token': 'csrf', 'idempotency-key': 'delete-key'}, socket: {remoteAddress: '127.0.0.1'}});
    const response = new TestResponse(); const finished = once(response, 'finish');
    handler(incoming, response as unknown as ServerResponse); await finished;
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body).data).toEqual(expect.objectContaining({status: 'PENDING'}));
    expect(requestDeletion).toHaveBeenCalledWith(authenticated, committeeId, body, 'delete-key',
      expect.objectContaining({sourceIp: '127.0.0.1'}));
  });

  it('rejects deletion before authentication when Origin is missing', async () => {
    const identity = {authenticate: vi.fn(async () => authenticated)} as unknown as IdentityService;
    const requestDeletion = vi.fn();
    const handler = createRequestHandler({health: {ready: async () => ({ready: true,
      checks: {database: {status: 'ok', migrationVersion: 24}, storage: {status: 'ok'}}})},
    logger: createLogger(() => undefined), version: 'test', databaseMigrationVersion: 24, identity,
    archives: {} as Stage8ArchiveService,
    committeeDeletions: {requestDeletion} as unknown as Stage8DeletionService,
    allowedOrigins: ['https://quorum.example']});
    const incoming = Readable.from(['{}']) as unknown as IncomingMessage;
    Object.assign(incoming, {method: 'DELETE', url: `/api/v1/committees/${committeeId}`,
      headers: {cookie: '__Host-quorum_session=session'}, socket: {remoteAddress: '127.0.0.1'}});
    const response = new TestResponse(); const finished = once(response, 'finish');
    handler(incoming, response as unknown as ServerResponse); await finished;
    expect(response.statusCode).toBe(403); expect(requestDeletion).not.toHaveBeenCalled();
  });

  it('requires Session and returns an attachment stream without CSRF on GET', async () => {
    const identity = {authenticate: vi.fn(async () => authenticated)} as unknown as IdentityService;
    const exportCommittee = vi.fn(async () => ({fileName: `quorum-committee-${committeeId}.jsonl`,
      content: Readable.from(['{"type":"manifest"}\n', '{"type":"complete"}\n'])}));
    const handler = createRequestHandler({health: {ready: async () => ({ready: true, checks: {database: {status: 'ok', migrationVersion: 23}, storage: {status: 'ok'}}})},
      logger: createLogger(() => undefined), version: 'test', databaseMigrationVersion: 23, identity,
      archives: {exportCommittee} as unknown as Stage8ArchiveService});
    const incoming = Readable.from([]) as unknown as IncomingMessage;
    Object.assign(incoming, {method: 'GET', url: `/api/v1/committees/${committeeId}/export`,
      headers: {cookie: '__Host-quorum_session=session'}, socket: {remoteAddress: '127.0.0.1'}});
    const response = new TestResponse(); const finished = once(response, 'finish');
    handler(incoming, response as unknown as ServerResponse); await finished;
    expect(response.statusCode).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="quorum-committee-${committeeId}.jsonl"`);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.body).toContain('"type":"complete"');
    expect(exportCommittee).toHaveBeenCalledWith(authenticated, committeeId);
  });

  it('destroys the archive stream when a backpressured client disconnects', async () => {
    let finalized = false;
    const content = Readable.from((async function* () {
      try {yield '{"type":"manifest"}\n'; yield '{"type":"complete"}\n';}
      finally {finalized = true;}
    })());
    const identity = {authenticate: vi.fn(async () => authenticated)} as unknown as IdentityService;
    const handler = createRequestHandler({health: {ready: async () => ({ready: true,
      checks: {database: {status: 'ok', migrationVersion: 23}, storage: {status: 'ok'}}})},
      logger: createLogger(() => undefined), version: 'test', databaseMigrationVersion: 23, identity,
      archives: {exportCommittee: vi.fn(async () => ({fileName: 'archive.jsonl', content}))} as unknown as Stage8ArchiveService});
    const incoming = Readable.from([]) as unknown as IncomingMessage;
    Object.assign(incoming, {method: 'GET', url: `/api/v1/committees/${committeeId}/export`,
      headers: {cookie: '__Host-quorum_session=session'}, socket: {remoteAddress: '127.0.0.1'}});
    const response = new TestResponse(); const write = vi.spyOn(response, 'write').mockReturnValue(false);
    handler(incoming, response as unknown as ServerResponse);
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    response.emit('close');
    await vi.waitFor(() => expect(finalized).toBe(true));
    expect(content.destroyed).toBe(true);
  });
});
