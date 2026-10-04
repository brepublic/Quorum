import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {CommitteeWorkspaceSnapshot, SpeakerList} from '@quorum/contracts';
import {SelfHostedApiError, type SelfHostedApi} from '../../services/self-hosted-api';
import {setLanguage} from '../../i18n';
import CommitteeSettingsPanel from './CommitteeSettingsPanel';

type Snapshot = CommitteeWorkspaceSnapshot;
let host: HTMLDivElement, root: Root, current: Snapshot, api: SelfHostedApi, refresh: ReturnType<typeof vi.fn>;
let chair = true;
const fixture = (): Snapshot => ({committee: {id: 'committee', committeeLanguage: 'zh-CN', name: '委员会', topic: 'Topic',
  conference: 'Conference', chairLabel: 'Chair', visibility: 'PRIVATE', operationMode: 'CHAIR_OPERATED', status: 'ACTIVE',
  activeRulePackageVersionId: 'rules', revision: 4}, viewer: {audience: 'OWNER', seatId: null},
  motionSettings: {showMotionsOnDemand: true, groupMotionTypes: true, delegateMotionProposalsEnabled: false, delegateMotionVotingEnabled: true},
  layoutSettings: {moveQueueUp: false, timersInSeparateColumns: false}, crisisAutoStartDelayMinutes: 5,
  speakerLists: [{id: 'general', kind: 'GENERAL', revision: 8, defaultSpeechMs: 120_000} as SpeakerList],
  crises: [], sync: {committeeEventSequence: 1}} as unknown as Snapshot);
async function render() {
  await act(async () => root.render(<MemoryRouter><CommitteeSettingsPanel snapshot={current} api={api} canChair={chair} refresh={refresh} /></MemoryRouter>));
}
function field(name: string) {return host.querySelector<HTMLInputElement>(`#committee-setting-${name}`)!;}
function card(group: string) {return host.querySelector(`[data-settings-group="${group}"]`)!;}
function buttons(text: string, scope: ParentNode = host) {return [...scope.querySelectorAll('button')].filter(button => button.textContent === text);}
async function fill(name: string, value: string) {
  await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(name), value);
    field(name).dispatchEvent(new Event('input', {bubbles: true}));});
}
async function blur(name: string) {await act(async () => field(name).dispatchEvent(new FocusEvent('focusout', {bubbles: true})));}
async function toggle(label: string) {
  const input = host.querySelector(`input[aria-label="${label}"]`)!;
  await act(async () => {for (const type of ['mousedown', 'mouseup', 'click']) input.closest('.checkbox')!.dispatchEvent(new MouseEvent(type, {bubbles: true}));});
}
async function click(text: string, scope: ParentNode = host) {await act(async () => buttons(text, scope)[0].click());}
function defer<T>() {let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}

beforeEach(() => {
  setLanguage('zh-CN'); chair = true;
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); current = fixture();
  refresh = vi.fn(async () => current);
  const committeeChange = (patch: Partial<Snapshot['committee']>, revision: number) => {
    expect(revision).toBe(current.committee.revision);
    current = {...current, committee: {...current.committee, ...patch, revision: revision + 1}}; return current.committee;
  };
  api = {
    listRulePackages: vi.fn(async () => [{versions: [{id: 'rules', status: 'PUBLISHED', names: {'zh-CN': '北京学术标准 2021'}},
      {id: 'new-rules', status: 'PUBLISHED', names: {'zh-CN': '另一规则'}}]}]),
    updateCommittee: vi.fn(async (_id, revision, patch) => committeeChange(patch, revision)),
    setOperationMode: vi.fn(async (_id, operationMode, revision) => committeeChange({operationMode}, revision)),
    activateRules: vi.fn(async (_id, activeRulePackageVersionId, revision) => committeeChange({activeRulePackageVersionId}, revision)),
    setMotionSettings: vi.fn(async (_id, settings, revision) => {
      committeeChange({}, revision); current = {...current, motionSettings: settings}; return {...settings, revision: current.committee.revision};}),
    setLayoutSettings: vi.fn(async (_id, settings, revision) => {
      committeeChange({}, revision); current = {...current, layoutSettings: settings}; return {...settings, revision: current.committee.revision};}),
    setCrisisAutoStartDelay: vi.fn(async (_id, revision, minutes) => {
      committeeChange({}, revision); current = {...current, crisisAutoStartDelayMinutes: minutes}; return {minutes};}),
    updateSpeakerList: vi.fn(async (_id, revision, patch) => {
      expect(revision).toBe(current.speakerLists![0].revision);
      const list = {...current.speakerLists![0], ...patch, revision: revision + 1}; current = {...current, speakerLists: [list]}; return list;}),
    setCommitteeStatus: vi.fn(async (_id, status, revision) => committeeChange({status}, revision)),
    archiveCommittee: vi.fn(async (_id, revision) => committeeChange({status: 'ARCHIVED'}, revision)),
    requestCommitteeDeletion: vi.fn(async () => ({})), committeeExportUrl: () => '/export'
  } as unknown as SelfHostedApi;
});
afterEach(async () => {await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks();});

