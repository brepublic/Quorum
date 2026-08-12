export const THEME_SCHEMA = 'quorum-theme' as const;
export const LEGACY_THEME_SCHEMA_VERSION = 1 as const;
export const THEME_SCHEMA_VERSION = 2 as const;
export const LEGACY_THEME_API_VERSION = '1' as const;
export const THEME_API_VERSION = '2' as const;
export const DEFAULT_THEME_ID = 'builtin:default';
export const THEME_FILE_EXTENSION = '.quorum-theme.json';

export const MAX_THEME_FILE_BYTES = 3 * 1024 * 1024;
export const MAX_THEME_CSS_LENGTH = 2 * 1024 * 1024;

export type ThemeColorScheme = 'light' | 'dark';
export type ThemeDensity = 'compact' | 'comfortable' | 'spacious';
export type ThemeFontFamily = 'system' | 'humanist' | 'rounded' | 'monospace';
export type ThemeFontScale = 'small' | 'standard' | 'large';
export type ThemeRadius = 'square' | 'soft' | 'rounded';
export type ThemeControlShape = 'rounded' | 'pill';
export type ThemeSurface = 'solid' | 'translucent';
export type ThemeDepth = 'flat' | 'subtle' | 'elevated';
export type ThemeMotionPreset = 'none' | 'reduced' | 'standard' | 'fluid';
export type ThemeButtonStyle = 'filled' | 'tinted';
export type ThemeSwitchStyle = 'ios' | 'compact';
export type ThemeNavigationStyle = 'bar' | 'floating';
export type ThemeTableStyle = 'plain' | 'cards';
export type ThemeContentWidth = 'readable' | 'wide' | 'full';

export const THEME_PAGES = [
  'home',
  'onboard',
  'templates',
  'countries',
  'account-admin',
  'committee-home',
  'committee-setup',
  'committee-roll-call',
  'committee-motions',
  'committee-caucus',
  'committee-unmod',
  'committee-resolution',
  'committee-strawpoll',
  'committee-notes',
  'committee-posts',
  'committee-stats',
  'committee-settings',
  'committee-help',
  'committee-unknown',
  'not-found'
] as const;

export type ThemePage = typeof THEME_PAGES[number];

interface ThemeManifestBase {
  id: string;
  name: string;
  version: string;
  author: string;
  description?: string;
  colorScheme: ThemeColorScheme | 'auto';
}

export interface LegacyThemeManifest extends ThemeManifestBase {
  quorumThemeApi: typeof LEGACY_THEME_API_VERSION;
}

export interface TokenThemeManifest extends ThemeManifestBase {
  quorumThemeApi: typeof THEME_API_VERSION;
  colorScheme: ThemeColorScheme;
}

export type ThemeManifest = LegacyThemeManifest | TokenThemeManifest;

export interface ThemePalette {
  canvas: string;
  surface: string;
  surfaceRaised: string;
  text: string;
  textMuted: string;
  accent: string;
  accentText: string;
  success: string;
  successText: string;
  warning: string;
  warningText: string;
  danger: string;
  dangerText: string;
  border: string;
  focus: string;
}

export interface ThemeSettings {
  palette: ThemePalette;
  typography: {
    fontFamily: ThemeFontFamily;
    scale: ThemeFontScale;
  };
  density: ThemeDensity;
  shape: {
    radius: ThemeRadius;
    controls: ThemeControlShape;
  };
  materials: {
    surface: ThemeSurface;
    depth: ThemeDepth;
  };
  motion: {
    preset: ThemeMotionPreset;
  };
  components: {
    buttons: ThemeButtonStyle;
    switches: ThemeSwitchStyle;
    navigation: ThemeNavigationStyle;
    tables: ThemeTableStyle;
  };
  layout: {
    contentWidth: ThemeContentWidth;
    pageWidths: Partial<Record<ThemePage, ThemeContentWidth>>;
  };
}

export interface LegacyThemePackage {
  schema: typeof THEME_SCHEMA;
  schemaVersion: typeof LEGACY_THEME_SCHEMA_VERSION;
  manifest: LegacyThemeManifest;
  css: string;
}

export interface TokenThemePackage {
  schema: typeof THEME_SCHEMA;
  schemaVersion: typeof THEME_SCHEMA_VERSION;
  manifest: TokenThemeManifest;
  settings: ThemeSettings;
}

export type ThemePackage = LegacyThemePackage | TokenThemePackage;

