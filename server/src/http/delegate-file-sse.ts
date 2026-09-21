import type {IncomingMessage, ServerResponse} from 'node:http';
import type {DelegateFileService} from '../modules/delegate-files/service.js';
import {DELEGATE_FILE_COOKIE_NAME, parseCookies} from './cookies.js';

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]; return Array.isArray(value) ? value[0] : value;
}

export async function streamDelegateFileEvents(input: {
  request: IncomingMessage; response: ServerResponse; url: URL; service: DelegateFileService;
}): Promise<void> {
  const {request, response, url, service} = input;
  const credential = parseCookies(header(request, 'cookie')).get(DELEGATE_FILE_COOKIE_NAME);
  await service.authenticate(credential);
  const supplied = header(request, 'last-event-id') ?? url.searchParams.get('after') ?? '0';
  let cursor = /^(0|[1-9]\d*)$/.test(supplied) ? Number(supplied) : 0;
  response.statusCode = 200;
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('cache-control', 'no-cache, no-transform');
  response.setHeader('connection', 'keep-alive');
  response.setHeader('x-accel-buffering', 'no');
  response.flushHeaders(); response.write(': connected\n\n');
  let closed = false; let polling = false; let poll: NodeJS.Timeout | undefined; let heartbeat: NodeJS.Timeout | undefined;
  const close = () => { if (closed) return; closed = true; if (poll) clearInterval(poll);
    if (heartbeat) clearInterval(heartbeat); if (!response.writableEnded) response.end(); };
  const send = async () => {
    if (closed || polling) return; polling = true;
    try {
    const available = await service.events(credential, cursor); cursor = available.cursor;
    for (const event of available.rows) {
      response.write(`id: ${event.id}\nevent: ${event.kind === 'rejected' ? 'file.rejected' : 'file.available'}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    } finally {polling = false;}
  };
  await send();
  poll = setInterval(() => { void send().catch(close); }, 1_000);
  heartbeat = setInterval(() => { if (closed) return; void service.storageAvailable(credential).then(healthy => {
    response.write(`event: portal.status\ndata: ${JSON.stringify({storageAvailable: healthy})}\n\n`);
  }).catch(close); }, 15_000);
  poll.unref(); heartbeat.unref(); request.once('close', close);
}
