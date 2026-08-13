import {randomUUID} from 'node:crypto';
import {createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse} from 'node:http';
import {CONTRACT_VERSION, success, type VersionInfo} from '@quorum/contracts';
import {RULE_SCHEMA_VERSION} from '@quorum/rule-schema';
import type {Logger} from '../logger.js';
import {withRequestContext} from '../request-context.js';
import type {HealthService} from '../operations/health.js';
import type {IdentityService, RequestIdentityContext, SessionResult} from '../modules/identity/service.js';
import type {AuthenticatedSession} from '../modules/identity/store.js';
import type {Stage3Service} from '../modules/stage3/service.js';
import type {Stage4Service} from '../modules/stage4/service.js';
import type {RealtimeService} from '../modules/realtime/service.js';
import type {Stage5Service} from '../modules/stage5/service.js';
import {AppError, normalizeError} from './errors.js';
import {
  clearIdentityCookies,
  CSRF_COOKIE_NAME,
  csrfCookie,
  parseCookies,
  SESSION_COOKIE_NAME,
  sessionCookie,
  verifyCsrf
} from './cookies.js';
import {streamCommitteeEvents} from './sse.js';

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface AppDependencies {
  health: HealthService;
  logger: Logger;
  version: string;
  databaseMigrationVersion: number;
  now?: () => number;
  identity?: IdentityService;
  stage3?: Stage3Service;
  stage4?: Stage4Service;
  realtime?: RealtimeService;
  stage5?: Stage5Service;
  allowedOrigins?: string[];
}

const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;

function requestIdFor(request: IncomingMessage): string {
  const supplied = request.headers['x-request-id'];
  return typeof supplied === 'string' && REQUEST_ID.test(supplied) ? supplied : randomUUID();
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', Buffer.byteLength(json));
  response.setHeader('cache-control', 'no-store');
  response.end(json);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_JSON_BODY_BYTES) {
      throw new AppError({code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.'});
    }
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new AppError({code: 'BAD_REQUEST', message: 'Request body must be a JSON object.'});
  }
}

function stringField(body: Record<string, unknown>, name: string, optional = false): string | undefined {
  const value = body[name];
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new AppError({code: 'BAD_REQUEST', message: `Field ${name} must be a string.`});
  }
  return value;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function idempotencyKey(request: IncomingMessage): string {
  const value = singleHeader(request.headers['idempotency-key']);
  if (!value) throw new AppError({code: 'BAD_REQUEST', message: 'Idempotency-Key is required.'});
  return value;
}

function requireOrigin(request: IncomingMessage, allowedOrigins: readonly string[]): void {
  const origin = singleHeader(request.headers.origin);
  if (!origin || !allowedOrigins.includes(origin)) {
    throw new AppError({code: 'FORBIDDEN', message: 'Request origin is not allowed.'});
  }
}

function identityContext(request: IncomingMessage, requestId: string): RequestIdentityContext {
  const forwarded = singleHeader(request.headers['x-forwarded-for'])?.split(',')[0]?.trim();
  return {
    requestId,
    sourceIp: forwarded || request.socket?.remoteAddress,
    userAgent: singleHeader(request.headers['user-agent'])
  };
}

function identityCookies(request: IncomingMessage): Map<string, string> {
  return parseCookies(singleHeader(request.headers.cookie));
}

function setSessionCookies(response: ServerResponse, session: SessionResult): void {
  response.setHeader('set-cookie', [
    sessionCookie(session.sessionToken, SESSION_MAX_AGE_SECONDS),
    csrfCookie(session.csrfToken, SESSION_MAX_AGE_SECONDS)
  ]);
}

async function authenticatedWrite(request: IncomingMessage, identity: IdentityService): Promise<AuthenticatedSession> {
  const cookies = identityCookies(request);
  verifyCsrf(cookies.get(CSRF_COOKIE_NAME), singleHeader(request.headers['x-csrf-token']));
  return identity.authenticate(cookies.get(SESSION_COOKIE_NAME));
}

function integerField(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AppError({code: 'BAD_REQUEST', message: `Field ${name} must be a positive integer.`});
  }
  return Number(value);
}