export const DEFAULT_THEME: LegacyThemePackage = {
  schema: THEME_SCHEMA,
  schemaVersion: LEGACY_THEME_SCHEMA_VERSION,
  manifest: {
    id: DEFAULT_THEME_ID,
    name: 'Quorum Default',
    version: '1.0.0',
    author: 'Quorum',
    description: 'The built-in Quorum interface. It inherits the application styles without adding overrides.',
    quorumThemeApi: LEGACY_THEME_API_VERSION,
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

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ThemePackageError(`${label} must be an object.`);
  return value;
}

function assertAllowedKeys(source: Record<string, unknown>, allowed: readonly string[], label: string) {
  const unexpected = Object.keys(source).filter(key => !allowed.includes(key));
  if (unexpected.length) throw new ThemePackageError(`${label} contains unsupported fields: ${unexpected.join(', ')}.`);
}

function requiredString(source: Record<string, unknown>, key: string, label: string, maxLength: number): string {
  const value = source[key];
  if (typeof value !== 'string' || !value.trim()) throw new ThemePackageError(`${label} must be a non-empty string.`);
  if (value.length > maxLength) throw new ThemePackageError(`${label} must not exceed ${maxLength} characters.`);
  return value.trim();
}

function optionalString(source: Record<string, unknown>, key: string, label: string, maxLength: number): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ThemePackageError(`${label} must be a string.`);
  if (value.length > maxLength) throw new ThemePackageError(`${label} must not exceed ${maxLength} characters.`);
  return value.trim() || undefined;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string, fallback?: T): T {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ThemePackageError(`${label} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

function parseManifest(source: Record<string, unknown>, api: '1' | '2'): LegacyThemeManifest | TokenThemeManifest {
  assertAllowedKeys(source, ['id', 'name', 'version', 'author', 'description', 'quorumThemeApi', 'colorScheme'], 'manifest');
  const id = requiredString(source, 'id', 'Theme id', 64);
  if (id !== DEFAULT_THEME_ID && !/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(id)) {
    throw new ThemePackageError('Theme id must contain 2-64 letters, numbers, dots, underscores, or hyphens.');
  }
  if (id !== DEFAULT_THEME_ID && id.toLowerCase().startsWith('builtin')) {
    throw new ThemePackageError('Imported themes cannot use a reserved built-in id.');
  }
  if (source.quorumThemeApi !== api) {
    throw new ThemePackageError(`This theme requires an unsupported Quorum theme API. Expected ${api}.`);
  }
  const colorSchemes = api === '2' ? ['light', 'dark'] as const : ['light', 'dark', 'auto'] as const;
  const colorScheme = enumValue(source.colorScheme, colorSchemes, 'colorScheme', 'light');
  const common = {
    id,
    name: requiredString(source, 'name', 'Theme name', 80),
    version: requiredString(source, 'version', 'Theme version', 32),
    author: requiredString(source, 'author', 'Theme author', 80),
    description: optionalString(source, 'description', 'Theme description', 500),
    colorScheme
  };
  return api === '2'
    ? {...common, colorScheme: colorScheme as ThemeColorScheme, quorumThemeApi: THEME_API_VERSION}
    : {...common, quorumThemeApi: LEGACY_THEME_API_VERSION};
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

function parseHex(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new ThemePackageError(`${label} must be a six-digit hexadecimal color.`);
  }
  return value.toLowerCase();
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function requireContrast(foreground: string, background: string, label: string, minimum: number) {
  const ratio = contrastRatio(foreground, background);
  if (ratio + Number.EPSILON < minimum) {
    throw new ThemePackageError(`${label} contrast is ${ratio.toFixed(2)}:1; it must be at least ${minimum.toFixed(1)}:1.`);
  }
}

function parsePalette(value: unknown): ThemePalette {
  const source = record(value, 'settings.palette');
  const keys: Array<keyof ThemePalette> = [
    'canvas', 'surface', 'surfaceRaised', 'text', 'textMuted', 'accent', 'accentText',
    'success', 'successText', 'warning', 'warningText', 'danger', 'dangerText', 'border', 'focus'
  ];
  assertAllowedKeys(source, keys, 'settings.palette');
  const palette = Object.fromEntries(keys.map(key => [key, parseHex(source[key], `settings.palette.${key}`)])) as unknown as ThemePalette;
  for (const background of ['canvas', 'surface', 'surfaceRaised'] as const) {
    requireContrast(palette.text, palette[background], `settings.palette.text on ${background}`, 4.5);
  }
  for (const background of ['canvas', 'surface'] as const) {
    requireContrast(palette.textMuted, palette[background], `settings.palette.textMuted on ${background}`, 4.5);
  }
  for (const role of ['accent', 'success', 'warning', 'danger'] as const) {
    requireContrast(palette[`${role}Text`], palette[role], `settings.palette.${role}Text on ${role}`, 4.5);
  }
  requireContrast(palette.focus, palette.canvas, 'settings.palette.focus on canvas', 3);
  requireContrast(palette.focus, palette.surface, 'settings.palette.focus on surface', 3);
  return palette;
}

function optionalRecord(source: Record<string, unknown>, key: string, label: string): Record<string, unknown> {
  return source[key] === undefined ? {} : record(source[key], label);
}

function parseSettings(value: unknown): ThemeSettings {
  const source = record(value, 'settings');
  assertAllowedKeys(source, ['palette', 'typography', 'density', 'shape', 'materials', 'motion', 'components', 'layout'], 'settings');
  const typography = optionalRecord(source, 'typography', 'settings.typography');
  assertAllowedKeys(typography, ['fontFamily', 'scale'], 'settings.typography');
  const shape = optionalRecord(source, 'shape', 'settings.shape');
  assertAllowedKeys(shape, ['radius', 'controls'], 'settings.shape');
  const materials = optionalRecord(source, 'materials', 'settings.materials');
  assertAllowedKeys(materials, ['surface', 'depth'], 'settings.materials');
  const motion = optionalRecord(source, 'motion', 'settings.motion');
  assertAllowedKeys(motion, ['preset'], 'settings.motion');
  const components = optionalRecord(source, 'components', 'settings.components');
  assertAllowedKeys(components, ['buttons', 'switches', 'navigation', 'tables'], 'settings.components');
  const layout = optionalRecord(source, 'layout', 'settings.layout');
  assertAllowedKeys(layout, ['contentWidth', 'pageWidths'], 'settings.layout');
  const pageWidthsSource = layout.pageWidths === undefined ? {} : record(layout.pageWidths, 'settings.layout.pageWidths');
  assertAllowedKeys(pageWidthsSource, THEME_PAGES, 'settings.layout.pageWidths');
  const pageWidths = Object.fromEntries(Object.entries(pageWidthsSource).map(([page, width]) => [
    page,
    enumValue(width, ['readable', 'wide', 'full'] as const, `settings.layout.pageWidths.${page}`)
  ])) as Partial<Record<ThemePage, ThemeContentWidth>>;
  return {
    palette: parsePalette(source.palette),
    typography: {
      fontFamily: enumValue(typography.fontFamily, ['system', 'humanist', 'rounded', 'monospace'] as const, 'settings.typography.fontFamily', 'system'),
      scale: enumValue(typography.scale, ['small', 'standard', 'large'] as const, 'settings.typography.scale', 'standard')
    },
    density: enumValue(source.density, ['compact', 'comfortable', 'spacious'] as const, 'settings.density', 'comfortable'),
    shape: {
      radius: enumValue(shape.radius, ['square', 'soft', 'rounded'] as const, 'settings.shape.radius', 'rounded'),
      controls: enumValue(shape.controls, ['rounded', 'pill'] as const, 'settings.shape.controls', 'rounded')
    },
    materials: {
      surface: enumValue(materials.surface, ['solid', 'translucent'] as const, 'settings.materials.surface', 'solid'),
      depth: enumValue(materials.depth, ['flat', 'subtle', 'elevated'] as const, 'settings.materials.depth', 'subtle')
    },
    motion: {
      preset: enumValue(motion.preset, ['none', 'reduced', 'standard', 'fluid'] as const, 'settings.motion.preset', 'standard')
    },
    components: {
      buttons: enumValue(components.buttons, ['filled', 'tinted'] as const, 'settings.components.buttons', 'filled'),
      switches: enumValue(components.switches, ['ios', 'compact'] as const, 'settings.components.switches', 'ios'),
      navigation: enumValue(components.navigation, ['bar', 'floating'] as const, 'settings.components.navigation', 'bar'),
      tables: enumValue(components.tables, ['plain', 'cards'] as const, 'settings.components.tables', 'plain')
    },
    layout: {
      contentWidth: enumValue(layout.contentWidth, ['readable', 'wide', 'full'] as const, 'settings.layout.contentWidth', 'wide'),
      pageWidths
    }
  };
}

export function parseThemePackage(source: string): ThemePackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new ThemePackageError('The selected file is not valid JSON.');
  }
  if (!isRecord(parsed)) throw new ThemePackageError('The theme package must be a JSON object.');
  if (parsed.schema !== THEME_SCHEMA || (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2)) {
    throw new ThemePackageError(`Unsupported theme schema. Expected ${THEME_SCHEMA} version 1 or 2.`);
  }
  const manifestSource = record(parsed.manifest, 'manifest');
  if (parsed.schemaVersion === 1) {
    assertAllowedKeys(parsed, ['schema', 'schemaVersion', 'manifest', 'css'], 'theme package');
    if (typeof parsed.css !== 'string') throw new ThemePackageError('The theme package css field must be a string.');
    validateCss(parsed.css);
    return {
      schema: THEME_SCHEMA,
      schemaVersion: LEGACY_THEME_SCHEMA_VERSION,
      manifest: parseManifest(manifestSource, '1') as LegacyThemeManifest,
      css: parsed.css
    };
  }
  assertAllowedKeys(parsed, ['schema', 'schemaVersion', 'manifest', 'settings'], 'theme package');
  return {
    schema: THEME_SCHEMA,
    schemaVersion: THEME_SCHEMA_VERSION,
    manifest: parseManifest(manifestSource, '2') as TokenThemeManifest,
    settings: parseSettings(parsed.settings)
  };
}

export function isTokenTheme(theme: ThemePackage): theme is TokenThemePackage {
  return theme.schemaVersion === THEME_SCHEMA_VERSION;
}

const FONT_STACKS: Record<ThemeFontFamily, string> = {
  system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  humanist: "Optima, Candara, 'Noto Sans', 'PingFang SC', sans-serif",
  rounded: "ui-rounded, 'SF Pro Rounded', 'Arial Rounded MT Bold', 'PingFang SC', sans-serif",
  monospace: "ui-monospace, 'SFMono-Regular', Consolas, 'Liberation Mono', monospace"
};

export function themeCss(theme: ThemePackage): string {
  if (!isTokenTheme(theme)) return theme.css;
  const {palette} = theme.settings;
  return `:scope {\n${[
    ['canvas', palette.canvas], ['surface', palette.surface], ['surface-raised', palette.surfaceRaised],
    ['text', palette.text], ['text-muted', palette.textMuted], ['accent', palette.accent],
    ['accent-text', palette.accentText], ['success', palette.success], ['success-text', palette.successText],
    ['warning', palette.warning], ['warning-text', palette.warningText], ['danger', palette.danger],
    ['danger-text', palette.dangerText], ['border', palette.border], ['focus', palette.focus]
  ].map(([name, color]) => `  --q-theme-${name}: ${color};`).join('\n')}\n  --q-theme-font-family: ${FONT_STACKS[theme.settings.typography.fontFamily]};\n  color-scheme: ${theme.manifest.colorScheme};\n}`;
}

export function themeLayoutWidth(theme: ThemePackage, page: string): ThemeContentWidth | undefined {
  if (!isTokenTheme(theme)) return undefined;
  return theme.settings.layout.pageWidths[page as ThemePage] ?? theme.settings.layout.contentWidth;
}

export function serializeThemePackage(theme: ThemePackage): string {
  return `${JSON.stringify(theme, null, 2)}\n`;
}

export function themeFileName(theme: ThemePackage): string {
  const safeName = theme.manifest.name.toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'quorum-theme';
  return `${safeName}-${theme.manifest.version}${THEME_FILE_EXTENSION}`;
}

export interface ThemeRoute {
  page: ThemePage;
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
    const pageByRoute: Record<string, ThemePage> = {
      setup: 'committee-setup', 'roll-call': 'committee-roll-call', stats: 'committee-stats',
      unmod: 'committee-unmod', motions: 'committee-motions', notes: 'committee-notes',
      posts: 'committee-posts', settings: 'committee-settings', help: 'committee-help',
      caucuses: 'committee-caucus', resolutions: 'committee-resolution', strawpolls: 'committee-strawpoll'
    };
    return {page: route ? pageByRoute[route] ?? 'committee-unknown' : 'committee-home', section: 'committee'};
  }
  return {page: 'not-found', section: 'system'};
}
