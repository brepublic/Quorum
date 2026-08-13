// @vitest-environment node

import {EventEmitter, once} from 'node:events';
import {Readable} from 'node:stream';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {describe, expect, it, vi} from 'vitest';
import {createLogger} from '../logger';
import type {IdentityService} from '../modules/identity/service';
import type {Stage5Service} from '../modules/stage5/service';
import {createRequestHandler} from './app';
import {AppError} from './errors';

const authenticated = {sessionId: 'session', user: {id: '10000000-0000-4000-8000-000000000001',
  email: 'user@example.com', displayName: 'User', status: 'ACTIVE', isSystemAdmin: false,
  sessionVersion: 1, mustChangePassword: false, createdAt: '2026-08-13T00:00:00.000Z', disabledAt: null}} as const;
const headers = {origin: 'https://quorum.example.com', cookie: '__Host-quorum_session=session; __Host-quorum_csrf=csrf',
  'x-csrf-token': 'csrf', 'idempotency-key': 'timer-key'};

class TestResponse extends EventEmitter {
  statusCode = 200; headersSent = false; body = ''; readonly headers = new Map<string, unknown>();
  setHeader(name: string, value: unknown): this {this.headers.set(name, value); return this;}
  end(body?: string): this {this.headersSent = true; this.body = body ?? ''; queueMicrotask(() => this.emit('finish')); return this;}
  destroy(): this {return this;}
}