async function optionalAuthentication(request: IncomingMessage, identity: IdentityService): Promise<AuthenticatedSession | undefined> {
  const token = identityCookies(request).get(SESSION_COOKIE_NAME);
  return token ? identity.authenticate(token) : undefined;
}

async function handleStage4Request(options: {
  request: IncomingMessage; response: ServerResponse; pathname: string; requestId: string;
  identity: IdentityService; stage4: Stage4Service; allowedOrigins: readonly string[];
}): Promise<boolean> {
  const {request, response, pathname, requestId, identity, stage4, allowedOrigins} = options;
  const method = request.method ?? 'GET'; const context = identityContext(request, requestId);
  const read = () => identity.authenticate(identityCookies(request).get(SESSION_COOKIE_NAME));
  const write = async () => { requireOrigin(request, allowedOrigins); return authenticatedWrite(request, identity); };

  if (method === 'GET' && pathname === '/api/v1/committees') {
    sendJson(response, 200, success({committees: await stage4.listCommittees(await read())}, requestId)); return true;
  }
  if (method === 'POST' && pathname === '/api/v1/committees') {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 201, success(await stage4.createCommittee(auth, body, idempotencyKey(request), context), requestId)); return true;
  }
  const snapshot = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/snapshot$/.exec(pathname);
  if (method === 'GET' && snapshot) {
    sendJson(response, 200, success(await stage4.snapshot(snapshot[1] as string,
      await optionalAuthentication(request, identity)), requestId)); return true;
  }

  if (pathname === '/api/v1/country-templates') {
    if (method === 'GET') {
      sendJson(response, 200, success({countryTemplates: await stage4.listCountryTemplates(await read())}, requestId)); return true;
    }
    if (method === 'POST') {
      const auth = await write(); const body = await readJson(request);
      sendJson(response, 201, success(await stage4.createCountryTemplate(auth, body, idempotencyKey(request), context), requestId)); return true;
    }
  }
  const countryTemplate = /^\/api\/v1\/country-templates\/([^/]+?)(?:\/(clone))?$/.exec(pathname);
  if (countryTemplate) {
    const id = decodeURIComponent(countryTemplate[1] as string);
    if (method === 'GET' && !countryTemplate[2]) {
      sendJson(response, 200, success(await stage4.getCountryTemplate(await read(), id), requestId)); return true;
    }
    if (method === 'PUT' && !countryTemplate[2]) {
      const auth = await write(); const body = await readJson(request);
      sendJson(response, 200, success(await stage4.updateCountryTemplate(auth, id, body, context), requestId)); return true;
    }
    if (method === 'POST' && countryTemplate[2] === 'clone') {
      const auth = await write(); const body = await readJson(request);
      sendJson(response, 201, success(await stage4.cloneCountryTemplate(auth, id, body, idempotencyKey(request), context), requestId)); return true;
    }
    if (method === 'DELETE' && !countryTemplate[2]) {
      const auth = await write(); await stage4.deleteCountryTemplate(auth, id, context);
      sendJson(response, 200, success({deleted: true}, requestId)); return true;
    }
  }

  if (pathname === '/api/v1/committee-templates') {
    if (method === 'GET') {
      sendJson(response, 200, success({committeeTemplates: await stage4.listCommitteeTemplates(await read())}, requestId)); return true;
    }
    if (method === 'POST') {
      const auth = await write(); const body = await readJson(request);
      sendJson(response, 201, success(await stage4.createCommitteeTemplate(auth, body, idempotencyKey(request), context), requestId)); return true;
    }
  }
  const committeeTemplate = /^\/api\/v1\/committee-templates\/([0-9a-f-]{36})(?:\/(clone))?$/.exec(pathname);
  if (committeeTemplate) {
    const id = committeeTemplate[1] as string;
    if (method === 'GET' && !committeeTemplate[2]) {
      sendJson(response, 200, success(await stage4.getCommitteeTemplate(await read(), id), requestId)); return true;
    }
    if (method === 'PUT' && !committeeTemplate[2]) {
      const auth = await write(); const body = await readJson(request);
      sendJson(response, 200, success(await stage4.updateCommitteeTemplate(auth, id, body, context), requestId)); return true;
    }
    if (method === 'POST' && committeeTemplate[2] === 'clone') {
      const auth = await write(); const body = await readJson(request);
      sendJson(response, 201, success(await stage4.cloneCommitteeTemplate(auth, id, body, idempotencyKey(request), context), requestId)); return true;
    }
    if (method === 'DELETE' && !committeeTemplate[2]) {
      const auth = await write(); await stage4.deleteCommitteeTemplate(auth, id, context);
      sendJson(response, 200, success({deleted: true}, requestId)); return true;
    }
  }

  const seats = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/seats(?:\/([0-9a-f-]{36}))?$/.exec(pathname);
  if (seats && method === 'POST' && !seats[2]) {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 201, success(await stage4.createSeat(auth, seats[1] as string, body,
      idempotencyKey(request), context), requestId)); return true;
  }
  if (seats && method === 'PUT' && seats[2]) {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 200, success(await stage4.updateSeat(auth, seats[1] as string, seats[2], body, context), requestId)); return true;
  }

  const notes = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/notes$/.exec(pathname);
  if (notes && method === 'POST') {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 201, success(await stage4.createNote(auth, notes[1] as string, body,
      idempotencyKey(request), context), requestId)); return true;
  }
  const note = /^\/api\/v1\/notes\/([0-9a-f-]{36})$/.exec(pathname);
  if (note && (method === 'PUT' || method === 'DELETE')) {
    const auth = await write(); const body = await readJson(request);
    if (method === 'PUT') sendJson(response, 200, success(await stage4.updateNote(auth, note[1] as string, body, context), requestId));
    else {
      await stage4.deleteNote(auth, note[1] as string, integerField(body, 'baseRevision'), context);
      sendJson(response, 200, success({deleted: true}, requestId));
    }
    return true;
  }

  const textPosts = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/text-posts$/.exec(pathname);
  if (textPosts && method === 'POST') {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 201, success(await stage4.createTextPost(auth, textPosts[1] as string, body,
      idempotencyKey(request), context), requestId)); return true;
  }
  const textPost = /^\/api\/v1\/text-posts\/([0-9a-f-]{36})$/.exec(pathname);
  if (textPost && (method === 'PUT' || method === 'DELETE')) {
    const auth = await write(); const body = await readJson(request);
    if (method === 'PUT') sendJson(response, 200, success(await stage4.updateTextPost(auth, textPost[1] as string, body, context), requestId));
    else {
      await stage4.deleteTextPost(auth, textPost[1] as string, integerField(body, 'baseRevision'), context);
      sendJson(response, 200, success({deleted: true}, requestId));
    }
    return true;
  }

  const meetingSessions = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/meeting-sessions$/.exec(pathname);
  if (meetingSessions && method === 'POST') {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 201, success(await stage4.startMeetingSession(auth, meetingSessions[1] as string, body, context), requestId));
    return true;
  }
  const closeMeetingSession = /^\/api\/v1\/meeting-sessions\/([0-9a-f-]{36})\/close$/.exec(pathname);
  if (closeMeetingSession && method === 'POST') {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 200, success(await stage4.closeMeetingSession(auth, closeMeetingSession[1] as string, body, context), requestId));
    return true;
  }
  const rollCalls = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/roll-calls$/.exec(pathname);
  if (rollCalls && method === 'POST') {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 201, success(await stage4.startRollCall(auth, rollCalls[1] as string, body,
      idempotencyKey(request), context), requestId)); return true;
  }
  const rollCallCommand = /^\/api\/v1\/roll-calls\/([0-9a-f-]{36})\/(record-response|undo|reset)$/.exec(pathname);
  if (rollCallCommand && method === 'POST') {
    const auth = await write(); const body = await readJson(request); const id = rollCallCommand[1] as string;
    const result = rollCallCommand[2] === 'record-response'
      ? await stage4.recordRollCallResponse(auth, id, body, context)
      : rollCallCommand[2] === 'undo'
        ? await stage4.undoRollCallResponse(auth, id, body, context)
        : await stage4.resetRollCall(auth, id, body, context);
    sendJson(response, 200, success(result, requestId)); return true;
  }
  const attendanceEvents = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/attendance-events$/.exec(pathname);
  if (attendanceEvents && method === 'POST') {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 201, success(await stage4.createAttendanceEvent(auth, attendanceEvents[1] as string, body, context), requestId));
    return true;
  }
  const points = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/points$/.exec(pathname);
  if (points && method === 'POST') {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 201, success(await stage4.createPoint(auth, points[1] as string, body,
      idempotencyKey(request), context), requestId)); return true;
  }
  const resolvePoint = /^\/api\/v1\/points\/([0-9a-f-]{36})\/resolve$/.exec(pathname);
  if (resolvePoint && method === 'POST') {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 200, success(await stage4.resolvePoint(auth, resolvePoint[1] as string, body, context), requestId));
    return true;
  }
  return false;
}

