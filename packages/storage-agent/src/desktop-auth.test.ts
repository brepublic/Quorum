// @vitest-environment node
import {createServer} from 'node:https';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {DesktopAccount, normalizeDesktopSite} from './desktop-auth';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {for (const fn of cleanup.splice(0).reverse()) await fn();});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'quorum-auth-'));
  cleanup.push(() => rm(root, {recursive: true, force: true}));
  const key = join(root, 'key.pem'), certificate = join(root, 'ca.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key,
    '-out', certificate, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], {stdio: 'ignore'});
  const seen: {path: string; cookie: string; csrf: string; origin: string; body: string}[] = [];
  const server = createServer({key: await readFile(key), cert: await readFile(certificate)}, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({path: req.url!, cookie: req.headers.cookie ?? '', csrf: String(req.headers['x-csrf-token'] ?? ''), origin: req.headers.origin ?? '', body});
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v1/auth/login') res.setHeader('set-cookie', [
      '__Host-quorum_session=secret; Secure; HttpOnly; Path=/', '__Host-quorum_csrf=csrf; Secure; Path=/']);
    if (req.url === '/api/v1/expired') {res.statusCode = 401; res.end(JSON.stringify({error: {code: 'AUTHENTICATION_REQUIRED'}})); return;}
    if (req.url === '/api/v1/broken') {res.end('<html>secret</html>'); return;}
    if (req.url === '/api/v1/redirect') {res.statusCode = 302; res.setHeader('location', 'https://other.example.com'); res.end('{}'); return;}
    res.end(JSON.stringify({data: {ok: true}}));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `https://127.0.0.1:${(server.address() as {port: number}).port}`;
  return {origin, certificate, seen};
}
describe('desktop account HTTPS boundary', () => {
  it('normalizes domains but rejects non-HTTPS, credentials, paths and query parameters', () => {
    expect(normalizeDesktopSite(' quorum.example.com ')).toBe('https://quorum.example.com');
    for (const site of ['http://example.com', 'https://u:p@example.com', 'https://example.com/a', 'https://example.com/?token=x']) {
      expect(() => normalizeDesktopSite(site)).toThrow('HTTPS_REQUIRED');
    }
  });
  it('uses account cookies and CSRF only in its origin, logs out and clears them', async () => {
    const f = await fixture(); const account = new DesktopAccount(f.origin, f.certificate);
    await account.call('/api/v1/auth/login', {email: 'chair@example.com', password: 'private-password'});
    await account.call('/api/v1/storage-agent/committees');
    expect(f.seen[1]).toMatchObject({cookie: '__Host-quorum_session=secret; __Host-quorum_csrf=csrf', csrf: 'csrf', origin: f.origin});
    await account.logout();
    expect(f.seen[2].path).toBe('/api/v1/auth/logout');
    await account.call('/api/v1/storage-agent/committees');
    expect(f.seen[3].cookie).toBe('');
    await expect(account.call('https://other.example.com/api/v1/auth/me')).rejects.toThrow('INVALID_REFERENCE');
  });
  it('enforces certificate verification, rejects redirects and masks invalid response bodies', async () => {
    const f = await fixture();
    await expect(new DesktopAccount(f.origin).call('/api/v1/auth/me')).rejects.toBeDefined();
    const account = new DesktopAccount(f.origin, f.certificate);
    await expect(account.call('/api/v1/broken')).rejects.toThrow('INVALID_RESPONSE');
    await expect(account.call('/api/v1/redirect')).rejects.toThrow('INVALID_RESPONSE');
    await account.call('/api/v1/auth/login', {});
    await expect(account.call('/api/v1/expired')).rejects.toMatchObject({code: 'AUTHENTICATION_REQUIRED'});
    await account.call('/api/v1/auth/me'); expect(f.seen.at(-1)!.cookie).toBe('');
  });
});
