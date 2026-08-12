import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  classifyThemeRoute,
  DEFAULT_THEME,
  isTokenTheme,
  parseThemePackage,
  serializeThemePackage,
  themeCss,
  themeLayoutWidth,
  ThemePackageError
} from './theme-package';

const palette = {
  canvas: '#f5f5f7',
  surface: '#ffffff',
  surfaceRaised: '#ffffff',
  text: '#1d1d1f',
  textMuted: '#5f5f65',
  accent: '#0066cc',
  accentText: '#ffffff',
  success: '#187a34',
  successText: '#ffffff',
  warning: '#8a4b00',
  warningText: '#ffffff',
  danger: '#b42318',
  dangerText: '#ffffff',
  border: '#8e8e93',
  focus: '#005fcc'
};

const validTheme = {
  schema: 'quorum-theme',
  schemaVersion: 2,
  manifest: {
    id: 'example.daylight',
    name: 'Daylight',
    version: '2.0.0',
    author: 'Theme Author',
    description: 'A test theme',
    quorumThemeApi: '2',
    colorScheme: 'light'
  },
  settings: {
    palette,
    typography: {fontFamily: 'system', scale: 'standard'},
    density: 'comfortable',
    shape: {radius: 'rounded', controls: 'pill'},
    materials: {surface: 'solid', depth: 'subtle'},
    motion: {preset: 'standard'},
    components: {buttons: 'filled', switches: 'ios', navigation: 'floating', tables: 'cards'},
    layout: {contentWidth: 'wide', pageWidths: {'committee-resolution': 'full'}}
  }
};

const legacyTheme = {
  schema: 'quorum-theme',
  schemaVersion: 1,
  manifest: {
    id: 'example.legacy',
    name: 'Legacy',
    version: '1.0.0',
    author: 'Theme Author',
    quorumThemeApi: '1',
    colorScheme: 'dark'
  },
  css: ':scope { color: white; background: #111; }'
};

describe('theme package validation', () => {
  it('accepts and normalizes a declarative API 2 package', () => {
    expect(parseThemePackage(JSON.stringify(validTheme))).toEqual(validTheme);
  });

  it('fills optional API 2 settings with safe defaults', () => {
    const source = {...validTheme, settings: {palette}};
    const parsed = parseThemePackage(JSON.stringify(source));
    expect(isTokenTheme(parsed)).toBe(true);
    if (!isTokenTheme(parsed)) return;
    expect(parsed.settings.components.switches).toBe('ios');
    expect(parsed.settings.layout.contentWidth).toBe('wide');
  });

  it('compiles API 2 settings to variables and page width data', () => {
    const parsed = parseThemePackage(JSON.stringify(validTheme));
    expect(themeCss(parsed)).toContain('--q-theme-accent: #0066cc');
    expect(themeCss(parsed)).not.toContain('[data-theme-component');
    expect(themeLayoutWidth(parsed, 'committee-resolution')).toBe('full');
    expect(themeLayoutWidth(parsed, 'templates')).toBe('wide');
  });

  it('rejects unreadable semantic color pairs and unknown fields', () => {
    expect(() => parseThemePackage(JSON.stringify({
      ...validTheme,
      settings: {...validTheme.settings, palette: {...palette, accent: '#ffffff'}}
    }))).toThrow(/contrast/);
    expect(() => parseThemePackage(JSON.stringify({
      ...validTheme,
      settings: {...validTheme.settings, arbitraryCss: ':scope { display: none; }'}
    }))).toThrow(/unsupported fields/);
  });

  it('keeps API 1 CSS themes compatible', () => {
    expect(parseThemePackage(JSON.stringify(legacyTheme))).toEqual(legacyTheme);
    expect(themeCss(parseThemePackage(JSON.stringify(legacyTheme)))).toBe(legacyTheme.css);
  });

  it('round-trips the built-in default theme export', () => {
    expect(parseThemePackage(serializeThemePackage(DEFAULT_THEME))).toEqual(DEFAULT_THEME);
  });

  it.each([
    ['apple-fluid-light.quorum-theme.json', 'light'],
    ['apple-fluid-dark.quorum-theme.json', 'dark']
  ])('accepts the bundled %s example', (fileName, colorScheme) => {
    const source = readFileSync(resolve(process.cwd(), 'themes', fileName), 'utf8');
    const parsed = parseThemePackage(source);
    expect(parsed.manifest.colorScheme).toBe(colorScheme);
    expect(isTokenTheme(parsed)).toBe(true);
  });

  it.each([
    '@import "https://example.com/theme.css";',
    ':scope { background: url(https://example.com/image.png); }',
    ':scope { background: image-set("https://example.com/image.png" 1x); }',
    '@\\69mport "https://example.com/theme.css";'
  ])('still rejects external resources in legacy CSS: %s', css => {
    expect(() => parseThemePackage(JSON.stringify({...legacyTheme, css}))).toThrow(ThemePackageError);
  });

  it('rejects mismatched schema and API versions', () => {
    expect(() => parseThemePackage(JSON.stringify({
      ...validTheme,
      manifest: {...validTheme.manifest, quorumThemeApi: '1'}
    }))).toThrow(/theme API/);
    expect(() => parseThemePackage(JSON.stringify({
      ...validTheme,
      manifest: {...validTheme.manifest, id: 'Builtin.fake'}
    }))).toThrow(/reserved/);
  });
});

describe('theme page selectors', () => {
  it.each([
    ['/', 'home', 'public'],
    ['/onboard', 'onboard', 'account'],
    ['/templates', 'templates', 'account'],
    ['/committees/abc', 'committee-home', 'committee'],
    ['/committees/abc/roll-call', 'committee-roll-call', 'committee'],
    ['/committees/abc/caucuses/gsl', 'committee-caucus', 'committee'],
    ['/committees/abc/resolutions/r1/voting', 'committee-resolution', 'committee'],
    ['/not-a-route', 'not-found', 'system']
  ])('maps %s to stable theme hooks', (path, page, section) => {
    expect(classifyThemeRoute(path)).toEqual({page, section});
  });
});
