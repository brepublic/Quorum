import {beforeEach, afterEach, it, expect} from 'vitest';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {ChairAgentDownload, type ChairAgentRelease} from './ChairAgentDownload';
import {setLanguage} from '../i18n';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const release: ChairAgentRelease = {schemaVersion: 1, serverVersion: 'v1.3.0', agentVersion: '0.1.0',
  commit: 'a'.repeat(40), releaseUrl: 'https://github.com/brepublic/Quorum/releases/tag/v1.3.0',
  platforms: {
    windows: {file: 'Agent-Setup.exe', url: '/downloads/chair-agent/v1.3.0/Agent-Setup.exe', size: 42, sha256: 'b'.repeat(64)},
    linux: {file: 'Agent.AppImage', url: '/downloads/chair-agent/v1.3.0/Agent.AppImage', size: 43, sha256: 'c'.repeat(64)}
  }};
let root: Root; let container: HTMLDivElement;
beforeEach(() => {setLanguage('zh-CN'); container = document.createElement('div'); document.body.append(container); root = createRoot(container);});
afterEach(() => {act(() => root.unmount()); container.remove();});
function render(value: ChairAgentRelease | null = release) {
  act(() => root.render(<ChairAgentDownload release={value} />));
  const toggle = container.querySelector<HTMLElement>('.dropdown')!;
  act(() => {toggle.focus(); toggle.click();});
  return toggle;
}
it('offers exact local installers, platform icons and a version-specific external release link', () => {
  render();
  expect(container.textContent).toContain('选择操作系统');
  expect(container.textContent).toContain('X86-64 · EXE 安装包');
  expect(container.textContent).not.toContain('配套版本');
  expect(container.textContent).not.toContain('从当前服务器下载');
  expect(container.querySelector('i.windows.icon')).not.toBeNull();
  expect(container.querySelector('i.linux.icon')).not.toBeNull();
  const installers = [...container.querySelectorAll<HTMLAnchorElement>('a[download]')];
  expect(installers.map(a => a.getAttribute('href'))).toEqual([release.platforms.windows.url, release.platforms.linux.url]);
  const github = container.querySelector<HTMLAnchorElement>('a[target="_blank"]')!;
  expect(github.href).toBe(release.releaseUrl);
  expect(github.rel).toBe('noopener noreferrer');
});
it('closes with Escape and allows reopening', () => {
  const toggle = render();
  expect(toggle.classList.contains('active')).toBe(true);
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', keyCode: 27, bubbles: true})));
  expect(toggle.classList.contains('active')).toBe(false);
  act(() => toggle.click());
  expect(toggle.classList.contains('active')).toBe(true);
});
it('does not invent download or GitHub URLs for a source build', () => {
  render(null);
  expect(container.textContent).toContain('此版本暂无安装包');
  expect(container.querySelector('a')).toBeNull();
});
it('updates menu copy when the language changes', () => {
  render(); act(() => setLanguage('en'));
  expect(container.textContent).toContain('Choose operating system');
  expect(container.textContent).toContain('EXE installer');
});

it('moves keyboard focus to download links without suppressing native Enter activation', () => {
  const toggle = render();
  act(() => toggle.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true, cancelable: true})));
  expect(document.activeElement).toBe(container.querySelector('a[download]'));
  expect(toggle.classList.contains('active')).toBe(true);
  const enter = new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true});
  act(() => document.activeElement!.dispatchEvent(enter));
  expect(enter.defaultPrevented).toBe(false);
  act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})));
  expect(toggle.classList.contains('active')).toBe(false);
});

it('shows only prepared development platforms and no GitHub release link', () => {
  act(() => root.render(<ChairAgentDownload release={{schemaVersion: 1, development: true,
    platforms: {linux: release.platforms.linux}}} />));
  act(() => container.querySelector<HTMLElement>('.dropdown')!.click());
  expect(container.textContent).toContain('本地开发构建');
  expect(container.querySelectorAll('a[download]')).toHaveLength(1);
  expect(container.querySelector('i.windows.icon')).toBeNull();
  expect(container.querySelector('a[target="_blank"]')).toBeNull();
  act(() => setLanguage('en'));
  expect(container.textContent).toContain('Local development build');
});
