import {timingSafeEqual} from 'node:crypto';
import {AppError} from './errors.js';

export const SESSION_COOKIE_NAME = '__Host-quorum_session';
export const CSRF_COOKIE_NAME = '__Host-quorum_csrf';
export const DELEGATE_FILE_COOKIE_NAME = '__Host-quorum_delegate_files';
export const DELEGATE_FILE_CSRF_COOKIE_NAME = '__Host-quorum_delegate_files_csrf';

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;
}

export function csrfCookie(token: string, maxAgeSeconds: number): string {
  return `${CSRF_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAgeSeconds}; Secure; SameSite=Lax`;
}

export function clearIdentityCookies(): string[] {
  return [
    `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
    `${CSRF_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; SameSite=Lax`
  ];
}

export function delegateFileCookies(token: string, csrf: string, maxAgeSeconds: number): string[] {
  return [
    `${DELEGATE_FILE_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`,
    `${DELEGATE_FILE_CSRF_COOKIE_NAME}=${csrf}; Path=/; Max-Age=${maxAgeSeconds}; Secure; SameSite=Lax`
  ];
}

export function verifyCsrf(cookieToken: string | undefined, headerToken: string | undefined): void {
  if (!cookieToken || !headerToken) {
    throw new AppError({reason: 'CSRF_EXPIRED', code: 'FORBIDDEN', message: 'CSRF validation failed.'});
  }
  const cookie = Buffer.from(cookieToken);
  const header = Buffer.from(headerToken);
  if (cookie.length !== header.length || !timingSafeEqual(cookie, header)) {
    throw new AppError({reason: 'CSRF_EXPIRED', code: 'FORBIDDEN', message: 'CSRF validation failed.'});
  }
}
