import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {setLanguage} from '../../i18n';
import {IdentityApiError, type SelfHostedIdentityClient} from '../../services/self-hosted-identity';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import DefaultCommitteeBehaviorPanel from './DefaultCommitteeBehaviorPanel';
const defaults = {creatorIsChair: true, operationMode: 'CHAIR_OPERATED' as const, defaultRulePackageVersionId: 'rules',
  showMotionsOnDemand: true, groupMotionTypes: true, moveQueueUp: false, timersInSeparateColumns: false,
  generalSpeechMs: 120000, crisisAutoStartDelayMinutes: 5, revision: 1};
let host: HTMLDivElement, root: Root;
beforeEach(() => {setLanguage('zh-CN'); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;});
afterEach(() => {act(() => root.unmount()); host.remove();});
async function mount() {
  const client = {getDefaultCommitteeBehavior: vi.fn(async () => ({...defaults})),
    updateDefaultCommitteeBehavior: vi.fn(async value => ({...value, revision: value.revision + 1}))};
  const api = {listRulePackages: vi.fn(async () => [{scope: 'BUILTIN', key: 'builtin:beijing-academic', versions: [
    {id: 'rules', status: 'PUBLISHED', version: 1, names: {'zh-CN': '北京规则'}}]}])};
  await act(async () => root.render(<MemoryRouter><DefaultCommitteeBehaviorPanel client={client as unknown as SelfHostedIdentityClient}
    api={api as unknown as SelfHostedApi} /></MemoryRouter>));
  return client;
}
async function toggle(index: number) {await act(async () => (host.querySelectorAll('input[type=checkbox]')[index] as HTMLInputElement).click());}
async function fill(id: string, value: string, blur = true) {
  const input = host.querySelector(`#default-${id}`) as HTMLInputElement;
  await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));});
  if (blur) await act(async () => input.dispatchEvent(new FocusEvent('focusout', {bubbles: true})));
}
it('serializes cards, keeps edits made during a save, and uses the returned revision', async () => {
  const client = await mount(); let finish!: (value: typeof defaults) => void;
  client.updateDefaultCommitteeBehavior.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  await toggle(0); await toggle(1); await fill('generalSpeechMs', '90', false);
  expect(client.updateDefaultCommitteeBehavior).toHaveBeenCalledTimes(1);
  await act(async () => finish({...defaults, creatorIsChair: false, revision: 2}));
  expect(client.updateDefaultCommitteeBehavior).toHaveBeenLastCalledWith({...defaults, creatorIsChair: false, showMotionsOnDemand: false, revision: 2});
  expect((host.querySelector('#default-generalSpeechMs') as HTMLInputElement).value).toBe('90');
  await fill('generalSpeechMs', '90');
  expect(client.updateDefaultCommitteeBehavior).toHaveBeenLastCalledWith({...defaults, creatorIsChair: false, showMotionsOnDemand: false,
    generalSpeechMs: 90000, revision: 3});
});
it('validates numbers, permits negative crisis delay, and retries failed input without discarding it', async () => {
  const client = await mount();
  await fill('generalSpeechMs', '0'); expect(client.updateDefaultCommitteeBehavior).not.toHaveBeenCalled();
  expect(host.textContent).toContain('请检查输入');
  client.updateDefaultCommitteeBehavior.mockRejectedValueOnce(new Error('Offline'));
  await fill('generalSpeechMs', '1.001');
  expect((host.querySelector('#default-generalSpeechMs') as HTMLInputElement).value).toBe('1.001');
  await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === '重试')!.click());
  expect(client.updateDefaultCommitteeBehavior).toHaveBeenLastCalledWith({...defaults, generalSpeechMs: 1001});
  await fill('crisisAutoStartDelayMinutes', '-1');
  expect(client.updateDefaultCommitteeBehavior).toHaveBeenLastCalledWith({...defaults, generalSpeechMs: 1001, crisisAutoStartDelayMinutes: -1, revision: 2});
});
it('stops queued writes on revision conflict and reloads explicitly', async () => {
  const client = await mount();
  client.updateDefaultCommitteeBehavior.mockRejectedValueOnce(new IdentityApiError(409, 'REVISION_CONFLICT', 'Changed'));
  await toggle(0);
  expect(host.textContent).toContain('此设置已在其他地方修改');
  client.getDefaultCommitteeBehavior.mockResolvedValueOnce({...defaults, revision: 9});
  await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === '重新载入')!.click());
  await toggle(1);
  expect(client.updateDefaultCommitteeBehavior).toHaveBeenLastCalledWith({...defaults, showMotionsOnDemand: false, revision: 9});
});
