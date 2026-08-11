export const THEME_SCHEMA = 'quorum-theme' as const;
export const THEME_SCHEMA_VERSION = 1 as const;
export const THEME_API_VERSION = '1' as const;
export const DEFAULT_THEME_ID = 'builtin:default';
export const THEME_FILE_EXTENSION = '.quorum-theme.json';

export const MAX_THEME_FILE_BYTES = 3 * 1024 * 1024;
export const MAX_THEME_CSS_LENGTH = 2 * 1024 * 1024;

export interface ThemeManifest {
  id: string;
  name: string;
  version: string;
  author: string;
  description?: string;
  quorumThemeApi: typeof THEME_API_VERSION;
  colorScheme?: 'light' | 'dark' | 'auto';
}

export interface ThemePackage {
  schema: typeof THEME_SCHEMA;
  schemaVersion: typeof THEME_SCHEMA_VERSION;
  manifest: ThemeManifest;
  css: string;
}

export const DEFAULT_THEME: ThemePackage = {
  schema: THEME_SCHEMA,
  schemaVersion: THEME_SCHEMA_VERSION,
  manifest: {
    id: DEFAULT_THEME_ID,
    name: 'Quorum Default',
    version: '1.0.0',
    author: 'Quorum',
    description: 'The built-in Quorum interface. It inherits the application styles without adding overrides.',
    quorumThemeApi: THEME_API_VERSION,
    colorScheme: 'light'
  },
  css: ''
};

export class ThemePackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThemePackageError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(
  source: Record<string, unknown>,
  key: string,
  label: string,
  maxLength: number
): string {
  const value = source[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ThemePackageError(`${label} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new ThemePackageError(`${label} must not exceed ${maxLength} characters.`);
  }
  return value.trim();
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
  label: string,
  maxLength: number
): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ThemePackageError(`${label} must be a string.`);
  }
  if (value.length > maxLength) {
    throw new ThemePackageError(`${label} must not exceed ${maxLength} characters.`);
  }
  return value.trim() || undefined;
}

function validateCss(css: string) {
  if (css.length > MAX_THEME_CSS_LENGTH) {
    throw new ThemePackageError(`Theme CSS exceeds the ${MAX_THEME_CSS_LENGTH} character limit.`);
  }

  const normalizedCss = css
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\(.)/gs, '$1');

  if (/@(?:import|charset|namespace)\b/i.test(normalizedCss)) {
    throw new ThemePackageError('Theme CSS cannot use @import, @charset, or @namespace.');
  }

  const cssWithoutEmbeddedData = normalizedCss.replace(
    /data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*(?:;base64)?,[a-z0-9+/=%._~-]*/gi,
    'data:embedded'
  );
  if (/(?:https?|file|ftp|blob):|["']\s*\/\//i.test(cssWithoutEmbeddedData)) {
    throw new ThemePackageError('Theme CSS cannot reference external resources. Embed resources as base64 data URLs.');
  }

  const urlPattern = /url\(\s*(["']?)(.*?)\1\s*\)/gis;
  for (const match of normalizedCss.matchAll(urlPattern)) {
    const value = match[2].trim();
    if (value && !value.startsWith('data:') && !value.startsWith('#')) {
      throw new ThemePackageError('Theme resources must use embedded data URLs; external and relative URLs are not allowed.');
    }
  }
}

export function parseThemePackage(source: string): ThemePackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new ThemePackageError('The selected file is not valid JSON.');
  }

  if (!isRecord(parsed)) {
    throw new ThemePackageError('The theme package must be a JSON object.');
  }
  if (parsed.schema !== THEME_SCHEMA || parsed.schemaVersion !== THEME_SCHEMA_VERSION) {
    throw new ThemePackageError(`Unsupported theme schema. Expected ${THEME_SCHEMA} version ${THEME_SCHEMA_VERSION}.`);
  }
  if (!isRecord(parsed.manifest)) {
    throw new ThemePackageError('The theme package is missing its manifest.');
  }

  const manifestSource = parsed.manifest;
  const id = requiredString(manifestSource, 'id', 'Theme id', 64);
  if (id !== DEFAULT_THEME_ID && !/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(id)) {
    throw new ThemePackageError('Theme id must contain 2-64 letters, numbers, dots, underscores, or hyphens.');
  }
  if (id !== DEFAULT_THEME_ID && id.toLowerCase().startsWith('builtin')) {
    throw new ThemePackageError('Imported themes cannot use a reserved built-in id.');
  }
  if (manifestSource.quorumThemeApi !== THEME_API_VERSION) {
    throw new ThemePackageError(`This theme requires an unsupported Quorum theme API. Expected ${THEME_API_VERSION}.`);
  }

  const colorScheme = manifestSource.colorScheme;
  if (colorScheme !== undefined && colorScheme !== 'light' && colorScheme !== 'dark' && colorScheme !== 'auto') {
    throw new ThemePackageError('colorScheme must be light, dark, or auto.');
  }
  if (typeof parsed.css !== 'string') {
    throw new ThemePackageError('The theme package css field must be a string.');
  }
  validateCss(parsed.css);

  return {
    schema: THEME_SCHEMA,
    schemaVersion: THEME_SCHEMA_VERSION,
    manifest: {
      id,
      name: requiredString(manifestSource, 'name', 'Theme name', 80),
      version: requiredString(manifestSource, 'version', 'Theme version', 32),
      author: requiredString(manifestSource, 'author', 'Theme author', 80),
      description: optionalString(manifestSource, 'description', 'Theme description', 500),
      quorumThemeApi: THEME_API_VERSION,
      colorScheme
    },
    css: parsed.css
  };
}

export function serializeThemePackage(theme: ThemePackage): string {
  return `${JSON.stringify(theme, null, 2)}\n`;
}

export function themeFileName(theme: ThemePackage): string {
  const safeName = theme.manifest.name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'quorum-theme';
  return `${safeName}-${theme.manifest.version}${THEME_FILE_EXTENSION}`;
}

export interface ThemeRoute {
  page: string;
  section: 'public' | 'account' | 'committee' | 'system';
}

export function classifyThemeRoute(pathname: string): ThemeRoute {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return {page: 'home', section: 'public'};
  if (path === '/onboard' || path === '/committees') return {page: 'onboard', section: 'account'};
  if (path === '/templates') return {page: 'templates', section: 'account'};
  if (path === '/countries') return {page: 'countries', section: 'account'};
  if (path === '/admin') return {page: 'account-admin', section: 'account'};

  const committeeMatch = path.match(/^\/committees\/[^/]+(?:\/([^/]+))?/);
  if (committeeMatch) {
    const route = committeeMatch[1];
    const pageByRoute: Record<string, string> = {
      setup: 'committee-setup',
      'roll-call': 'committee-roll-call',
      stats: 'committee-stats',
      unmod: 'committee-unmod',
      motions: 'committee-motions',
      notes: 'committee-notes',
      posts: 'committee-posts',
      settings: 'committee-settings',
      help: 'committee-help',
      caucuses: 'committee-caucus',
      resolutions: 'committee-resolution',
      strawpolls: 'committee-strawpoll'
    };
    return {page: route ? pageByRoute[route] ?? 'committee-unknown' : 'committee-home', section: 'committee'};
  }

  return {page: 'not-found', section: 'system'};
}