async function handleStage5Request(options: {
  request: IncomingMessage; response: ServerResponse; pathname: string; requestId: string;
  identity: IdentityService; stage5: Stage5Service; allowedOrigins: readonly string[];
}): Promise<boolean> {
  const {request, response, pathname, requestId, identity, stage5, allowedOrigins} = options;
  const method = request.method ?? 'GET'; const context = identityContext(request, requestId);
  const write = async () => { requireOrigin(request, allowedOrigins); return authenticatedWrite(request, identity); };
  const timers = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/timers$/.exec(pathname);
  if (method === 'POST' && timers) {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 201, success(await stage5.createTimer(auth, timers[1] as string, body,
      idempotencyKey(request), context), requestId)); return true;
  }
  const speakerLists = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/speaker-lists$/.exec(pathname);
  if (method === 'POST' && speakerLists) {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 201, success(await stage5.createSpeakerList(auth, speakerLists[1] as string, body,
      idempotencyKey(request), context), requestId)); return true;
  }
  const speakerCommand = /^\/api\/v1\/speaker-lists\/([0-9a-f-]{36})\/(queue|reorder|advance)$/.exec(pathname);
  if (method === 'POST' && speakerCommand) {
    const auth = await write(); const body = await readJson(request); const id = speakerCommand[1] as string;
    const result = speakerCommand[2] === 'queue'
      ? await stage5.joinSpeakerQueue(auth, id, body, idempotencyKey(request), context)
      : speakerCommand[2] === 'reorder'
        ? await stage5.reorderSpeakerQueue(auth, id, body, context)
        : await stage5.advanceSpeakerQueue(auth, id, body, context);
    sendJson(response, speakerCommand[2] === 'queue' ? 201 : 200, success(result, requestId)); return true;
  }
  const speechCommand = /^\/api\/v1\/speaker-lists\/([0-9a-f-]{36})\/speech\/(start|pause|resume|complete)$/.exec(pathname);
  if (method === 'POST' && speechCommand) {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 200, success(await stage5.commandSpeech(auth, speechCommand[1] as string,
      speechCommand[2] as 'start' | 'pause' | 'resume' | 'complete', body, context), requestId)); return true;
  }
  const yieldSpeech = /^\/api\/v1\/speeches\/([0-9a-f-]{36})\/yield$/.exec(pathname);
  if (method === 'POST' && yieldSpeech) {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 200, success(await stage5.yieldSpeech(auth, yieldSpeech[1] as string, body, context), requestId));
    return true;
  }
  const contribution = /^\/api\/v1\/speeches\/([0-9a-f-]{36})\/contributions$/.exec(pathname);
  if (method === 'POST' && contribution) {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 201, success(await stage5.recordSpeechContribution(auth, contribution[1] as string, body, context), requestId));
    return true;
  }
  const motions = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/motions$/.exec(pathname);
  if (method === 'POST' && motions) {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 201, success(await stage5.proposeMotion(auth, motions[1] as string, body,
      idempotencyKey(request), context), requestId)); return true;
  }
  const motionCommand = /^\/api\/v1\/motions\/([0-9a-f-]{36})\/(second|decide)$/.exec(pathname);
  if (method === 'POST' && motionCommand) {
    const auth = await write(); const body = await readJson(request); const id = motionCommand[1] as string;
    const result = motionCommand[2] === 'second'
      ? await stage5.secondMotion(auth, id, body, idempotencyKey(request), context)
      : await stage5.decideMotion(auth, id, body, context);
    sendJson(response, motionCommand[2] === 'second' ? 201 : 200, success(result, requestId)); return true;
  }
  const ballots = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/ballots$/.exec(pathname);
  if (method === 'POST' && ballots) {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 201, success(await stage5.createBallot(auth, ballots[1] as string, body,
      idempotencyKey(request), context), requestId)); return true;
  }
  const ballotCommand = /^\/api\/v1\/ballots\/([0-9a-f-]{36})\/(votes|correct-vote|close|publish)$/.exec(pathname);
  if (method === 'POST' && ballotCommand) {
    const auth = await write(); const body = await readJson(request); const id = ballotCommand[1] as string;
    const result = ballotCommand[2] === 'votes' ? await stage5.castVote(auth, id, body, idempotencyKey(request), context)
      : ballotCommand[2] === 'correct-vote' ? await stage5.correctVote(auth, id, body, context)
        : ballotCommand[2] === 'close' ? await stage5.closeBallot(auth, id, body, context)
          : await stage5.publishBallot(auth, id, body, context);
    sendJson(response, ballotCommand[2] === 'votes' ? 201 : 200, success(result, requestId)); return true;
  }
  const timerCommand = /^\/api\/v1\/timers\/([0-9a-f-]{36})\/(start|pause|resume|extend|reset|expire)$/.exec(pathname);
  if (method === 'POST' && timerCommand) {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 200, success(await stage5.commandTimer(auth, timerCommand[1] as string,
      timerCommand[2] as 'start' | 'pause' | 'resume' | 'extend' | 'reset' | 'expire', body, context), requestId));
    return true;
  }
  return false;
}

