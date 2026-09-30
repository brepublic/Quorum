import * as React from 'react';
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {CommitteeWorkspaceSnapshot,DelegateReviewFile} from '@quorum/contracts';
import {SelfHostedApiError, type SelfHostedApi} from '../../services/self-hosted-api';
import {setLanguage} from '../../i18n';
import CrisisNoticeReviewCard from './CrisisNoticeReviewCard';

let host:HTMLDivElement,root:Root;
const file:DelegateReviewFile={id:'file',logicalName:'危机通告 1.1.1',originalName:'999.999.999.pdf',fileType:'CRISIS_NOTICE',status:'PENDING_REVIEW',
  submissionSource:'CHAIR',submitterDisplayName:null,sizeBytes:3,submittedAt:null,publishedAt:'',revision:1};
const snapshot={committee:{id:'committee',status:'ACTIVE',committeeLanguage:'zh-CN'},meetingSession:{ordinal:1},nextCrisisGroupOrdinal:1,crises:[]} as unknown as CommitteeWorkspaceSnapshot;
beforeEach(()=> {setLanguage('zh-CN');host=document.createElement('div');document.body.append(host);root=createRoot(host);
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;});
afterEach(()=> {act(()=>root.unmount());host.remove();setLanguage('en');});
const preview={sessionOrdinal:1,groupOrdinal:1,updateOrdinal:1,groupId:null,updateId:null,replacement:null};

describe('crisis review gating',()=> {
  it('disables navigation while focused and after a failed save, retaining manual names across suggestions',async()=> {
    const saveCrisisNoticeName=vi.fn().mockRejectedValue(new Error('save failed'));
    const api={previewCrisisNotice:vi.fn(async()=>preview),saveCrisisNoticeName,importCrisisNotice:vi.fn()} as unknown as SelfHostedApi;
    const refresh=vi.fn(async()=>{}),download=vi.fn(async()=>{});
    const render=async(s=snapshot)=>act(async()=>root.render(<MemoryRouter><CrisisNoticeReviewCard file={file} snapshot={s} api={api} refresh={refresh} download={download}/></MemoryRouter>));
    await render();const input=host.querySelector('input')!;
    const go=()=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='危机 ')!;
    expect(go().disabled).toBe(false);
    await act(async()=> {input.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));});
    expect(go().disabled).toBe(true);
    await act(async()=> {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'危机通告 1.2.1');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));});
    expect(saveCrisisNoticeName).toHaveBeenCalledWith('file',1,'危机通告 1.2.1',true);expect(go().disabled).toBe(true);
    await render({...snapshot,nextCrisisGroupOrdinal:3});expect(input.value).toBe('危机通告 1.2.1');
    expect(api.importCrisisNotice).not.toHaveBeenCalled();
  });
  it('marks incomplete suggestions red when multiple groups await action',async()=> {
    const api={saveCrisisNoticeName:vi.fn(async()=>({revision:2})),previewCrisisNotice:vi.fn(async()=>preview)} as unknown as SelfHostedApi;
    const value={...snapshot,crises:[1,2].map(ordinal=>({ordinal,sessionOrdinal:1,endedAt:null,nextUpdateOrdinal:2,updates:[{status:'PENDING'}]}))} as unknown as CommitteeWorkspaceSnapshot;
    await act(async()=>root.render(<MemoryRouter><CrisisNoticeReviewCard file={file} snapshot={value} api={api} refresh={async()=>{}} download={async()=>{}}/></MemoryRouter>));
    expect(host.querySelector('input')!.value).toBe('危机通告 1.');expect(host.querySelector('.field.error')).not.toBeNull();
    expect(host.textContent).toContain('补全危机编号');expect(host.querySelector<HTMLButtonElement>('button:last-child')!.disabled).toBe(true);
    expect(host.textContent).not.toContain('批准');expect(host.textContent).not.toContain('驳回');
  });
  it('explains new groups in blue with a bold group number and distinct update choices',async()=> {
    const value={...snapshot,nextCrisisGroupOrdinal:2,crises:[{id:'first',committeeId:'committee',ordinal:1,sessionOrdinal:1,
      endedAt:null,nextUpdateOrdinal:3,updates:[{status:'PENDING',ordinal:1},{status:'UNPUBLISHED',ordinal:2}]}]} as unknown as CommitteeWorkspaceSnapshot;
    const api={previewCrisisNotice:vi.fn(async()=>({...preview,groupOrdinal:2}))} as unknown as SelfHostedApi;
    await act(async()=>root.render(<MemoryRouter><CrisisNoticeReviewCard file={{...file,logicalName:'危机通告 1.2.1',crisisNameEdited:true}}
      snapshot={value} api={api} refresh={async()=>{}} download={async()=>{}}/></MemoryRouter>));
    expect(host.querySelector('.blue.message strong')?.textContent).toBe('危机 1.2');
    expect(host.textContent).toContain('此操作将创建新危机组');
    expect(host.textContent).toContain('如要更新危机 1.1，请使用编号 1.1.2。');
    expect(host.textContent).not.toContain('如要创建危机组 1.2');
    expect(host.textContent).not.toContain('修正文件名称');
  });
  it('shows the existing card target without claiming to create its group',async()=> {
    const api={previewCrisisNotice:vi.fn(async()=>({...preview,groupOrdinal:2,groupId:'second',updateId:'draft'}))} as unknown as SelfHostedApi;
    await act(async()=>root.render(<MemoryRouter><CrisisNoticeReviewCard file={{...file,logicalName:'危机通告 1.2.1',crisisNameEdited:true}}
      snapshot={snapshot} api={api} refresh={async()=>{}} download={async()=>{}}/></MemoryRouter>));
    expect(host.querySelector('.message strong')?.textContent).toBe('危机 1.2.1');
    expect(host.textContent).toContain('此通告将关联至');expect(host.textContent).not.toContain('创建新危机组');
    expect(host.querySelector('.blue.message')).toBeNull();
  });
  it('explains invalid numbers once and omits the redundant correction button',async()=> {
    const error=new SelfHostedApiError(409,'RESOURCE_CONFLICT','invalid',undefined,undefined,{reason:'CRISIS_NUMBER_MISMATCH',params:{session:1,group:1,update:1}});
    const api={previewCrisisNotice:vi.fn().mockRejectedValue(error)} as unknown as SelfHostedApi;
    await act(async()=>root.render(<MemoryRouter><CrisisNoticeReviewCard file={file} snapshot={snapshot}
      api={api} refresh={async()=>{}} download={async()=>{}}/></MemoryRouter>));
    expect(host.textContent).toContain('危机编号不能跳号，请在上方文件名称中使用以下编号之一：');
    expect(host.textContent?.match(/编号 1\.1\.1/g)).toHaveLength(1);
    expect(host.querySelectorAll('.error.message')).toHaveLength(1);
    expect([...host.querySelectorAll('button')].map(button=>button.textContent)).not.toContain('修正文件名称');
  });
});
