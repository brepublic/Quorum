// @vitest-environment node

import {EventEmitter, once} from 'node:events';
import {Readable} from 'node:stream';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {describe, expect, it, vi} from 'vitest';
import {createLogger} from '../logger';
import type {IdentityService} from '../modules/identity/service';
import type {DelegateFileService} from '../modules/delegate-files/service';
import {createRequestHandler} from './app';

class TestResponse extends EventEmitter {
  statusCode = 200; headersSent = false; body = ''; readonly headers = new Map<string, unknown>();
  setHeader(name: string, value: unknown): this {this.headers.set(name.toLowerCase(), value); return this;}
  write(chunk: Uint8Array | string): boolean {this.headersSent = true; this.body += Buffer.from(chunk).toString(); return true;}
  end(body?: string): this {this.headersSent = true; if (body) this.body += body; queueMicrotask(() => this.emit('finish')); return this;}
  destroy(): this {return this;}
}

async function send(service: DelegateFileService, options: {path: string; method?: string; body?: object;
  cookie?: string; csrf?: string}) {
  const identity = {authenticate: vi.fn()} as unknown as IdentityService;
  const handler = createRequestHandler({health: {ready: async () => ({ready: true, checks: {
    database: {status: 'ok', migrationVersion: 48}, storage: {status: 'ok'}}})}, logger: createLogger(() => undefined),
  version: 'test', databaseMigrationVersion: 48, identity, delegateFiles: service,
  allowedOrigins: ['https://quorum.example.com']});
  const incoming = Readable.from(options.body ? [Buffer.from(JSON.stringify(options.body))] : []) as unknown as IncomingMessage;
  Object.assign(incoming, {method: options.method ?? 'GET', url: options.path, headers: {
    origin: 'https://quorum.example.com', cookie: options.cookie,
    ...(options.csrf ? {'x-csrf-token': options.csrf} : {}), 'idempotency-key': 'delegate-key'
  }, socket: {remoteAddress: '127.0.0.1'}});
  const response = new TestResponse(); const finished = once(response, 'finish');
  handler(incoming, response as unknown as ServerResponse); await finished; return response;
}

const snapshot = {committeeId: '20000000-0000-4000-8000-000000000001', committeeName: '委员会', shareId: 'share',
  claimedSeat: null, eligibleSeats: [], mayUpload: false, chairHostHealthy: true, eventSequence: 4, files: []};

describe('delegate file HTTP boundary', () => {
  it('bootstraps a capability link without an account session', async () => {
    const bootstrap = vi.fn(async () => snapshot);
    const response = await send({bootstrap} as unknown as DelegateFileService,
      {path: '/api/v1/delegate-files/bootstrap', method: 'POST', body: {capability: 'a'.repeat(43)}});
    expect(response.statusCode).toBe(200);
    expect(bootstrap).toHaveBeenCalledWith('a'.repeat(43), undefined);
  });

  it('keeps delegate credentials in cookies and out of the JSON response', async () => {
    const bootstrap = vi.fn(async () => snapshot);
    const claim = vi.fn(async () => ({...snapshot, claimedSeat: {id: 'seat', displayName: '中国'},
      sessionToken: 'secret-session', csrfToken: 'secret-csrf'}));
    const response = await send({bootstrap, claim} as unknown as DelegateFileService,
      {path: '/api/v1/delegate-files/claim', method: 'POST', body: {capability: 'a'.repeat(43),
        seatId: '30000000-0000-4000-8000-000000000001'}});
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('secret-session'); expect(response.body).not.toContain('secret-csrf');
    expect(response.headers.get('set-cookie')).toEqual(expect.arrayContaining([
      expect.stringContaining('__Host-quorum_delegate_files=secret-session;'),
      expect.stringContaining('__Host-quorum_delegate_files_csrf=secret-csrf;')
    ]));
  });

  it('requires the independent delegate CSRF cookie for uploads', async () => {
    const createUpload = vi.fn(async () => ({id: 'upload'}));
    const service = {createUpload} as unknown as DelegateFileService;
    const body = {logicalName: 'draft.pdf', originalName: 'draft.pdf', mediaType: 'application/pdf',
      expectedSizeBytes: 3, sha256: 'a'.repeat(64), fileType: 'WORKING_PAPER'};
    const rejected = await send(service, {path: '/api/v1/delegate-files/uploads', method: 'POST', body,
      cookie: '__Host-quorum_delegate_files=credential; __Host-quorum_delegate_files_csrf=right', csrf: 'wrong'});
    expect(rejected.statusCode).toBe(403); expect(createUpload).not.toHaveBeenCalled();
    const accepted = await send(service, {path: '/api/v1/delegate-files/uploads', method: 'POST', body,
      cookie: '__Host-quorum_delegate_files=credential; __Host-quorum_delegate_files_csrf=right', csrf: 'right'});
    expect(accepted.statusCode).toBe(201);
    expect(createUpload).toHaveBeenCalledWith('credential', body, 'delegate-key', expect.anything());
  });
});
