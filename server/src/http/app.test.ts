// @vitest-environment node

import {EventEmitter, once} from 'node:events';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {describe, expect, it} from 'vitest';
import {createRequestHandler} from './app';
import {createLogger} from '../logger';
import type {ReadyCheckResult} from '../operations/health';

class TestResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  destroyed = false;
  body = '';
  readonly headers = new Map<string, string | number>();

  setHeader(name: string, value: string | number): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  getHeader(name: string): string | number | undefined {
    return this.headers.get(name.toLowerCase());
  }

  end(body?: string): this {
    this.headersSent = true;
    this.body = body ?? '';
    queueMicrotask(() => this.emit('finish'));
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

const readyResult: ReadyCheckResult = {
  ready: true,
  checks: {
    database: {status: 'ok', migrationVersion: 1},
    storage: {status: 'ok'}
  }
};

async function request(options: {
  path: string;
  method?: string;
  requestId?: string;
  ready?: ReadyCheckResult;
  metrics?: string;
}) {
  const logs: string[] = [];
  const handler = createRequestHandler({
    health: {ready: async () => options.ready ?? readyResult},
    logger: createLogger(line => logs.push(line)),
    version: 'test-version',
    databaseMigrationVersion: 1,
    storageMetrics: options.metrics === undefined ? undefined : {renderMetrics: async () => options.metrics as string},
    now: () => 10_000
  });
  const incoming = {
    method: options.method ?? 'GET',
    url: options.path,
    headers: options.requestId ? {'x-request-id': options.requestId} : {}
  } as IncomingMessage;
  const response = new TestResponse();
  const finished = once(response, 'finish');
  handler(incoming, response as unknown as ServerResponse);
  await finished;
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    // Non-JSON infrastructure endpoints expose their raw body separately.
  }
  return {
    status: response.statusCode,
    headers: response.headers,
    body,
    rawBody: response.body,
    logs
  };
}

describe('HTTP infrastructure contract', () => {
  it('serves liveness with a request ID and success envelope', async () => {
    const response = await request({path: '/health/live', requestId: 'test-request-1'});

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('test-request-1');
    expect(response.body).toEqual({
      data: {status: 'ok', version: 'test-version', uptimeSeconds: 0},
      meta: {requestId: 'test-request-1'}
    });
  });

  it('reports readiness failures through the unified error envelope', async () => {
    const notReady: ReadyCheckResult = {
      ready: false,
      checks: {database: {status: 'error'}, storage: {status: 'ok'}}
    };
    const response = await request({path: '/health/ready', ready: notReady});
    const error = response.body.error as {code: string; requestId: string; details: unknown};

    expect(response.status).toBe(503);
    expect(error.code).toBe('SERVICE_NOT_READY');
    expect(error.requestId).toBe(response.headers.get('x-request-id'));
    expect(error.details).toEqual({checks: notReady.checks});
  });

  it('reports critical capacity without taking read-only service paths out of readiness', async () => {
    const response = await request({path: '/health/ready', ready: {ready: true, checks: {
      database: {status: 'ok', migrationVersion: 19},
      storage: {status: 'critical', usagePercent: 90, availableBytes: 100}
    }}});
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({data: expect.objectContaining({checks: expect.objectContaining({
      storage: {status: 'critical', usagePercent: 90, availableBytes: 100}
    })})}));
  });

  it('uses the same error format for unknown routes and emits structured request logs', async () => {
    const response = await request({path: '/missing'});
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found.',
        requestId: response.headers.get('x-request-id')
      }
    });

    const completed = response.logs.map(line => JSON.parse(line) as Record<string, unknown>)
      .find(line => line.event === 'http.request.completed');
    expect(completed).toEqual(expect.objectContaining({
      level: 'info',
      method: 'GET',
      path: '/missing',
      status: 404
    }));
  });

  it('serves storage metrics as non-cacheable Prometheus text', async () => {
    const response = await request({path: '/metrics', metrics: 'quorum_storage_usage_ratio 0.8\n'});
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.rawBody).toBe('quorum_storage_usage_ratio 0.8\n');
  });

  it('rejects non-read methods with a stable error code', async () => {
    const response = await request({path: '/health/live', method: 'POST'});
    expect(response.status).toBe(405);
    expect(response.body).toEqual(expect.objectContaining({
      error: expect.objectContaining({code: 'METHOD_NOT_ALLOWED'})
    }));
  });

  it('does not expose internal readiness errors or stack traces', async () => {
    const logs: string[] = [];
    const handler = createRequestHandler({
      health: {ready: async () => { throw new Error('database password leaked'); }},
      logger: createLogger(line => logs.push(line)),
      version: 'test-version',
      databaseMigrationVersion: 1
    });
    const incoming = {method: 'GET', url: '/health/ready', headers: {}} as IncomingMessage;
    const response = new TestResponse();
    const finished = once(response, 'finish');
    handler(incoming, response as unknown as ServerResponse);
    await finished;

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('database password leaked');
    expect(JSON.parse(response.body)).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The server could not complete the request.',
        requestId: response.headers.get('x-request-id')
      }
    });
    expect(logs.some(line => line.includes('database password leaked'))).toBe(true);
  });
});
