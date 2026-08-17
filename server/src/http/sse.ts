import type {IncomingMessage, ServerResponse} from 'node:http';
import type {CommitteeEventEnvelope} from '@quorum/contracts';
import type {IdentityService} from '../modules/identity/service.js';
import type {RealtimeAudience, RealtimeService} from '../modules/realtime/service.js';
import {selectEventCursor} from '../modules/realtime/service.js';
import {parseCookies, SESSION_COOKIE_NAME} from './cookies.js';

const activeStreams = new Map<string, ServerResponse>();

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function writeEvent(response: ServerResponse, event: CommitteeEventEnvelope): void {
  response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export async function streamCommitteeEvents(input: {
  request: IncomingMessage;
  response: ServerResponse;
  committeeId: string;
  url: URL;
  identity: IdentityService;
  realtime: RealtimeService;
}): Promise<void> {
  const {request, response, committeeId, url, identity, realtime} = input;
  const token = parseCookies(header(request, 'cookie')).get(SESSION_COOKIE_NAME);
  const authenticate = async () => token ? identity.authenticate(token) : undefined;
  let auth = await authenticate();
  let access = await realtime.authorize(committeeId, auth);
  let cursor = selectEventCursor({latestSequence: access.latestSequence,
    retainedFromSequence: access.retainedFromSequence, after: url.searchParams.get('after') ?? undefined,
    lastEventId: header(request, 'last-event-id')});
  const clientId = url.searchParams.get('clientId');
  const streamKey = clientId && /^[A-Za-z0-9_-]{8,128}$/.test(clientId)
    ? `${committeeId}:${auth?.sessionId ?? 'anonymous'}:${clientId}` : undefined;
  if (streamKey) activeStreams.get(streamKey)?.end();
  if (streamKey) activeStreams.set(streamKey, response);

  response.statusCode = 200;
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('cache-control', 'no-cache, no-transform');
  response.setHeader('connection', 'keep-alive');
  response.setHeader('x-accel-buffering', 'no');
  response.flushHeaders();
  response.write(': connected\n\n');

  let closed = false; let pollTimer: NodeJS.Timeout | undefined; let heartbeatTimer: NodeJS.Timeout | undefined;
  let audience: RealtimeAudience = access.audience;
  const close = () => {
    if (closed) return;
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (streamKey && activeStreams.get(streamKey) === response) activeStreams.delete(streamKey);
    if (!response.writableEnded) response.end();
  };
  const sendAvailable = async () => {
    const events = await realtime.events(committeeId, cursor, audience);
    for (const event of events) { writeEvent(response, event); cursor = event.id; }
  };
  await sendAvailable();
  pollTimer = setInterval(() => { void sendAvailable().catch(close); }, 1_000);
  heartbeatTimer = setInterval(() => { void (async () => {
    auth = await authenticate();
    access = await realtime.authorize(committeeId, auth);
    if (access.audience !== audience) return close();
    response.write(`: heartbeat ${Date.now()}\n\n`);
  })().catch(close); }, 15_000);
  pollTimer.unref(); heartbeatTimer.unref();
  request.once('close', close);
}
