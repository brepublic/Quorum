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

  it('routes legacy speaker settings, removal, status, and yield decisions through revisions', async () => {
    const updateSpeakerList = vi.fn(async () => ({id: 'list'}));
    const setSpeakerListStatus = vi.fn(async () => ({id: 'list'}));
    const removeSpeakerQueueEntry = vi.fn(async () => ({id: 'list'}));
    const decideSpeechYield = vi.fn(async () => ({id: 'list'}));
    const stage5 = {updateSpeakerList, setSpeakerListStatus, removeSpeakerQueueEntry,
      decideSpeechYield} as unknown as Stage5Service;
    const listId = '30000000-0000-4000-8000-000000000001';
    const entryId = '30000000-0000-4000-8000-000000000002';
    await send(stage5, `/api/v1/speaker-lists/${listId}/settings`, {baseRevision: 2, delegatesCanQueue: true});
    await send(stage5, `/api/v1/speaker-lists/${listId}/status`, {baseRevision: 3, status: 'CLOSED'});
    await send(stage5, `/api/v1/speaker-lists/${listId}/queue/${entryId}/remove`, {baseRevision: 4});
    await send(stage5, `/api/v1/speeches/${entryId}/yield-decision`, {baseRevision: 5, decision: 'REJECT'});
    expect(updateSpeakerList).toHaveBeenCalledWith(authenticated, listId,
      {baseRevision: 2, delegatesCanQueue: true}, expect.any(Object));
    expect(setSpeakerListStatus).toHaveBeenCalledWith(authenticated, listId,
      {baseRevision: 3, status: 'CLOSED'}, expect.any(Object));
    expect(removeSpeakerQueueEntry).toHaveBeenCalledWith(authenticated, listId, entryId,
      {baseRevision: 4}, expect.any(Object));
    expect(decideSpeechYield).toHaveBeenCalledWith(authenticated, entryId,
      {baseRevision: 5, decision: 'REJECT'}, expect.any(Object));
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

  it('routes motion withdrawal through the Chair revision command', async () => {
    const withdrawMotion = vi.fn(async () => ({id: 'motion', status: 'WITHDRAWN'}));
    const stage5 = {withdrawMotion} as unknown as Stage5Service;
    const response = await send(stage5, '/api/v1/motions/30000000-0000-4000-8000-000000000001/withdraw',
      {baseRevision: 4});
    expect(response.statusCode).toBe(200);
    expect(withdrawMotion).toHaveBeenCalledWith(authenticated, '30000000-0000-4000-8000-000000000001',
      {baseRevision: 4}, expect.any(Object));
  });

  it('routes direct motion votes and their frozen eligibility setting', async () => {
    const setMotionDirectVote = vi.fn(async () => ({id: 'motion'}));
    const setMotionDirectVoteSettings = vi.fn(async () => ({id: 'motion'}));
    const stage5 = {setMotionDirectVote, setMotionDirectVoteSettings} as unknown as Stage5Service;
    await send(stage5, '/api/v1/motions/30000000-0000-4000-8000-000000000001/direct-vote',
      {choice: 'FOR', onBehalfOfSeatId: '40000000-0000-4000-8000-000000000001'});
    await send(stage5, '/api/v1/motions/30000000-0000-4000-8000-000000000001/direct-vote-settings',
      {baseRevision: 1, includeNonVotingSeats: false});
    expect(setMotionDirectVote).toHaveBeenCalledWith(authenticated, '30000000-0000-4000-8000-000000000001',
      {choice: 'FOR', onBehalfOfSeatId: '40000000-0000-4000-8000-000000000001'}, expect.any(Object));
    expect(setMotionDirectVoteSettings).toHaveBeenCalledWith(authenticated, '30000000-0000-4000-8000-000000000001',
      {baseRevision: 1, includeNonVotingSeats: false}, expect.any(Object));
  });

  it('uses idempotency for the first vote from a seat', async () => {
    const castVote = vi.fn(async () => ({id: 'ballot'})); const stage5 = {castVote} as unknown as Stage5Service;
    await send(stage5, '/api/v1/ballots/30000000-0000-4000-8000-000000000001/votes', {choice: 'FOR'});
    expect(castVote).toHaveBeenCalledWith(authenticated, '30000000-0000-4000-8000-000000000001',
      {choice: 'FOR'}, 'timer-key', expect.any(Object));
  });

  it('routes the legacy set-or-retract vote interaction through a revision command', async () => {
    const setBallotVote = vi.fn(async () => ({id: 'ballot'}));
    const stage5 = {setBallotVote} as unknown as Stage5Service;
    const response = await send(stage5, '/api/v1/ballots/30000000-0000-4000-8000-000000000001/set-vote',
      {baseRevision: 4, choice: null, onBehalfOfSeatId: '40000000-0000-4000-8000-000000000001'});
    expect(response.statusCode).toBe(200);
    expect(setBallotVote).toHaveBeenCalledWith(authenticated, '30000000-0000-4000-8000-000000000001',
      {baseRevision: 4, choice: null, onBehalfOfSeatId: '40000000-0000-4000-8000-000000000001'}, expect.any(Object));
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

  it('routes strawpoll rounds, stages, and manual tallies through their command boundaries', async () => {
    const reviseStrawpoll = vi.fn(async () => ({id: 'next-round'}));
    const commandStrawpollStage = vi.fn(async () => ({id: 'strawpoll'}));
    const setStrawpollManualTally = vi.fn(async () => ({id: 'strawpoll'}));
    const stage5 = {reviseStrawpoll, commandStrawpollStage, setStrawpollManualTally} as unknown as Stage5Service;
    const id = '30000000-0000-4000-8000-000000000001';
    expect((await send(stage5, `/api/v1/strawpolls/${id}/rounds`, {baseRevision: 1, question: 'Question',
      votingMode: 'SEAT_AUTHENTICATED', multipleChoice: false, options: ['Yes', 'No'], medium: 'LINK',
      optionsArePublic: false})).statusCode).toBe(201);
    expect((await send(stage5, `/api/v1/strawpolls/${id}/stage`, {baseRevision: 1, action: 'START'})).statusCode).toBe(200);
    expect((await send(stage5, `/api/v1/strawpolls/${id}/manual-tallies`, {baseRevision: 2,
      optionId: '40000000-0000-4000-8000-000000000001', tally: 3})).statusCode).toBe(200);
    expect(reviseStrawpoll).toHaveBeenCalledWith(authenticated, id, expect.any(Object), 'timer-key', expect.any(Object));
    expect(commandStrawpollStage).toHaveBeenCalledWith(authenticated, id, expect.any(Object), expect.any(Object));
    expect(setStrawpollManualTally).toHaveBeenCalledWith(authenticated, id, expect.any(Object), expect.any(Object));
  });

  it('routes versioned resolution commands without accepting actor fields', async () => {
    const createResolution = vi.fn(async (_auth, _id, body: Record<string, unknown>) => {
      if ('actorUserId' in body) throw new AppError({code: 'VALIDATION_FAILED', message: 'Unsupported field.'});
      return {id: 'resolution'};
    });
    const stage5 = {createResolution} as unknown as Stage5Service;
    const response = await send(stage5, '/api/v1/committees/20000000-0000-4000-8000-000000000001/resolutions',
      {meetingSessionId: '30000000-0000-4000-8000-000000000001', title: 'A/RES/1', content: '正文',
        actorUserId: 'attacker'});
    expect(response.statusCode).toBe(422);
  });

  it('uses idempotency for resolution creation and discussion', async () => {
    const createResolution = vi.fn(async () => ({id: 'resolution'}));
    const addDocumentDiscussion = vi.fn(async () => ({id: 'resolution'}));
    const stage5 = {createResolution, addDocumentDiscussion} as unknown as Stage5Service;
    await send(stage5, '/api/v1/committees/20000000-0000-4000-8000-000000000001/resolutions',
      {meetingSessionId: '30000000-0000-4000-8000-000000000001', title: 'A/RES/1', content: '正文'});
    await send(stage5, '/api/v1/documents/30000000-0000-4000-8000-000000000001/discussion',
      {content: '支持本草案。', ruleStableId: 'discuss-resolution'});
    expect(createResolution).toHaveBeenCalledWith(authenticated, '20000000-0000-4000-8000-000000000001',
      expect.any(Object), 'timer-key', expect.any(Object));
    expect(addDocumentDiscussion).toHaveBeenCalledWith(authenticated, '30000000-0000-4000-8000-000000000001',
      expect.any(Object), 'timer-key', expect.any(Object));
  });
});
