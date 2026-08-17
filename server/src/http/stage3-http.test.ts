// @vitest-environment node

import {EventEmitter, once} from 'node:events';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {Readable} from 'node:stream';
import {describe, expect, it, vi} from 'vitest';
import type {IdentityService} from '../modules/identity/service';
import type {Stage3Service} from '../modules/stage3/service';
import {createLogger} from '../logger';
import {createRequestHandler} from './app';

const authenticated = {sessionId: 'session-id', user: {id: '10000000-0000-4000-8000-000000000001',
  email: 'user@example.com', displayName: 'User', status: 'ACTIVE', isSystemAdmin: false,
  sessionVersion: 1, mustChangePassword: false, createdAt: '2026-08-12T00:00:00.000Z', disabledAt: null}} as const;

class TestResponse extends EventEmitter {
  statusCode = 200; headersSent = false; body = '';
  readonly headers = new Map<string, string | number | readonly string[]>();
  setHeader(name: string, value: string | number | readonly string[]): this {this.headers.set(name.toLowerCase(), value); return this;}
  end(body?: string): this {this.headersSent = true; this.body = body ?? ''; queueMicrotask(() => this.emit('finish')); return this;}
  destroy(): this {return this;}
}

function identity(): IdentityService {
  return {authenticate: vi.fn(async () => authenticated)} as unknown as IdentityService;
}

function domain(overrides: Record<string, unknown> = {}): Stage3Service {
  return {
    createCommittee: vi.fn(async (_auth, input) => ({id: '20000000-0000-4000-8000-000000000001',
      ownerUserId: authenticated.user.id, name: input.name, chairLabel: '', topic: '', conference: '',
      visibility: input.visibility, operationMode: 'DELEGATE_OPERATED', status: 'ACTIVE',
      activeRulePackageVersionId: '30000000-0000-4000-8000-000000000001', revision: 1})),
    snapshot: vi.fn(async () => ({schemaVersion: 1, committee: {id: '20000000-0000-4000-8000-000000000001',
      name: 'Public', chairLabel: '', topic: '', conference: '', visibility: 'PUBLIC', operationMode: 'DELEGATE_OPERATED',
      status: 'ACTIVE', activeRulePackageVersionId: '30000000-0000-4000-8000-000000000001', revision: 1}, seats: [],
      viewer: {audience: 'PUBLIC', seatId: null}, sync: {committeeEventSequence: 1}})),
    ...overrides
  } as unknown as Stage3Service;
}

async function request(stage3: Stage3Service, options: {path: string; method?: string; headers?: Record<string, string>; body?: unknown}) {
  const handler = createRequestHandler({health: {ready: async () => ({ready: true, checks: {database: {status: 'ok', migrationVersion: 3},
    storage: {status: 'ok'}}})}, logger: createLogger(() => undefined), version: 'test', databaseMigrationVersion: 3,
    identity: identity(), stage3, allowedOrigins: ['https://quorum.example.com']});
  const text = options.body ? JSON.stringify(options.body) : '';
  const incoming = Readable.from(text ? [Buffer.from(text)] : []) as unknown as IncomingMessage;
  Object.assign(incoming, {method: options.method ?? 'GET', url: options.path, headers: options.headers ?? {}, socket: {remoteAddress: '127.0.0.1'}});
  const response = new TestResponse(); const finished = once(response, 'finish');
  handler(incoming, response as unknown as ServerResponse); await finished;
  return {status: response.statusCode, text: response.body, json: JSON.parse(response.body) as Record<string, unknown>};
}

describe('stage 3 HTTP boundary', () => {
  const protectedHeaders = {origin: 'https://quorum.example.com',
    cookie: '__Host-quorum_session=session; __Host-quorum_csrf=csrf', 'x-csrf-token': 'csrf'};

  it('requires Origin, Session, and CSRF before committee writes and derives the actor from the Session', async () => {
    const stage3 = domain();
    const rejected = await request(stage3, {path: '/api/v1/committees', method: 'POST',
      headers: {origin: 'https://quorum.example.com'}, body: {name: 'Private', visibility: 'PRIVATE', ownerUserId: 'attacker'}});
    expect(rejected.status).toBe(403);
    const accepted = await request(stage3, {path: '/api/v1/committees', method: 'POST', headers: protectedHeaders,
      body: {name: 'Private', visibility: 'PRIVATE', ownerUserId: 'attacker'}});
    expect(accepted.status).toBe(201);
    expect(stage3.createCommittee).toHaveBeenCalledWith(authenticated,
      expect.not.objectContaining({ownerUserId: 'attacker'}), expect.objectContaining({requestId: expect.any(String)}));
  });

  it('allows an anonymous public snapshot without exposing identity data', async () => {
    const stage3 = domain();
    const response = await request(stage3, {path: '/api/v1/committees/20000000-0000-4000-8000-000000000001/snapshot'});
    expect(response.status).toBe(200);
    expect(response.text).not.toContain('user@example.com');
    expect(stage3.snapshot).toHaveBeenCalledWith('20000000-0000-4000-8000-000000000001', undefined);
  });

  it('never returns invitation codes or internal errors after a failed write', async () => {
    const stage3 = domain({redeemInvitation: vi.fn(async () => {throw new Error('secret-invitation-code SQL stack');})});
    const response = await request(stage3, {path: '/api/v1/seat-invitations/redeem', method: 'POST', headers: protectedHeaders,
      body: {code: 'secret-invitation-code'}});
    expect(response.status).toBe(500);
    expect(response.text).not.toContain('secret-invitation-code');
    expect(response.text).not.toContain('SQL');
  });
});