describe('committee settings autosave', () => {
  it.each(['ACTIVE', 'ARCHIVED'] as const)('offers only the latest Beijing version while displaying the current historical rule for %s committees', async status => {
    current.committee.status = status; chair = status === 'ACTIVE';
    api.listRulePackages = vi.fn(async () => [{scope: 'BUILTIN', key: 'builtin:beijing-academic', versions: [
      {id: 'latest-rules', version: 12, status: 'PUBLISHED', names: {'zh-CN': '北京学术标准 2021'}},
      {id: 'rules', version: 6, status: 'PUBLISHED', names: {'zh-CN': '北京学术标准 2021'}},
      {id: 'draft-rules', version: 13, status: 'DRAFT', names: {'zh-CN': '北京规则草稿'}}]},
      {scope: 'SYSTEM', key: 'system:custom', versions: [1, 2].map(version => ({id: `custom-${version}`, version,
        status: 'PUBLISHED', names: {'zh-CN': `自定义规则 ${version}`}}))}] as unknown as Awaited<ReturnType<SelfHostedApi['listRulePackages']>>);
    await render();
    const dropdown = card('operation').querySelectorAll('.ui.dropdown')[1];
    expect(dropdown.querySelector('.text')?.textContent).toBe('北京学术标准 2021');
    expect([...dropdown.querySelectorAll('.item')].filter(item => item.textContent === '北京学术标准 2021')).toHaveLength(1);
    expect(dropdown.textContent).not.toContain('北京规则草稿');
    expect(dropdown.textContent).toContain('自定义规则 1'); expect(dropdown.textContent).toContain('自定义规则 2');
    expect(api.activateRules).not.toHaveBeenCalled();
    if (status === 'ACTIVE') {
      await act(async () => dropdown.querySelector('.item')!.dispatchEvent(new MouseEvent('click', {bubbles: true})));
      expect(api.activateRules).toHaveBeenCalledWith('committee', 'latest-rules', 4);
    } else expect(dropdown.classList.contains('disabled')).toBe(true);
  });

  it('groups settings into cards with no save or activate button', async () => {
    await render(); expect(host.querySelectorAll('.committee-setting-card')).toHaveLength(7);
    expect(buttons('保存更改')).toHaveLength(0); expect(buttons('保存运作模式')).toHaveLength(0); expect(buttons('启用规则版本')).toHaveLength(0);
    expect(card('speaking').textContent).toContain('主发言名单单席发言时间');
    expect(card('profile').textContent).not.toContain('已保存');
  });
  it('waits for blur or Enter and patches only the completed field', async () => {
    await render(); await fill('topic', 'Still editing'); await fill('name', ' 新名称 ');
    expect(api.updateCommittee).not.toHaveBeenCalled(); await blur('name');
    expect(api.updateCommittee).toHaveBeenCalledWith('committee', 4, {name: '新名称'});
    expect(field('name').value).toBe('新名称'); expect(field('topic').value).toBe('Still editing');
    expect(card('profile').textContent).not.toContain('已保存');
    await act(async () => field('topic').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})));
    await blur('topic'); expect(api.updateCommittee).toHaveBeenCalledTimes(2);
    expect(api.updateCommittee).toHaveBeenLastCalledWith('committee', 5, {topic: 'Still editing'});
  });
  it('rejects invalid input locally, permits empty optional fields and valid negative delays', async () => {
    await render(); await fill('name', '   '); await blur('name');
    expect(api.updateCommittee).not.toHaveBeenCalled(); expect(card('profile').textContent).toContain('委员会名称不能为空');
    expect(field('name').value).toBe('   ');
    await fill('topic', ''); await blur('topic'); expect(api.updateCommittee).toHaveBeenCalledWith('committee', 4, {topic: ''});
    for (const input of ['', '0', '-1', '1.0001']) {await fill('duration', input); await blur('duration');}
    expect(api.updateSpeakerList).not.toHaveBeenCalled();
    await fill('duration', '90.125'); await blur('duration');
    expect(api.updateSpeakerList).toHaveBeenCalledWith('general', 8, {defaultSpeechMs: 90125});
    await fill('delay', ''); await blur('delay'); expect(api.setCrisisAutoStartDelay).not.toHaveBeenCalled();
    await fill('delay', '-1'); await blur('delay'); expect(api.setCrisisAutoStartDelay).toHaveBeenCalledWith('committee', 5, -1);
  });
  it('accepts three-decimal speaking times without floating-point rejection', async () => {
    await render(); await fill('duration', '1.001'); await blur('duration');
    expect(api.updateSpeakerList).toHaveBeenCalledWith('general', 8, {defaultSpeechMs: 1001});
  });
  it('does not save Enter while composing Chinese text', async () => {
    await render(); await fill('name', '正在输入');
    await act(async () => field('name').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', isComposing: true, bubbles: true})));
    expect(api.updateCommittee).not.toHaveBeenCalled(); await blur('name'); expect(api.updateCommittee).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized profile fields before sending a request', async () => {
    await render();
    for (const [name, length] of [['name', 201], ['topic', 501], ['conference', 201]] as const) {
      await fill(name, '字'.repeat(length)); await blur(name);
    }
    expect(api.updateCommittee).not.toHaveBeenCalled(); expect(card('profile').textContent).toContain('请检查输入');
  });
  it('does not apply a duration draft to a replacement general speakers list', async () => {
    await render(); await fill('duration', '90');
    current = {...current, speakerLists: [{...current.speakerLists![0], id: 'replacement', revision: 1}]}; await render();
    await blur('duration'); expect(api.updateSpeakerList).not.toHaveBeenCalled(); expect(card('speaking').textContent).toContain('重新载入');
    await click('重新载入', card('speaking')); expect(field('duration').value).toBe('120');
  });
  it('shows saving until confirmation, then shows saved for three seconds', async () => {
    vi.useFakeTimers(); const pending = defer<Snapshot['motionSettings'] & {revision: number}>();
    vi.mocked(api.setMotionSettings).mockReturnValueOnce(pending.promise);
    await render(); await toggle('按需显示动议类型');
    expect(card('motions').textContent).toContain('保存中…'); expect(card('motions').textContent).not.toContain('已保存');
    await act(async () => {current = {...current, committee: {...current.committee, revision: 5}, motionSettings: {...current.motionSettings, showMotionsOnDemand: false}};
      pending.resolve({...current.motionSettings, revision: 5});});
    expect(card('motions').textContent).toContain('已保存');
    await act(async () => vi.advanceTimersByTime(3000)); expect(card('motions').textContent).not.toContain('已保存');
  });
  it('serializes different cards and coalesces queued changes without replacing hidden motion settings', async () => {
    const pending = defer<Snapshot['committee']>(); vi.mocked(api.updateCommittee).mockReturnValueOnce(pending.promise);
    await render(); await fill('name', '新名称'); await blur('name');
    await toggle('按需显示动议类型'); await toggle('按分类显示动议类型'); await toggle('按分类显示动议类型');
    await fill('delay', '0'); await blur('delay');
    expect(api.setMotionSettings).not.toHaveBeenCalled(); expect(api.setCrisisAutoStartDelay).not.toHaveBeenCalled();
    await act(async () => {current = {...current, committee: {...current.committee, name: '新名称', revision: 5}}; pending.resolve(current.committee);});
    expect(api.setMotionSettings).toHaveBeenCalledTimes(1);
    expect(api.setMotionSettings).toHaveBeenCalledWith('committee', {showMotionsOnDemand: false, groupMotionTypes: true,
      delegateMotionProposalsEnabled: false, delegateMotionVotingEnabled: true}, 5);
    expect(api.setCrisisAutoStartDelay).toHaveBeenCalledWith('committee', 6, 0);
  });
  it('saves the final switch position even when changed back during its request', async () => {
    const pending = defer<Snapshot['layoutSettings'] & {revision: number}>(); vi.mocked(api.setLayoutSettings).mockReturnValueOnce(pending.promise);
    await render(); await toggle('将“发言队列”显示在“下一位发言”上方'); await toggle('将“发言队列”显示在“下一位发言”上方');
    await act(async () => {current = {...current, committee: {...current.committee, revision: 5}, layoutSettings: {...current.layoutSettings, moveQueueUp: true}};
      pending.resolve({...current.layoutSettings, revision: 5});});
    expect(api.setLayoutSettings).toHaveBeenCalledTimes(2);
    expect(api.setLayoutSettings).toHaveBeenLastCalledWith('committee', {moveQueueUp: false, timersInSeparateColumns: false}, 5);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="将“发言队列”显示在“下一位发言”上方"]')?.checked).toBe(false);
  });
  it('retains failed input and exposes a card retry without a success indicator', async () => {
    vi.mocked(api.updateCommittee).mockRejectedValueOnce(new SelfHostedApiError(503, 'SERVICE_NOT_READY', 'Unavailable'));
    await render(); await fill('name', '新名称'); await blur('name');
    expect(field('name').value).toBe('新名称'); expect(card('profile').textContent).toContain('保存失败');
    expect(card('profile').textContent).not.toContain('已保存'); await click('重试', card('profile'));
    expect(api.updateCommittee).toHaveBeenCalledTimes(2); expect(card('profile').textContent).toContain('已保存');
  });
  it('preserves editing across refresh and demands explicit reload for a conflicting field', async () => {
    await render(); await fill('name', '我的名称');
    current = {...current, committee: {...current.committee, name: '他人名称', topic: 'New topic', revision: 5}}; await render();
    expect(field('name').value).toBe('我的名称'); expect(field('topic').value).toBe('New topic');
    await blur('name'); expect(api.updateCommittee).not.toHaveBeenCalled(); expect(card('profile').textContent).toContain('此设置已在其他地方修改');
    expect(buttons('重试', card('profile'))).toHaveLength(0); await click('重新载入', card('profile'));
    expect(field('name').value).toBe('他人名称');
  });
  it('requires reload after server revision conflicts and does not replay the request', async () => {
    vi.mocked(api.updateCommittee).mockRejectedValueOnce(new SelfHostedApiError(409, 'REVISION_CONFLICT', 'Changed'));
    await render(); await fill('name', '新名称'); await blur('name'); await blur('name');
    expect(api.updateCommittee).toHaveBeenCalledTimes(1); expect(card('profile').textContent).toContain('重新载入');
  });
  it('keeps a newer draft when its earlier submitted value succeeds', async () => {
    const pending = defer<Snapshot['committee']>(); vi.mocked(api.updateCommittee).mockReturnValueOnce(pending.promise);
    await render(); await fill('name', '第一版'); await blur('name'); await fill('name', '第二版');
    await act(async () => {current = {...current, committee: {...current.committee, name: '第一版', revision: 5}}; pending.resolve(current.committee);});
    expect(field('name').value).toBe('第二版'); expect(card('profile').textContent).not.toContain('已保存');
    await blur('name'); expect(api.updateCommittee).toHaveBeenLastCalledWith('committee', 5, {name: '第二版'});
  });
  it('does not let stale refreshes rewind acknowledged revisions', async () => {
    const stale = current; refresh.mockImplementation(async () => stale);
    await render(); await toggle('按需显示动议类型'); await toggle('按分类显示动议类型');
    expect(api.setMotionSettings).toHaveBeenLastCalledWith('committee', expect.objectContaining({showMotionsOnDemand: false, groupMotionTypes: false}), 5);
  });
  it('blocks timing edits while paused and every edit while read-only', async () => {
    current = {...current, committee: {...current.committee, status: 'PAUSED'}}; await render();
    expect(field('duration').disabled).toBe(true); expect(field('delay').disabled).toBe(true); expect(field('name').disabled).toBe(false);
    current = {...current, committee: {...current.committee, status: 'ARCHIVED'}}; chair = false; await render();
    expect(field('name').disabled).toBe(true); expect(field('duration').disabled).toBe(true);
    expect(buttons('归档委员会')).toHaveLength(0); expect(buttons('永久删除委员会')).toHaveLength(1);
  });
  it('does not expose owner lifecycle actions to chairs, or write controls offline', async () => {
    current = {...current, viewer: {audience: 'CHAIR', seatId: null}}; await render();
    expect(field('name').disabled).toBe(true); expect(buttons('归档委员会')).toHaveLength(0);
    current = {...current, viewer: {audience: 'PUBLIC', seatId: null}}; chair = false; await render();
    expect(field('name').disabled).toBe(true); expect(host.querySelector('[data-settings-group="motions"]')).toBeNull();
    expect(buttons('暂停委员会')).toHaveLength(0);
  });
  it('blocks status actions and warns on leaving with invalid or pending input', async () => {
    await render(); await fill('name', ''); await blur('name');
    expect(buttons('暂停委员会')[0].disabled).toBe(true); expect(buttons('归档委员会')[0].disabled).toBe(true);
    const event = new Event('beforeunload', {cancelable: true}); window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
  });
  it('uses an archive modal and preserves name confirmation for permanent deletion', async () => {
    await render(); await click('归档委员会'); expect(api.archiveCommittee).not.toHaveBeenCalled();
    const modal = document.querySelector('.ui.modal')!; expect(modal.textContent).toContain('无法恢复为活动状态');
    await click('取消', modal); expect(api.archiveCommittee).not.toHaveBeenCalled();
    await click('归档委员会'); await click('归档委员会', document.querySelector('.ui.modal')!);
    expect(api.archiveCommittee).toHaveBeenCalledWith('committee', 4); chair = false; await render();
    await click('永久删除委员会'); const deleteModal = document.querySelector('.ui.modal')!;
    expect(buttons('永久删除委员会', deleteModal)[0].disabled).toBe(true);
    const confirmation = deleteModal.querySelector('input')!;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(confirmation, '委员会');
      confirmation.dispatchEvent(new Event('input', {bubbles: true}));});
    expect(buttons('永久删除委员会', deleteModal)[0].disabled).toBe(false);
    await click('永久删除委员会', deleteModal); expect(api.requestCommitteeDeletion).toHaveBeenCalledWith('committee', 5, '委员会');
  });
  it('preserves unfinished crisis confirmation when pausing', async () => {
    current = {...current, crises: [{id: 'crisis', sessionOrdinal: 1, ordinal: 2, endedAt: null}] as Snapshot['crises']};
    await render(); await click('暂停委员会'); expect(api.setCommitteeStatus).not.toHaveBeenCalled();
    const modal = document.querySelector('.ui.modal')!; expect(modal.textContent).toContain('危机 1.2');
    await click('结束危机并暂停', modal); expect(api.setCommitteeStatus).toHaveBeenCalledWith('committee', 'PAUSED', 4, true);
  });
  it('auto-saves deliberate mode and rule selections, with no change on dropdown blur', async () => {
    await render(); const dropdowns = card('operation').querySelectorAll('.ui.dropdown');
    await act(async () => {dropdowns[0].dispatchEvent(new MouseEvent('click', {bubbles: true}));
      dropdowns[0].dispatchEvent(new FocusEvent('focusout', {bubbles: true}));});
    expect(api.setOperationMode).not.toHaveBeenCalled();
    await act(async () => {const choice = [...dropdowns[0].querySelectorAll('.item')].find(item => item.textContent === '代表自主操作')!;
      choice.dispatchEvent(new MouseEvent('click', {bubbles: true}));});
    expect(api.setOperationMode).toHaveBeenCalledWith('committee', 'DELEGATE_OPERATED', 4);
    await act(async () => {dropdowns[1].dispatchEvent(new MouseEvent('click', {bubbles: true}));
      [...dropdowns[1].querySelectorAll('.item')].find(item => item.textContent === '另一规则')!.dispatchEvent(new MouseEvent('click', {bubbles: true}));});
    expect(api.activateRules).toHaveBeenCalledWith('committee', 'new-rules', 5);
  });
});
