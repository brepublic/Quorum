// @vitest-environment node

import {EventEmitter, once} from 'node:events';
import {Readable} from 'node:stream';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {describe, expect, it, vi} from 'vitest';
import {createLogger} from '../logger';
import type {IdentityService} from '../modules/identity/service';
import type {Stage6UploadService} from '../modules/storage/upload-service';
import type {Stage6ServerVolumeService} from '../modules/storage/server-volume-service';
import {createRequestHandler} from './app';

const authenticated = {sessionId: 'session', user: {id: '10000000-0000-4000-8000-000000000001',
  email: 'user@example.com', displayName: 'User', status: 'ACTIVE', isSystemAdmin: false,
  sessionVersion: 1, mustChangePassword: false, createdAt: '2026-08-13T00:00:00.000Z', disabledAt: null}} as const;

class TestResponse extends EventEmitter {
  statusCode = 200; headersSent = false; body = ''; readonly headers = new Map<string, unknown>();
  setHeader(name: string, value: unknown): this {this.headers.set(name, value); return this;}
  end(body?: string): this {this.headersSent = true; this.body = body ?? ''; queueMicrotask(() => this.emit('finish')); return this;}
  destroy(): this {return this;}
}

async function send(uploads: Stage6UploadService, options: {
  method: 'POST' | 'PUT'; path: string; chunks: Buffer[]; headers?: Record<string, string>;
}, serverVolume?: Stage6ServerVolumeService) {
  const identity = {authenticate: vi.fn(async () => authenticated)} as unknown as IdentityService;
  const handler = createRequestHandler({health: {ready: async () => ({ready: true, checks: {
    database: {status: 'ok', migrationVersion: 14}, storage: {status: 'ok'}}})},
  logger: createLogger(() => undefined), version: 'test', databaseMigrationVersion: 14,
  identity, uploads, serverVolume, allowedOrigins: ['https://quorum.example.com']});
  const incoming = Readable.from(options.chunks) as unknown as IncomingMessage;
  Object.assign(incoming, {method: options.method, url: options.path, headers: {
    origin: 'https://quorum.example.com',
    cookie: '__Host-quorum_session=session; __Host-quorum_csrf=csrf',
    'x-csrf-token': 'csrf',
    'idempotency-key': 'upload-key',
    ...options.headers
  }, socket: {remoteAddress: '127.0.0.1'}});
  const response = new TestResponse();
  const finished = once(response, 'finish');
  handler(incoming, response as unknown as ServerResponse);
  await finished;
  return response;
}

describe('stage 6 upload HTTP boundary', () => {
  it('creates an upload from Session-authenticated metadata', async () => {
    const createUpload = vi.fn(async () => ({id: 'upload', status: 'CREATED'}));
    const uploads = {createUpload} as unknown as Stage6UploadService;
    const body = {logicalName: '工作文件', originalName: '../../notes.pdf', mediaType: 'application/pdf',
      expectedSizeBytes: 4, sha256: 'a'.repeat(64)};
    const response = await send(uploads, {method: 'POST',
      path: '/api/v1/committees/20000000-0000-4000-8000-000000000001/file-uploads',
      chunks: [Buffer.from(JSON.stringify(body))]});
    expect(response.statusCode).toBe(201);
    expect(createUpload).toHaveBeenCalledWith(authenticated, '20000000-0000-4000-8000-000000000001',
      body, 'upload-key', expect.objectContaining({requestId: expect.any(String)}));
  });

  it('passes the raw request stream without buffering it as JSON', async () => {
    const receiveContent = vi.fn(async (_auth, _id, source: AsyncIterable<Uint8Array>, _key, length) => {
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(Buffer.from(chunk));
      return {id: 'upload', status: 'STAGED', receivedSizeBytes: Buffer.concat(chunks).length, length};
    });
    const uploads = {receiveContent} as unknown as Stage6UploadService;
    const response = await send(uploads, {method: 'PUT',
      path: '/api/v1/file-uploads/30000000-0000-4000-8000-000000000001/content',
      chunks: [Buffer.from([0, 1]), Buffer.from([2, 3])], headers: {'content-length': '4'}});
    expect(response.statusCode).toBe(200);
    expect(receiveContent).toHaveBeenCalledWith(authenticated, '30000000-0000-4000-8000-000000000001',
      expect.anything(), 'upload-key', 4, expect.objectContaining({requestId: expect.any(String)}));
    expect(JSON.parse(response.body)).toEqual(expect.objectContaining({
      data: expect.objectContaining({status: 'STAGED', receivedSizeBytes: 4})
    }));
  });

  it('rejects invalid Content-Length before invoking the storage service', async () => {
    const receiveContent = vi.fn();
    const response = await send({receiveContent} as unknown as Stage6UploadService, {method: 'PUT',
      path: '/api/v1/file-uploads/30000000-0000-4000-8000-000000000001/content',
      chunks: [Buffer.from('data')], headers: {'content-length': '-1'}});
    expect(response.statusCode).toBe(400);
    expect(receiveContent).not.toHaveBeenCalled();
  });

  it('keeps Origin, CSRF, and idempotency checks on the streaming route', async () => {
    const receiveContent = vi.fn();
    const response = await send({receiveContent} as unknown as Stage6UploadService, {method: 'PUT',
      path: '/api/v1/file-uploads/30000000-0000-4000-8000-000000000001/content',
      chunks: [Buffer.from('data')], headers: {origin: 'https://attacker.example.com'}});
    expect(response.statusCode).toBe(403);
    expect(receiveContent).not.toHaveBeenCalled();
  });

  it('routes SERVER_VOLUME commit through Session, CSRF, and idempotency', async () => {
    const commitUpload = vi.fn(async () => ({id: 'file', currentVersion: {id: 'version'}}));
    const response = await send({} as Stage6UploadService, {method: 'POST',
      path: '/api/v1/file-uploads/30000000-0000-4000-8000-000000000001/commit',
      chunks: [Buffer.from('{}')]}, {commitUpload} as unknown as Stage6ServerVolumeService);
    expect(response.statusCode).toBe(201);
    expect(commitUpload).toHaveBeenCalledWith(authenticated, '30000000-0000-4000-8000-000000000001',
      {}, 'upload-key', expect.objectContaining({requestId: expect.any(String)}));
  });
});
