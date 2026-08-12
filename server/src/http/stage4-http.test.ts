// @vitest-environment node

import {EventEmitter, once} from 'node:events';
import {Readable} from 'node:stream';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {describe, expect, it, vi} from 'vitest';
import {createLogger} from '../logger';
import type {IdentityService} from '../modules/identity/service';
import type {Stage4Service} from '../modules/stage4/service';
import {createRequestHandler} from './app';
import {AppError} from './errors';

const authenticated = {sessionId: 'session', user: {id: '10000000-0000-4000-8000-000000000001',
  email: 'user@example.com', displayName: 'User', status: 'ACTIVE', isSystemAdmin: false,
  sessionVersion: 1, mustChangePassword: false, createdAt: '2026-08-13T00:00:00.000Z', disabledAt: null}} as const;
const protectedHeaders = {origin: 'https://quorum.example.com',
  cookie: '__Host-quorum_session=session; __Host-quorum_csrf=csrf', 'x-csrf-token': 'csrf',
  'idempotency-key': 'request-one'};

class TestResponse extends EventEmitter {
  statusCode = 200; headersSent = false; body = '';
  readonly headers = new Map<string, string | number | readonly string[]>();
  setHeader(name: string, value: string | number | readonly string[]): this {this.headers.set(name.toLowerCase(), value); return this;}
  end(body?: string): this {this.headersSent = true; this.body = body ?? ''; queueMicrotask(() => this.emit('finish')); return this;}
  destroy(): this {return this;}
}

function identity(): IdentityService {
  return {authenticate: vi.fn(async token => {
    if (!token) throw new AppError({code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required.'});
    return authenticated;
  })} as unknown as IdentityService;
}

function domain(overrides: Record<string, unknown> = {}): Stage4Service {
  return {listCommittees: vi.fn(async () => []), createCommittee: vi.fn(async (_auth, body) => ({id: 'committee', name: body.name})),
    listCountryTemplates: vi.fn(async () => []), createCountryTemplate: vi.fn(async () => ({id: 'country-template'})),
    deleteCountryTemplate: vi.fn(async () => undefined), createSeat: vi.fn(async () => ({id: 'seat'})), ...overrides} as unknown as Stage4Service;
}

async function request(stage4: Stage4Service, options: {path: string; method?: string; headers?: Record<string, string>; body?: unknown}) {
  const handler = createRequestHandler({health: {ready: async () => ({ready: true, checks: {database: {status: 'ok', migrationVersion: 4},
    storage: {status: 'ok'}}})}, logger: createLogger(() => undefined), version: 'test', databaseMigrationVersion: 4,
    identity: identity(), stage4, allowedOrigins: ['https://quorum.example.com']});
  const text = options.body ? JSON.stringify(options.body) : '';
  const incoming = Readable.from(text ? [Buffer.from(text)] : []) as unknown as IncomingMessage;
  Object.assign(incoming, {method: options.method ?? 'GET', url: options.path, headers: options.headers ?? {},
    socket: {remoteAddress: '127.0.0.1'}});
  const response = new TestResponse(); const finished = once(response, 'finish');
  handler(incoming, response as unknown as ServerResponse); await finished;
  return {status: response.statusCode, text: response.body};
}

describe('stage 4 template and seat HTTP boundary', () => {
  it('requires Session for account templates and never accepts an account owner from the body', async () => {
    const stage4 = domain();
    expect((await request(stage4, {path: '/api/v1/country-templates'})).status).toBe(401);
    const response = await request(stage4, {path: '/api/v1/country-templates', method: 'POST', headers: protectedHeaders,
      body: {names: {en: 'Mine'}, defaultLanguage: 'en', countryLanguages: ['en'], countries: [], ownerUserId: 'attacker'}});
    expect(response.status).toBe(201);
    expect(stage4.createCountryTemplate).toHaveBeenCalledWith(authenticated,
      expect.not.objectContaining({actorUserId: expect.anything()}), 'request-one', expect.objectContaining({requestId: expect.any(String)}));
  });

  it('requires an idempotency key for retryable creates', async () => {
    const stage4 = domain();
    const response = await request(stage4, {path: '/api/v1/committees', method: 'POST',
      headers: {...protectedHeaders, 'idempotency-key': ''}, body: {name: 'One', visibility: 'PRIVATE', countryTemplateKey: 'builtin:default'}});
    expect(response.status).toBe(400);
    expect(stage4.createCommittee).not.toHaveBeenCalled();
  });

  it('routes seat updates through the explicit revision command', async () => {
    const updateSeat = vi.fn(async () => ({id: 'seat', revision: 2})); const stage4 = domain({updateSeat});
    const response = await request(stage4, {path: '/api/v1/committees/20000000-0000-4000-8000-000000000001/seats/30000000-0000-4000-8000-000000000001',
      method: 'PUT', headers: protectedHeaders, body: {baseRevision: 1, patch: {displayName: '中国'}}});
    expect(response.status).toBe(200);
    expect(updateSeat).toHaveBeenCalledWith(authenticated, '20000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001', {baseRevision: 1, patch: {displayName: '中国'}},
      expect.objectContaining({requestId: expect.any(String)}));
  });

  it('keeps built-in country template deletion behind authenticated write checks', async () => {
    const stage4 = domain();
    const rejected = await request(stage4, {path: '/api/v1/country-templates/builtin%3Adefault', method: 'DELETE'});
    expect(rejected.status).toBe(403);
    expect(stage4.deleteCountryTemplate).not.toHaveBeenCalled();
  });
});
