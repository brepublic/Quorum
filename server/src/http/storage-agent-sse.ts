import type {IncomingMessage, ServerResponse} from 'node:http';
import type {Stage7StorageAgentService} from '../modules/storage-agent/service.js';

export async function streamStorageAgentEvents(input: {
  request: IncomingMessage;
  response: ServerResponse;
  credential: string;
  leaseGeneration: number;
  service: Stage7StorageAgentService;
}): Promise<void> {
  const {request, response, credential, leaseGeneration, service} = input;
  let cursor = await service.eventCursor(credential, leaseGeneration);
  response.statusCode = 200;
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('cache-control', 'no-cache, no-transform');
  response.setHeader('connection', 'keep-alive');
  response.setHeader('x-accel-buffering', 'no');
  response.flushHeaders();
  response.write('event: wake\ndata: {}\n\n');

  let closed = false;
  let polling = false;
  let pollTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (!response.writableEnded) response.end();
  };
  const poll = async () => {
    if (closed || polling) return;
    polling = true;
    try {
      const next = await service.eventCursor(credential, leaseGeneration);
      if (next !== cursor) {
        cursor = next;
        response.write('event: wake\ndata: {}\n\n');
      }
    } finally {
      polling = false;
    }
  };
  pollTimer = setInterval(() => { void poll().catch(close); }, 1_000);
  heartbeatTimer = setInterval(() => {
    if (!closed) response.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15_000);
  pollTimer.unref();
  heartbeatTimer.unref();
  request.once('close', close);
}