async function send(stage5: Stage5Service, path: string, body: unknown, requestHeaders = headers) {
  const identity = {authenticate: vi.fn(async token => {
    if (!token) throw new AppError({code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required.'});
    return authenticated;
  })} as unknown as IdentityService;
  const handler = createRequestHandler({health: {ready: async () => ({ready: true, checks: {database: {status: 'ok', migrationVersion: 6},
    storage: {status: 'ok'}}})}, logger: createLogger(() => undefined), version: 'test', databaseMigrationVersion: 6,
    identity, stage5, allowedOrigins: ['https://quorum.example.com']});
  const incoming = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(incoming, {method: 'POST', url: path, headers: requestHeaders, socket: {remoteAddress: '127.0.0.1'}});
  const response = new TestResponse(); const finished = once(response, 'finish');
  handler(incoming, response as unknown as ServerResponse); await finished;
  return response;
}

describe('stage 5 timer HTTP boundary', () => {
  it('derives the actor from Session and requires idempotency for timer creation', async () => {
    const createTimer = vi.fn(async () => ({id: 'timer'}));
    const stage5 = {createTimer} as unknown as Stage5Service;
    const response = await send(stage5, '/api/v1/committees/20000000-0000-4000-8000-000000000001/timers',
      {ownerType: 'COMMITTEE', ownerId: '20000000-0000-4000-8000-000000000001', durationMs: 60_000});
    expect(response.statusCode).toBe(201);
    expect(createTimer).toHaveBeenCalledWith(authenticated, '20000000-0000-4000-8000-000000000001',
      expect.not.objectContaining({actorUserId: expect.anything()}), 'timer-key', expect.objectContaining({requestId: expect.any(String)}));
  });

  it('routes queue changes through idempotent or revision commands', async () => {
    const joinSpeakerQueue = vi.fn(async () => ({id: 'list', revision: 2}));
    const reorderSpeakerQueue = vi.fn(async () => ({id: 'list', revision: 3}));
    const stage5 = {joinSpeakerQueue, reorderSpeakerQueue} as unknown as Stage5Service;
    await send(stage5, '/api/v1/speaker-lists/30000000-0000-4000-8000-000000000001/queue', {seatId: 'seat'});
    await send(stage5, '/api/v1/speaker-lists/30000000-0000-4000-8000-000000000001/reorder',
      {baseRevision: 2, entryIds: []});
    expect(joinSpeakerQueue).toHaveBeenCalledWith(authenticated, '30000000-0000-4000-8000-000000000001',
      {seatId: 'seat'}, 'timer-key', expect.any(Object));
    expect(reorderSpeakerQueue).toHaveBeenCalledWith(authenticated, '30000000-0000-4000-8000-000000000001',
      {baseRevision: 2, entryIds: []}, expect.any(Object));
  });

  it('routes yields without accepting an actor identity from the client', async () => {
    const yieldSpeech = vi.fn(async (_auth, _id, body: Record<string, unknown>) => {
      if ('actorUserId' in body) throw new AppError({code: 'VALIDATION_FAILED', message: 'Unsupported field.'});
      return {id: 'inherited-speech'};
    });
    const stage5 = {yieldSpeech} as unknown as Stage5Service;
    const response = await send(stage5, '/api/v1/speeches/30000000-0000-4000-8000-000000000001/yield',
      {baseRevision: 2, type: 'QUESTIONS', actorUserId: 'attacker'});
    expect(response.statusCode).toBe(422);
  });

  it('uses idempotency for motion proposals and seconds', async () => {
    const proposeMotion = vi.fn(async () => ({id: 'motion'})); const secondMotion = vi.fn(async () => ({id: 'motion'}));
    const stage5 = {proposeMotion, secondMotion} as unknown as Stage5Service;
    await send(stage5, '/api/v1/committees/20000000-0000-4000-8000-000000000001/motions',
      {meetingSessionId: 'session', motionTypeId: 'open-moderated-caucus'});
    await send(stage5, '/api/v1/motions/30000000-0000-4000-8000-000000000001/second', {});
    expect(proposeMotion).toHaveBeenCalledWith(authenticated, '20000000-0000-4000-8000-000000000001',
      expect.any(Object), 'timer-key', expect.any(Object));
    expect(secondMotion).toHaveBeenCalledWith(authenticated, '30000000-0000-4000-8000-000000000001',
      {}, 'timer-key', expect.any(Object));
  });

  it('uses idempotency for the first vote from a seat', async () => {
    const castVote = vi.fn(async () => ({id: 'ballot'})); const stage5 = {castVote} as unknown as Stage5Service;
    await send(stage5, '/api/v1/ballots/30000000-0000-4000-8000-000000000001/votes', {choice: 'FOR'});
    expect(castVote).toHaveBeenCalledWith(authenticated, '30000000-0000-4000-8000-000000000001',
      {choice: 'FOR'}, 'timer-key', expect.any(Object));
  });

  it('routes explicit timer commands with CSRF and revision', async () => {
    const commandTimer = vi.fn(async () => ({id: 'timer', revision: 4}));
    const stage5 = {commandTimer} as unknown as Stage5Service;
    const response = await send(stage5, '/api/v1/timers/30000000-0000-4000-8000-000000000001/pause', {baseRevision: 3});
    expect(response.statusCode).toBe(200);
    expect(commandTimer).toHaveBeenCalledWith(authenticated, '30000000-0000-4000-8000-000000000001', 'pause',
      {baseRevision: 3}, expect.objectContaining({requestId: expect.any(String)}));
  });

  it('rejects an actor identity in anonymous strawpoll votes', async () => {
    const voteStrawpoll = vi.fn(async (_auth, _id, body: Record<string, unknown>) => {
      if ('actorUserId' in body) throw new AppError({code: 'VALIDATION_FAILED', message: 'Unsupported field.'});
      return {id: 'strawpoll'};
    });
    const stage5 = {voteStrawpoll} as unknown as Stage5Service;
    const response = await send(stage5, '/api/v1/strawpolls/30000000-0000-4000-8000-000000000001/votes',
      {optionIds: ['40000000-0000-4000-8000-000000000001'], anonymousAccessToken: 'token',
        actorUserId: 'attacker'});
    expect(response.statusCode).toBe(422);
  });

  it('routes strawpoll creation and votes through idempotent commands', async () => {
    const createStrawpoll = vi.fn(async () => ({id: 'strawpoll'}));
    const voteStrawpoll = vi.fn(async () => ({id: 'strawpoll'}));
    const stage5 = {createStrawpoll, voteStrawpoll} as unknown as Stage5Service;
    await send(stage5, '/api/v1/committees/20000000-0000-4000-8000-000000000001/strawpolls',
      {meetingSessionId: '30000000-0000-4000-8000-000000000001', question: '支持？',
        votingMode: 'ANONYMOUS', multipleChoice: false, options: ['支持', '反对']});
    await send(stage5, '/api/v1/strawpolls/30000000-0000-4000-8000-000000000001/votes',
      {optionIds: ['40000000-0000-4000-8000-000000000001'], anonymousAccessToken: 'token'});
    expect(createStrawpoll).toHaveBeenCalledWith(authenticated, '20000000-0000-4000-8000-000000000001',
      expect.any(Object), 'timer-key', expect.any(Object));
    expect(voteStrawpoll).toHaveBeenCalledWith(authenticated, '30000000-0000-4000-8000-000000000001',
      expect.any(Object), 'timer-key', expect.any(Object));
  });
});
