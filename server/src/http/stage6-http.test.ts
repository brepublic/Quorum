// @vitest-environment node

import {EventEmitter, once} from 'node:events';
import {Readable} from 'node:stream';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {describe, expect, it, vi} from 'vitest';
import {createLogger} from '../logger';
import type {IdentityService} from '../modules/identity/service';
import type {Stage6UploadService} from '../modules/storage/upload-service';
import type {Stage6ProviderCommitService} from '../modules/storage/provider-commit-service';
import type {Stage6S3ConfigService} from '../modules/storage/s3-config-service';
import type {Stage6StorageService} from '../modules/storage/service';
import type {Stage6FileService} from '../modules/storage/file-service';
import type {Stage6MigrationService} from '../modules/storage/migration-service';
import {createRequestHandler} from './app';

const authenticated = {sessionId: 'session', user: {id: '10000000-0000-4000-8000-000000000001',
  email: 'user@example.com', displayName: 'User', status: 'ACTIVE', isSystemAdmin: false,
  sessionVersion: 1, mustChangePassword: false, createdAt: '2026-08-13T00:00:00.000Z', disabledAt: null}} as const;

class TestResponse extends EventEmitter {
  statusCode = 200; headersSent = false; body = ''; readonly headers = new Map<string, unknown>();
  setHeader(name: string, value: unknown): this {this.headers.set(name, value); return this;}
  write(chunk: Uint8Array | string): boolean {this.headersSent = true; this.body += Buffer.from(chunk).toString(); return true;}
  end(body?: string): this {this.headersSent = true; if (body !== undefined) this.body += body;
    queueMicrotask(() => this.emit('finish')); return this;}
  destroy(): this {return this;}
}

