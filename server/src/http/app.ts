import {randomUUID} from 'node:crypto';
import {createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse} from 'node:http';
import {CONTRACT_VERSION, success, type VersionInfo} from '@quorum/contracts';
import {RULE_SCHEMA_VERSION} from '@quorum/rule-schema';
import type {Logger} from '../logger.js';
import {withRequestContext} from '../request-context.js';
import type {HealthService} from '../operations/health.js';
import type {IdentityService, RequestIdentityContext, SessionResult} from '../modules/identity/service.js';
import type {AuthenticatedSession} from '../modules/identity/store.js';
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

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface AppDependencies {
  health: HealthService;
  logger: Logger;
  version: string;
  databaseMigrationVersion: number;
  now?: () => number;
  identity?: IdentityService;
  allowedOrigins?: string[];
}

const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const MAX_JSON_BODY_BYTES = 64 * 1024;

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
        pathname = new URL(request.url || '/', 'http://quorum.local').pathname;

        if (dependencies.identity && await handleIdentityRequest({
          request,
          response,
          pathname,
          requestId,
          identity: dependencies.identity,
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
