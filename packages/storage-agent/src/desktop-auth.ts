import {request} from 'node:https';
import {readFile} from 'node:fs/promises';
import {AgentApiError} from './errors.js';

export function normalizeDesktopSite(value: string): string {
  let url: URL;
  try {url = new URL(value.includes('://') ? value.trim() : `https://${value.trim()}`);} catch {throw new Error('HTTPS_REQUIRED');}
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('HTTPS_REQUIRED');
  }
  return url.origin;
}

/** Account cookies stay in this bridge process and are bound to one immutable origin. */
export class DesktopAccount {
  private cookies = new Map<string, string>();
  constructor(readonly origin: string, private readonly certificate = '') {}
  async call<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    if (!path.startsWith('/api/v1/')) throw new Error('INVALID_REFERENCE');
    const ca = this.certificate ? await readFile(this.certificate) : undefined;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const req = request(new URL(path, this.origin), {method: payload === undefined ? 'GET' : 'POST', ca,
        rejectUnauthorized: true, headers: {origin: this.origin,
          cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
          'x-csrf-token': this.cookies.get('__Host-quorum_csrf') ?? '',
          ...(payload === undefined ? {} : {'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)})}}, res => {
        res.setEncoding('utf8');
        let source = '';
        res.on('error', reject);
        res.on('data', chunk => {
          source += chunk;
          if (source.length > 2 * 1024 * 1024) req.destroy(new Error('INVALID_RESPONSE'));
        });
        res.on('end', () => {
          try {
            const data = JSON.parse(source);
            if ((res.statusCode ?? 500) >= 400) {
              if (res.statusCode === 401) this.clear();
              throw new AgentApiError(res.statusCode!, data.error?.code ?? 'HTTP_ERROR', 'Account request failed.',
                undefined, {reason: data.error?.reason});
            }
            if (!data || !('data' in data) || (res.statusCode ?? 500) >= 300) throw new Error('INVALID_RESPONSE');
            for (const cookie of res.headers['set-cookie'] ?? []) {
              const pair = cookie.split(';')[0]!; const index = pair.indexOf('=');
              const key = pair.slice(0, index);
              if (['__Host-quorum_session', '__Host-quorum_csrf'].includes(key)) this.cookies.set(key, pair.slice(index + 1));
            }
            resolve(data.data as T);
          } catch (error) {reject(error instanceof SyntaxError ? new Error('INVALID_RESPONSE') : error);}
        });
      });
      req.setTimeout(15000, () => req.destroy(new Error('ETIMEDOUT')));
      req.on('error', reject); req.end(payload);
    });
  }
  clear() {this.cookies.clear();}
  async logout() {
    try {if (this.cookies.size) await this.call('/api/v1/auth/logout', {});} finally {this.clear();}
  }
}