async function handleStage3Request(options: {
  request: IncomingMessage; response: ServerResponse; pathname: string; requestId: string;
  identity: IdentityService; stage3: Stage3Service; allowedOrigins: readonly string[];
}): Promise<boolean> {
  const {request, response, pathname, requestId, identity, stage3, allowedOrigins} = options;
  const method = request.method ?? 'GET';
  const context = identityContext(request, requestId);
  const write = async (): Promise<AuthenticatedSession> => {
    requireOrigin(request, allowedOrigins);
    return authenticatedWrite(request, identity);
  };

  if (method === 'POST' && pathname === '/api/v1/committees') {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 201, success(await stage3.createCommittee(auth, {
      name: body.name, visibility: body.visibility, operationMode: body.operationMode,
      activeRulePackageVersionId: body.activeRulePackageVersionId
    }, context), requestId));
    return true;
  }

  const snapshot = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/snapshot$/.exec(pathname);
  if (method === 'GET' && snapshot) {
    sendJson(response, 200, success(await stage3.snapshot(snapshot[1] as string,
      await optionalAuthentication(request, identity)), requestId));
    return true;
  }

  const committee = /^\/api\/v1\/committees\/([0-9a-f-]{36})$/.exec(pathname);
  if (committee && (method === 'PATCH' || method === 'DELETE')) {
    const auth = await write(); const body = await readJson(request); const id = committee[1] as string;
    const result = method === 'PATCH'
      ? await stage3.updateCommittee(auth, id, integerField(body, 'baseRevision'),
        (body.patch && typeof body.patch === 'object' && !Array.isArray(body.patch) ? body.patch : {}) as Record<string, unknown>, context)
      : await stage3.deleteCommittee(auth, id, integerField(body, 'baseRevision'), context);
    sendJson(response, 200, success(result, requestId));
    return true;
  }

  const archive = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/archive$/.exec(pathname);
  if (method === 'POST' && archive) {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 200, success(await stage3.archiveCommittee(auth, archive[1] as string,
      integerField(body, 'baseRevision'), context), requestId)); return true;
  }

  const chairs = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/chairs(?:\/([0-9a-f-]{36}))?$/.exec(pathname);
  if (chairs && ((method === 'POST' && !chairs[2]) || (method === 'DELETE' && chairs[2]))) {
    const auth = await write(); const body = await readJson(request);
    const userId = chairs[2] ?? stringField(body, 'userId') as string;
    sendJson(response, 200, success(await stage3.setChair(auth, chairs[1] as string, userId,
      method === 'POST', integerField(body, 'baseRevision'), context), requestId)); return true;
  }

  const operationMode = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/operation-mode$/.exec(pathname);
  if (method === 'POST' && operationMode) {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 200, success(await stage3.setOperationMode(auth, operationMode[1] as string,
      body.operationMode, integerField(body, 'baseRevision'), context), requestId)); return true;
  }

  const committeeStatus = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/status$/.exec(pathname);
  if (method === 'POST' && committeeStatus) {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 200, success(await stage3.setCommitteeStatus(auth, committeeStatus[1] as string,
      body.status, integerField(body, 'baseRevision'), context), requestId)); return true;
  }

  const seats = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/seats$/.exec(pathname);
  if (method === 'POST' && seats) {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 201, success(await stage3.createSeat(auth, seats[1] as string, body, context), requestId)); return true;
  }

  const assignments = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/seat-assignments$/.exec(pathname);
  if (method === 'POST' && assignments) {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 201, success(await stage3.assignSeat(auth, assignments[1] as string, body, context), requestId)); return true;
  }

  const invitations = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/seat-invitations(?:\/([0-9a-f-]{36})\/revoke)?$/.exec(pathname);
  if (method === 'POST' && invitations) {
    const auth = await write(); const body = await readJson(request);
    if (invitations[2]) {
      await stage3.revokeInvitation(auth, invitations[1] as string, invitations[2], context);
      sendJson(response, 200, success({revoked: true}, requestId));
    } else sendJson(response, 201, success(await stage3.createInvitation(auth, invitations[1] as string, body, context), requestId));
    return true;
  }

  if (method === 'POST' && pathname === '/api/v1/seat-invitations/redeem') {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 200, success(await stage3.redeemInvitation(auth, body.code, context), requestId)); return true;
  }

  if (method === 'GET' && pathname === '/api/v1/rule-packages') {
    sendJson(response, 200, success({rulePackages: await stage3.listRulePackages(
      await optionalAuthentication(request, identity))}, requestId)); return true;
  }
  if (method === 'POST' && pathname === '/api/v1/rule-packages/import') {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 201, success(await stage3.importRulePackage(auth, body, context), requestId)); return true;
  }

  const clone = /^\/api\/v1\/rule-packages\/([0-9a-f-]{36})\/clone$/.exec(pathname);
  if (method === 'POST' && clone) {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 201, success(await stage3.cloneRulePackage(auth, clone[1] as string, body, context), requestId)); return true;
  }
  const versions = /^\/api\/v1\/rule-packages\/([0-9a-f-]{36})\/versions$/.exec(pathname);
  if (method === 'POST' && versions) {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 201, success(await stage3.createRuleVersion(auth, versions[1] as string, body, context), requestId)); return true;
  }
  const ruleVersion = /^\/api\/v1\/rule-package-versions\/([0-9a-f-]{36})\/(validate|simulate)$/.exec(pathname);
  if (method === 'POST' && ruleVersion) {
    if (ruleVersion[2] === 'validate') {
      const auth = await write();
      sendJson(response, 200, success(await stage3.validateRuleVersion(auth, ruleVersion[1] as string), requestId));
    } else {
      const auth = await write(); const body = await readJson(request);
      sendJson(response, 200, success(await stage3.simulateRuleVersion(auth, ruleVersion[1] as string, body.facts), requestId));
    }
    return true;
  }
  const activate = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/rules\/activate$/.exec(pathname);
  if (method === 'POST' && activate) {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 200, success(await stage3.activateRules(auth, activate[1] as string,
      stringField(body, 'rulePackageVersionId') as string, integerField(body, 'baseRevision'), context), requestId)); return true;
  }
  const override = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/rules\/overrides$/.exec(pathname);
  if (method === 'POST' && override) {
    const auth = await write(); const body = await readJson(request);
    sendJson(response, 201, success(await stage3.overrideRule(auth, override[1] as string, body, context), requestId)); return true;
  }
  return false;
}

