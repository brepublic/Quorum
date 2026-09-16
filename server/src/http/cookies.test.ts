// @vitest-environment node

import {describe, expect, it} from 'vitest';
import {csrfCookie, delegateFileCookies, sessionCookie, verifyCsrf} from './cookies';

describe('identity cookies and CSRF', () => {
  it('sets the required Session Cookie attributes', () => {
    const cookie = sessionCookie('opaque', 3600);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Domain=');
  });

  it('keeps the CSRF cookie readable but secure and same-site', () => {
    const cookie = csrfCookie('csrf', 3600);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('HttpOnly');
  });

  it('rejects missing or mismatched CSRF tokens', () => {
    expect(() => verifyCsrf('same', 'same')).not.toThrow();
    expect(() => verifyCsrf(undefined, 'same')).toThrow(/CSRF/);
    expect(() => verifyCsrf('same', 'wrong')).toThrow(/CSRF/);
  });

  it('uses a separate HttpOnly delegate credential and readable CSRF cookie', () => {
    const [credential, csrf] = delegateFileCookies('opaque', 'csrf', 3600);
    expect(credential).toContain('__Host-quorum_delegate_files=opaque');
    expect(credential).toContain('Secure; HttpOnly; SameSite=Lax');
    expect(csrf).toContain('__Host-quorum_delegate_files_csrf=csrf');
    expect(csrf).toContain('Secure; SameSite=Lax'); expect(csrf).not.toContain('HttpOnly');
  });
});
