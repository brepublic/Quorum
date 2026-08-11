import * as React from 'react';
import {act} from 'react';
import {createRoot, Root} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {Button, Segment} from 'semantic-ui-react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ThemeProvider} from './ThemeProvider';

const installedTheme = {
  schema: 'quorum-theme',
  schemaVersion: 1,
  manifest: {
    id: 'test.runtime',
    name: 'Runtime Test',
    version: '1.0.0',
    author: 'Tests',
    quorumThemeApi: '1',
    colorScheme: 'dark'
  },
  css: ':scope { --runtime-test: yes; }\n[data-theme-component~="button"] { border-radius: 2rem; }'
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
    window.localStorage.setItem('quorum-themes-v1', JSON.stringify([installedTheme]));
    window.localStorage.setItem('quorum-active-theme-v1', installedTheme.manifest.id);
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
    expect(app.querySelector('.ui.button')?.getAttribute('data-theme-component')).toContain('button');
    expect(app.querySelector('.ui.segment')?.getAttribute('data-theme-component')).toContain('segment');

    const style = document.getElementById('quorum-active-theme-styles');
    expect(style?.textContent).toContain('@scope (#quorum-app)');
    expect(style?.textContent).toContain('--runtime-test: yes');
    expect(document.documentElement.dataset.quorumTheme).toBe('test.runtime');

    const portal = document.getElementById('quorum-theme-portal')!;
    expect(portal).not.toBeNull();
    expect(app.contains(portal)).toBe(false);
    expect(portal.querySelector('[aria-label="Appearance themes"]')).not.toBeNull();
  });
});
