import {setLanguage} from '../../i18n';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import {DelegateFileSettingsPanel} from './DelegateFileSettingsPanel';

let host: HTMLDivElement; let root: Root;
beforeEach(() => {setLanguage('zh-CN'); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;});
afterEach(async () => {await act(async () => root.unmount()); host.remove();});
const defaults = {revision: 1, rejectionTypes: [{id:'format',label:{'zh-CN':'格式'},message:{'zh-CN':'请修改'},custom:false}]};
const button = (text: string) => Array.from(host.querySelectorAll('button')).find(item => item.textContent === text)!;
async function fill(selector: string, value: string) {
  const field = host.querySelector(selector) as HTMLInputElement;
  await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,value);
    field.dispatchEvent(new Event('input',{bubbles:true}));});
}

describe('file settings editor', () => {
  it('uses the administrator defaults endpoint and retains edits on save failure', async () => {
    const updateDefaultFileRejectionTypes = vi.fn().mockRejectedValueOnce(new Error('设置已被其他人修改')).mockImplementation(async value => ({...value,revision:2}));
    const api = {getDefaultFileRejectionTypes:async () => defaults,updateDefaultFileRejectionTypes} as unknown as SelfHostedApi;
    await act(async () => root.render(<MemoryRouter><DelegateFileSettingsPanel api={api} /></MemoryRouter>));
    expect(host.textContent).toContain('用于新建委员会');
    expect(host.textContent).not.toContain('文件格式设置');
    await fill('input[aria-label="类型名称 1"]','学术格式');
    await act(async () => button('保存设置').click());
    expect(host.textContent).toContain('请求失败，请稍后重试。');
    expect((host.querySelector('input') as HTMLInputElement).value).toBe('学术格式');
    expect(updateDefaultFileRejectionTypes).toHaveBeenCalledWith({...defaults,rejectionTypes:[{...defaults.rejectionTypes[0],label:{'zh-CN':'学术格式'}}]});
  });
  it('keeps the edited content language and input when the interface switches', async () => {
    const updateDefaultFileRejectionTypes = vi.fn(async value => value);
    const api = {getDefaultFileRejectionTypes: async () => defaults, updateDefaultFileRejectionTypes} as unknown as SelfHostedApi;
    await act(async () => root.render(<MemoryRouter><DelegateFileSettingsPanel api={api} /></MemoryRouter>));
    await fill('input[aria-label="类型名称 1"]', '中文草稿');
    const field = host.querySelector('input[aria-label="类型名称 1"]');
    await act(async () => setLanguage('en'));
    expect(host.querySelector('input[aria-label="Type name 1"]')).toBe(field);
    await act(async () => button('Save settings').click());
    expect(updateDefaultFileRejectionTypes).toHaveBeenCalledWith({...defaults,
      rejectionTypes: [{...defaults.rejectionTypes[0], label: {'zh-CN': '中文草稿'}}]});
  });

  it('normalizes suffixes and sends all three lists only to the current committee', async () => {
    const settings = {...defaults,allowedExtensions:{WORKING_PAPER:['pdf'],DIRECTIVE_DRAFT:['doc'],RESOLUTION_DRAFT:['txt']}};
    const updateDelegateFileSettings = vi.fn(async (_id, value) => ({...value,revision:2}));
    const api = {getDelegateFileSettings:async () => settings,updateDelegateFileSettings} as unknown as SelfHostedApi;
    await act(async () => root.render(<MemoryRouter><DelegateFileSettingsPanel committeeId="one" api={api} /></MemoryRouter>));
    await fill('input[id$="-allowedExtensions.WORKING_PAPER"]','.PDF，docx pdf');
    await act(async () => button('保存设置').click());
    expect(updateDelegateFileSettings).toHaveBeenCalledWith('one',{...settings,allowedExtensions:{...settings.allowedExtensions,WORKING_PAPER:['pdf','docx']}});
    expect(host.textContent).toContain('已保存');
  });
});