async function handleIdentityRequest(options: {
  request: IncomingMessage;
  response: ServerResponse;
  pathname: string;
  requestId: string;
  identity: IdentityService;
  allowedOrigins: readonly string[];
}): Promise<boolean> {
  const {request, response, pathname, requestId, identity, allowedOrigins} = options;
  const method = request.method ?? 'GET';
  const context = identityContext(request, requestId);
  const cookies = identityCookies(request);

  if (method === 'GET' && pathname === '/api/v1/bootstrap/status') {
    sendJson(response, 200, success({initialized: await identity.bootstrapStatus()}, requestId));
    return true;
  }

  if (method === 'POST' && pathname === '/api/v1/bootstrap/admin') {
    requireOrigin(request, allowedOrigins);
    const body = await readJson(request);
    const session = await identity.bootstrapAdmin({
      secret: stringField(body, 'secret', true),
      email: stringField(body, 'email') as string,
      displayName: stringField(body, 'displayName') as string,
      password: stringField(body, 'password') as string
    }, context);
    setSessionCookies(response, session);
    sendJson(response, 201, success({user: session.user, csrfToken: session.csrfToken}, requestId));
    return true;
  }

  if (method === 'POST' && pathname === '/api/v1/auth/login') {
    requireOrigin(request, allowedOrigins);
    const body = await readJson(request);
    const session = await identity.login({
      email: stringField(body, 'email') as string,
      password: stringField(body, 'password') as string,
      existingSessionToken: cookies.get(SESSION_COOKIE_NAME)
    }, context);
    setSessionCookies(response, session);
    sendJson(response, 200, success({user: session.user, csrfToken: session.csrfToken}, requestId));
    return true;
  }

  if (method === 'GET' && pathname === '/api/v1/auth/me') {
    const auth = await identity.authenticate(cookies.get(SESSION_COOKIE_NAME));
    sendJson(response, 200, success({user: auth.user}, requestId));
    return true;
  }

  if (method === 'POST' && pathname === '/api/v1/auth/logout') {
    requireOrigin(request, allowedOrigins);
    await authenticatedWrite(request, identity);
    await identity.logout(cookies.get(SESSION_COOKIE_NAME), context);
    response.setHeader('set-cookie', clearIdentityCookies());
    sendJson(response, 200, success({loggedOut: true}, requestId));
    return true;
  }

  if (method === 'POST' && pathname === '/api/v1/auth/change-password') {
    requireOrigin(request, allowedOrigins);
    const auth = await authenticatedWrite(request, identity);
    const body = await readJson(request);
    const session = await identity.changePassword(auth, {
      currentPassword: stringField(body, 'currentPassword') as string,
      newPassword: stringField(body, 'newPassword') as string
    }, context);
    setSessionCookies(response, session);
    sendJson(response, 200, success({user: session.user, csrfToken: session.csrfToken}, requestId));
    return true;
  }

  if (method === 'POST' && pathname === '/api/v1/auth/elevate') {
    requireOrigin(request, allowedOrigins);
    const auth = await authenticatedWrite(request, identity);
    const body = await readJson(request);
    const session = await identity.elevateSession(auth, stringField(body, 'password') as string, context);
    setSessionCookies(response, session);
    sendJson(response, 200, success({user: session.user, csrfToken: session.csrfToken}, requestId));
    return true;
  }

  if (method === 'GET' && pathname === '/api/v1/admin/users') {
    const auth = await identity.authenticate(cookies.get(SESSION_COOKIE_NAME));
    sendJson(response, 200, success({users: await identity.listUsers(auth)}, requestId));
    return true;
  }

  if (method === 'POST' && pathname === '/api/v1/admin/users') {
    requireOrigin(request, allowedOrigins);
    const auth = await authenticatedWrite(request, identity);
    const body = await readJson(request);
    const result = await identity.createUser(auth, {
      email: stringField(body, 'email') as string,
      displayName: stringField(body, 'displayName') as string
    }, context);
    sendJson(response, 201, success(result, requestId));
    return true;
  }

  const adminCommand = /^\/api\/v1\/admin\/users\/([0-9a-f-]{36})\/(reset-password|disable|revoke-sessions)$/.exec(pathname);
  if (method === 'POST' && adminCommand) {
    requireOrigin(request, allowedOrigins);
    const auth = await authenticatedWrite(request, identity);
    const targetUserId = adminCommand[1] as string;
    if (adminCommand[2] === 'reset-password') {
      sendJson(response, 200, success(await identity.resetPassword(auth, targetUserId, context), requestId));
    } else if (adminCommand[2] === 'disable') {
      await identity.disableUser(auth, targetUserId, context);
      sendJson(response, 200, success({disabled: true}, requestId));
    } else {
      await identity.revokeUserSessions(auth, targetUserId, context);
      sendJson(response, 200, success({revoked: true}, requestId));
    }
    return true;
  }

  return false;
}

