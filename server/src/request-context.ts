import {AsyncLocalStorage} from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

export function withRequestContext<T>(context: RequestContext, callback: () => T): T {
  return requestContext.run(context, callback);
}

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}
