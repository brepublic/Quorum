import * as React from 'react';
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {createPortal} from 'react-dom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Form} from 'semantic-ui-react';
import {ViewportDropdown, ViewportFormDropdown, ViewportFormSelect} from './ViewportDropdown';

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let viewportDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  viewportDescriptor = Object.getOwnPropertyDescriptor(document.documentElement, 'clientHeight');
  Object.defineProperty(document.documentElement, 'clientHeight', {configurable: true, value: 900});
});
afterEach(() => {
  vi.restoreAllMocks();
  if (viewportDescriptor) Object.defineProperty(document.documentElement, 'clientHeight', viewportDescriptor);
  else Reflect.deleteProperty(document.documentElement, 'clientHeight');
});
const options = Array.from({length: 30}, (_, index) => ({key: index, value: String(index), text: `Country ${index}`}));

describe('viewport dropdowns', () => {
  it.each(['dropdown', 'select', 'form-dropdown', 'modal'])(
    'sizes a %s, preserves selection callbacks and removes sizing on close', async kind => {
      const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
      const onChange = vi.fn(), onOpen = vi.fn(), onClose = vi.fn();
      const props = {selection: true, search: true, selectOnBlur: false, options, onChange, onOpen, onClose};
      const component = kind === 'select' ? <Form><ViewportFormSelect label="Country" {...props} /></Form>
        : kind === 'form-dropdown' ? <Form><ViewportFormDropdown label="Country" {...props} /></Form>
          : <ViewportDropdown {...props} />;
      try {
        await act(async () => root.render(kind === 'modal'
          ? createPortal(<div className="ui modal"><div className="content">{component}</div></div>, document.body) : component));
        const dropdown = document.querySelector<HTMLElement>('.viewport-dropdown')!;
        const menu = dropdown.querySelector<HTMLElement>('.menu')!;
        vi.spyOn(dropdown, 'getBoundingClientRect').mockReturnValue({top: 100, bottom: 140, height: 40} as DOMRect);
        Object.defineProperty(menu, 'scrollHeight', {configurable: true, value: 1000});
        await act(async () => {dropdown.click();});
        expect(dropdown.style.getPropertyValue('--dropdown-menu-max-height')).toBe('744px');
        expect(dropdown.classList.contains('upward')).toBe(false);
        expect(onOpen).toHaveBeenCalledTimes(1);
        await act(async () => {(menu.querySelectorAll<HTMLElement>('.item')[4]).click();});
        expect(onChange.mock.calls[0][1].value).toBe('4');
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(dropdown.style.getPropertyValue('--dropdown-menu-max-height')).toBe('');
      } finally {await act(async () => root.unmount()); host.remove();}
    });

  it('uses visible viewport offsets, avoids navigation and releases listeners when unmounted', async () => {
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    const viewport = Object.assign(new EventTarget(), {offsetTop: 100, height: 500});
    vi.stubGlobal('visualViewport', viewport);
    const remove = vi.spyOn(viewport, 'removeEventListener');
    try {
      await act(async () => root.render(<><nav className="delegate-file-menu" /><ViewportDropdown selection search options={options} /></>));
      const dropdown = host.querySelector<HTMLElement>('.viewport-dropdown')!;
      const menu = dropdown.querySelector<HTMLElement>('.menu')!;
      vi.spyOn(dropdown, 'getBoundingClientRect').mockReturnValue({top: 420, bottom: 460, height: 40} as DOMRect);
      vi.spyOn(host.querySelector('nav')!, 'getBoundingClientRect').mockReturnValue({top: 100, bottom: 160, height: 60} as DOMRect);
      let contentHeight = 1000;
      Object.defineProperty(menu, 'scrollHeight', {configurable: true, get: () => contentHeight});
      await act(async () => {dropdown.click();});
      expect(dropdown.classList.contains('upward')).toBe(true);
      expect(dropdown.style.getPropertyValue('--dropdown-menu-max-height')).toBe('244px');
      contentHeight = 60;
      await act(async () => {menu.append(document.createTextNode('search result'));});
      expect(dropdown.classList.contains('upward')).toBe(false);
      expect(dropdown.style.getPropertyValue('--dropdown-menu-max-height')).toBe('124px');
      viewport.height = 380; contentHeight = 1000;
      await act(async () => {viewport.dispatchEvent(new Event('resize'));});
      expect(dropdown.classList.contains('upward')).toBe(true);
      await act(async () => root.unmount());
      expect(remove.mock.calls.map(call => call[0])).toEqual(['resize', 'scroll']);
      expect(dropdown.style.getPropertyValue('--dropdown-menu-max-height')).toBe('');
    } finally {await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();}
  });

  it('sizes a dropdown opened by a controlled validation prop', async () => {
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    try {
      await act(async () => root.render(<ViewportFormSelect options={options} open={false} />));
      const dropdown = host.querySelector<HTMLElement>('.viewport-dropdown')!;
      vi.spyOn(dropdown, 'getBoundingClientRect').mockReturnValue({top: 100, bottom: 140, height: 40} as DOMRect);
      await act(async () => root.render(<ViewportFormSelect options={options} open />));
      expect(dropdown.style.getPropertyValue('--dropdown-menu-max-height')).toBe('744px');
      await act(async () => root.render(<ViewportFormSelect options={options} open={false} />));
      expect(dropdown.style.getPropertyValue('--dropdown-menu-max-height')).toBe('');
    } finally {await act(async () => root.unmount()); host.remove();}
  });
});