function methodAllowed(request: IncomingMessage): void {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new AppError({code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.'});
  }
}

export function createRequestHandler(dependencies: AppDependencies): RequestListener {
  const startedAt = dependencies.now?.() ?? Date.now();
  const now = dependencies.now ?? Date.now;

  return (request, response) => {
    const requestId = requestIdFor(request);
    const requestStartedAt = process.hrtime.bigint();
    response.setHeader('x-request-id', requestId);

    void withRequestContext({requestId}, async () => {
      let pathname = '/';
      response.once('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - requestStartedAt) / 1_000_000;
        dependencies.logger.info('http.request.completed', {
          method: request.method,
          path: pathname,
          status: response.statusCode,
          durationMs: Number(durationMs.toFixed(3))
        });
      });

      try {
        const requestUrl = new URL(request.url || '/', 'http://quorum.local');
        pathname = requestUrl.pathname;

        if (dependencies.identity && await handleIdentityRequest({
          request,
          response,
          pathname,
          requestId,
          identity: dependencies.identity,
          allowedOrigins: dependencies.allowedOrigins ?? []
        })) return;

        const events = /^\/api\/v1\/committees\/([0-9a-f-]{36})\/events$/.exec(pathname);
        if (request.method === 'GET' && events && dependencies.identity && dependencies.realtime) {
          await streamCommitteeEvents({request, response, committeeId: events[1] as string, url: requestUrl,
            identity: dependencies.identity, realtime: dependencies.realtime});
          return;
        }

        if (dependencies.identity && dependencies.stage5 && await handleStage5Request({
          request, response, pathname, requestId, identity: dependencies.identity, stage5: dependencies.stage5,
          allowedOrigins: dependencies.allowedOrigins ?? []
        })) return;

        if (dependencies.identity && dependencies.stage4 && await handleStage4Request({
          request, response, pathname, requestId, identity: dependencies.identity, stage4: dependencies.stage4,
          allowedOrigins: dependencies.allowedOrigins ?? []
        })) return;

        if (dependencies.identity && dependencies.stage3 && await handleStage3Request({
          request, response, pathname, requestId, identity: dependencies.identity, stage3: dependencies.stage3,
          allowedOrigins: dependencies.allowedOrigins ?? []
        })) return;

        methodAllowed(request);

        if (pathname === '/health/live') {
          sendJson(response, 200, success({
            status: 'ok' as const,
            version: dependencies.version,
            uptimeSeconds: Math.max(0, Math.floor((now() - startedAt) / 1000))
          }, requestId));
          return;
        }

        if (pathname === '/health/ready') {
          const result = await dependencies.health.ready();
          if (!result.ready) {
            throw new AppError({
              code: 'SERVICE_NOT_READY',
              message: 'Service is not ready.',
              details: {checks: result.checks},
              expose: true
            });
          }
          sendJson(response, 200, success({status: 'ok' as const, checks: result.checks}, requestId));
          return;
        }

        if (pathname === '/api/v1/version') {
          const version: VersionInfo = {
            version: dependencies.version,
            contractVersion: CONTRACT_VERSION,
            ruleSchemaVersion: RULE_SCHEMA_VERSION,
            databaseMigrationVersion: dependencies.databaseMigrationVersion
          };
          sendJson(response, 200, success(version, requestId));
          return;
        }

        throw new AppError({code: 'NOT_FOUND', message: 'Resource not found.'});
      } catch (error) {
        const normalized = normalizeError(error, requestId);
        if (normalized.status >= 500) {
          dependencies.logger.error('http.request.failed', {
            method: request.method,
            path: pathname,
            status: normalized.status,
            error: normalized.internalError
          });
        }
        if (!response.headersSent) {
          sendJson(response, normalized.status, normalized.body);
        } else {
          response.destroy();
        }
      }
    });
  };
}

export function createApp(dependencies: AppDependencies): Server {
  return createServer(createRequestHandler(dependencies));
}
