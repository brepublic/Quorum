import * as React from 'react';
import {act} from 'react';
import {createRoot, Root} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {Button, Segment} from 'semantic-ui-react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ThemeProvider} from './ThemeProvider';

const installedTheme = {
  schema: 'quorum-theme',
  schemaVersion: 2,
  manifest: {
    id: 'test.runtime',
    name: 'Runtime Test',
    version: '1.0.0',
    author: 'Tests',
    quorumThemeApi: '2',
    colorScheme: 'dark'
  },
  settings: {
    palette: {
      canvas: '#111113', surface: '#1c1c1e', surfaceRaised: '#2c2c2e',
      text: '#f5f5f7', textMuted: '#b6b6bc', accent: '#409cff', accentText: '#111113',
      success: '#30d158', successText: '#111113', warning: '#ffb340', warningText: '#111113',
      danger: '#ff6961', dangerText: '#111113', border: '#636366', focus: '#75baff'
    },
    density: 'comfortable',
    shape: {radius: 'rounded', controls: 'pill'},
    materials: {surface: 'solid', depth: 'subtle'},
    motion: {preset: 'fluid'},
    components: {buttons: 'filled', switches: 'ios', navigation: 'floating', tables: 'cards'},
    layout: {contentWidth: 'wide', pageWidths: {'committee-roll-call': 'full'}}
  }
};

const legacyStoredTheme = {
  schema: 'quorum-theme',
  schemaVersion: 1,
  manifest: {
    id: 'test.legacy-runtime',
    name: 'Legacy Runtime Test',
    version: '1.0.0',
    author: 'Tests',
    quorumThemeApi: '1',
    colorScheme: 'dark'
  },
  css: ':scope { --legacy-runtime-test: yes; }'
};

describe('ThemeProvider runtime', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
    const originalConsoleError = console.error.bind(console);
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (args.some(value => String(value).includes('Could not parse CSS stylesheet'))) return;
      originalConsoleError(...args);
    });
    window.localStorage.clear();
    window.localStorage.setItem('quorum-themes-v2', JSON.stringify([installedTheme]));
    window.localStorage.setItem('quorum-active-theme-v2', installedTheme.manifest.id);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(callback, 0));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.getElementById('quorum-active-theme-styles')?.remove();
    document.querySelectorAll('#quorum-theme-portal').forEach(element => element.remove());
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('applies route, theme, scoped CSS, and component hooks without exposing the recovery control', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/committees/demo/roll-call']}>
          <ThemeProvider>
            <Segment><Button>Present</Button></Segment>
          </ThemeProvider>
        </MemoryRouter>
      );
    });
    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 30));
    });

    const app = document.getElementById('quorum-app')!;
    expect(app.dataset.themePage).toBe('committee-roll-call');
    expect(app.dataset.themeSection).toBe('committee');
    expect(app.dataset.themeId).toBe('test.runtime');
    expect(app.dataset.themeApi).toBe('2');
    expect(app.dataset.themeSwitches).toBe('ios');
    expect(app.dataset.themeLayoutWidth).toBe('full');
    expect(app.querySelector('.ui.button')?.getAttribute('data-theme-component')).toContain('button');
    expect(app.querySelector('.ui.segment')?.getAttribute('data-theme-component')).toContain('segment');

    const style = document.getElementById('quorum-active-theme-styles');
    expect(style?.textContent).toContain('@scope (#quorum-app)');
    expect(style?.textContent).toContain('--q-theme-accent: #409cff');
    expect(document.documentElement.dataset.quorumTheme).toBe('test.runtime');

    const portal = document.getElementById('quorum-theme-portal')!;
    expect(portal).not.toBeNull();
    expect(app.contains(portal)).toBe(false);
    expect(portal.querySelector('[aria-label="Appearance themes"]')).not.toBeNull();
  });

  it('loads themes and the active selection from legacy local-storage keys', async () => {
    window.localStorage.clear();
    window.localStorage.setItem('quorum-themes-v1', JSON.stringify([legacyStoredTheme]));
    window.localStorage.setItem('quorum-active-theme-v1', legacyStoredTheme.manifest.id);

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/templates']}>
          <ThemeProvider><Segment>Legacy</Segment></ThemeProvider>
        </MemoryRouter>
      );
    });

    const app = document.getElementById('quorum-app')!;
    expect(app.dataset.themeId).toBe('test.legacy-runtime');
    expect(app.dataset.themeApi).toBe('1');
    expect(app.dataset.themeDensity).toBeUndefined();
    expect(document.getElementById('quorum-active-theme-styles')?.textContent).toContain('--legacy-runtime-test: yes');
  });
});
