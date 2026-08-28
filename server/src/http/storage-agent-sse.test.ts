// @vitest-environment node

import {EventEmitter} from 'node:events';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {Stage7StorageAgentService} from '../modules/storage-agent/service';
import {streamStorageAgentEvents} from './storage-agent-sse';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Storage Agent SSE', () => {
  it('emits content-free wake events only when the durable cursor changes', async () => {
    vi.useFakeTimers();
    const request = new EventEmitter() as IncomingMessage;
    const writes: string[] = [];
    const response = {statusCode: 0, writableEnded: false, setHeader: vi.fn(), flushHeaders: vi.fn(),
      write: vi.fn((value: string) => { writes.push(value); return true; }),
      end: vi.fn(function(this: {writableEnded: boolean}) { this.writableEnded = true; })} as unknown as ServerResponse;
    const eventCursor = vi.fn().mockResolvedValueOnce('cursor-1').mockResolvedValueOnce('cursor-1')
      .mockResolvedValueOnce('cursor-2');
    const service = {eventCursor} as unknown as Stage7StorageAgentService;
    await streamStorageAgentEvents({request, response, credential: 'credential', leaseGeneration: 7, service});
    expect(writes).toEqual(['event: wake\ndata: {}\n\n']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(writes.filter(value => value.startsWith('event: wake'))).toHaveLength(2);
    expect(writes.join('')).not.toMatch(/cursor|credential|token|sha256|path/i);
    request.emit('close');
    expect(response.end).toHaveBeenCalledOnce();
  });
});
