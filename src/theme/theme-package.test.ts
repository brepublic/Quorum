import {describe, expect, it} from 'vitest';
import {
  classifyThemeRoute,
  DEFAULT_THEME,
  parseThemePackage,
  serializeThemePackage,
  ThemePackageError
} from './theme-package';

const validTheme = {
  schema: 'quorum-theme',
  schemaVersion: 1,
  manifest: {
    id: 'example.midnight',
    name: 'Midnight',
    version: '1.2.0',
    author: 'Theme Author',
    description: 'A test theme',
    quorumThemeApi: '1',
    colorScheme: 'dark'
  },
  css: ':scope { color: white; background: #111; }'
};

describe('theme package validation', () => {
  it('accepts and normalizes a valid package', () => {
    expect(parseThemePackage(JSON.stringify(validTheme))).toEqual(validTheme);
  });

  it('round-trips the built-in default theme export', () => {
    expect(parseThemePackage(serializeThemePackage(DEFAULT_THEME))).toEqual(DEFAULT_THEME);
  });

  it.each([
    '@import "https://example.com/theme.css";',
    ':scope { background: url(https://example.com/image.png); }',
    ':scope { background: image-set("https://example.com/image.png" 1x); }',
    '@\\69mport "https://example.com/theme.css";'
  ])('rejects CSS that can load an external resource: %s', css => {
    expect(() => parseThemePackage(JSON.stringify({...validTheme, css}))).toThrow(ThemePackageError);
  });

  it('allows embedded data URL assets', () => {
    const css = ':scope { background-image: url("data:image/png;base64,iVBORw0KGgo=//"); }';
    expect(parseThemePackage(JSON.stringify({...validTheme, css})).css).toBe(css);
  });

  it('rejects incompatible API versions and reserved ids', () => {
    expect(() => parseThemePackage(JSON.stringify({
      ...validTheme,
      manifest: {...validTheme.manifest, quorumThemeApi: '2'}
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