async function send(uploads: Stage6UploadService, options: {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; chunks: Buffer[]; headers?: Record<string, string>;
}, providerCommits?: Stage6ProviderCommitService, extras: {
  s3Configs?: Stage6S3ConfigService; storage?: Stage6StorageService; files?: Stage6FileService;
  storageMigrations?: Stage6MigrationService;
} = {}) {
  const identity = {authenticate: vi.fn(async () => authenticated)} as unknown as IdentityService;
  const handler = createRequestHandler({health: {ready: async () => ({ready: true, checks: {
    database: {status: 'ok', migrationVersion: 14}, storage: {status: 'ok'}}})},
  logger: createLogger(() => undefined), version: 'test', databaseMigrationVersion: 14,
  identity, uploads, providerCommits, ...extras, allowedOrigins: ['https://quorum.example.com']});
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
      chunks: [Buffer.from('{}')]}, {commitUpload} as unknown as Stage6ProviderCommitService);
    expect(response.statusCode).toBe(201);
    expect(commitUpload).toHaveBeenCalledWith(authenticated, '30000000-0000-4000-8000-000000000001',
      {}, 'upload-key', expect.objectContaining({requestId: expect.any(String)}));
  });

  it('keeps S3 configuration and binding behind authenticated role-aware services', async () => {
    const create = vi.fn(async () => ({id: 'config', displayName: '对象存储'}));
    const configResponse = await send({} as Stage6UploadService, {method: 'POST',
      path: '/api/v1/admin/storage-provider-configs/s3', chunks: [Buffer.from(JSON.stringify({name: 'config'}))]},
    undefined, {s3Configs: {create} as unknown as Stage6S3ConfigService});
    expect(configResponse.statusCode).toBe(201);
    expect(create).toHaveBeenCalledWith(authenticated, {name: 'config'}, 'upload-key', expect.anything());

    const createS3Binding = vi.fn(async () => ({id: 'binding', providerType: 'S3_COMPATIBLE'}));
    const body = {baseRevision: 2, providerConfigId: '40000000-0000-4000-8000-000000000001'};
    const bindingResponse = await send({} as Stage6UploadService, {method: 'POST',
      path: '/api/v1/committees/20000000-0000-4000-8000-000000000001/storage-bindings/s3',
      chunks: [Buffer.from(JSON.stringify(body))]}, undefined,
    {storage: {createS3Binding} as unknown as Stage6StorageService});
    expect(bindingResponse.statusCode).toBe(201);
    expect(createS3Binding).toHaveBeenCalledWith(authenticated, '20000000-0000-4000-8000-000000000001',
      body, 'upload-key', expect.anything());
  });

  it('routes file listing, detail, review, publication, and deletion through session-aware services', async () => {
    const files = {list: vi.fn(async () => [{id: 'file'}]), get: vi.fn(async () => ({id: 'file'})),
      submitForReview: vi.fn(async () => ({id: 'file', status: 'PENDING_REVIEW'})),
      publish: vi.fn(async () => ({id: 'file', status: 'PUBLISHED'}))} as unknown as Stage6FileService;
    const storage = {deleteFile: vi.fn(async () => ({id: 'tombstone'}))} as unknown as Stage6StorageService;
    const committeeId = '20000000-0000-4000-8000-000000000001';
    const fileId = '30000000-0000-4000-8000-000000000001';
    expect((await send({} as Stage6UploadService, {method: 'GET', path: `/api/v1/committees/${committeeId}/files`,
      chunks: []}, undefined, {files})).statusCode).toBe(200);
    expect((files.list as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(authenticated, committeeId);
    expect((await send({} as Stage6UploadService, {method: 'GET', path: `/api/v1/files/${fileId}`,
      chunks: []}, undefined, {files})).statusCode).toBe(200);
    expect((files.get as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(authenticated, fileId);

    const reviewBody = {baseRevision: 1};
    await send({} as Stage6UploadService, {method: 'POST', path: `/api/v1/files/${fileId}/submit-review`,
      chunks: [Buffer.from(JSON.stringify(reviewBody))]}, undefined, {files});
    expect((files.submitForReview as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(authenticated, fileId,
      reviewBody, 'upload-key', expect.objectContaining({requestId: expect.any(String)}));
    await send({} as Stage6UploadService, {method: 'POST', path: `/api/v1/files/${fileId}/publish`,
      chunks: [Buffer.from(JSON.stringify({baseRevision: 2}))]}, undefined, {files});
    expect((files.publish as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(authenticated, fileId,
      {baseRevision: 2}, 'upload-key', expect.anything());
    await send({} as Stage6UploadService, {method: 'DELETE', path: `/api/v1/files/${fileId}`,
      chunks: [Buffer.from(JSON.stringify({baseRevision: 3}))]}, undefined, {storage});
    expect((storage.deleteFile as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(authenticated, fileId,
      {baseRevision: 3}, 'upload-key', expect.anything());
  });

  it('streams download bytes with the service-provided safe headers', async () => {
    const fileId = '30000000-0000-4000-8000-000000000001';
    const download = vi.fn(async () => ({file: {id: fileId}, headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="download.svg"',
      'x-content-type-options': 'nosniff'
    }, content: (async function* () {yield Buffer.from('first-'); yield Buffer.from('second');})()}));
    const response = await send({} as Stage6UploadService, {method: 'GET',
      path: `/api/v1/files/${fileId}/download`, chunks: []}, undefined,
    {files: {download} as unknown as Stage6FileService});
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('first-second');
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="download.svg"');
    expect(download).toHaveBeenCalledWith(authenticated, fileId);
  });

  it('routes provider migration creation and commands through the same write boundary', async () => {
    const committeeId = '20000000-0000-4000-8000-000000000001';
    const migrationId = '50000000-0000-4000-8000-000000000001';
    const list = vi.fn(async () => [{id: migrationId}]);
    const create = vi.fn(async () => ({id: migrationId, status: 'COPYING'}));
    const retry = vi.fn(async () => ({id: migrationId, status: 'COPYING'}));
    const confirm = vi.fn(async () => ({id: migrationId, status: 'COMPLETED'}));
    const cancel = vi.fn(async () => ({id: migrationId, status: 'CANCELLED'}));
    const service = {list, create, retry, confirm, cancel} as unknown as Stage6MigrationService;
    const listed = await send({} as Stage6UploadService, {method: 'GET',
      path: `/api/v1/committees/${committeeId}/storage-migrations`, chunks: []}, undefined,
    {storageMigrations: service});
    expect(listed.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(authenticated, committeeId);

    const createBody = {baseRevision: 4, targetProviderType: 'S3_COMPATIBLE',
      targetProviderConfigId: '60000000-0000-4000-8000-000000000001'};
    await send({} as Stage6UploadService, {method: 'POST',
      path: `/api/v1/committees/${committeeId}/storage-migrations`,
      chunks: [Buffer.from(JSON.stringify(createBody))]}, undefined, {storageMigrations: service});
    expect(create).toHaveBeenCalledWith(authenticated, committeeId, createBody, 'upload-key', expect.anything());

    for (const [command, method] of [['retry', retry], ['confirm', confirm], ['cancel', cancel]] as const) {
      const body = {baseRevision: 2};
      await send({} as Stage6UploadService, {method: 'POST',
        path: `/api/v1/storage-migrations/${migrationId}/${command}`,
        chunks: [Buffer.from(JSON.stringify(body))]}, undefined, {storageMigrations: service});
      expect(method).toHaveBeenCalledWith(authenticated, migrationId, body, 'upload-key', expect.anything());
    }
  });
});
