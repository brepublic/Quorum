import {randomUUID} from 'node:crypto';
import {createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse} from 'node:http';
import {CONTRACT_VERSION, success, type VersionInfo} from '@quorum/contracts';
import {RULE_SCHEMA_VERSION} from '@quorum/rule-schema';
import type {Logger} from '../logger.js';
import {withRequestContext} from '../request-context.js';
import type {HealthService} from '../operations/health.js';
import {AppError, normalizeError} from './errors.js';

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface AppDependencies {
  health: HealthService;
  logger: Logger;
  version: string;
  databaseMigrationVersion: number;
  now?: () => number;
}

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
