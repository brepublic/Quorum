import {setLanguage} from '../../i18n';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {beforeEach, afterEach, describe, expect, it, vi} from 'vitest';
import ServerVolumeAdminPanel from './ServerVolumeAdminPanel';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import type {ServerVolumeCleanup} from '@quorum/contracts';

beforeEach(()=>setLanguage('zh-CN'));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root: Root;let host: HTMLDivElement;
afterEach(()=>{if(root)act(()=>root.unmount());host?.remove();vi.restoreAllMocks();});
const preview: ServerVolumeCleanup={id:'job',scope:'SELECTED',status:'PREVIEW',total:1,completed:0,failed:0,
  sizeBytes:5,withoutOtherCopy:1,committeeCount:1,files:[{id:'file',blobId:'blob',committeeId:'committee',committeeName:'安理会',
    committeeStatus:'ACTIVE',bindingStatus:'ACTIVE',path:'/storage/server-volume/blobs/test',sizeBytes:5,present:true,
    modifiedAt:1,state:'COMMITTED',hasOtherCopy:false,references:[{fileId:'entry',name:'决议.pdf',version:2}]}]};
async function render(disabled=false){
  const api={serverVolumePolicy:vi.fn(async()=>({disabled,revision:1})),updateServerVolumePolicy:vi.fn(async value=>({...value,revision:2})),
    serverVolumeFiles:vi.fn(async()=>({files:preview.files!,page:1,total:1,totalBytes:5,rootPath:'/storage/server-volume'})),
    serverVolumeCleanups:vi.fn(async()=>[]),previewServerVolumeCleanup:vi.fn(async()=>preview),
    confirmServerVolumeCleanup:vi.fn(async()=>({...preview,status:'RUNNING'}))};
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
  await act(async()=>root.render(<ServerVolumeAdminPanel api={api as unknown as SelfHostedApi}/>));
  return api;
}
const button=(text:string,scope:ParentNode=document)=>Array.from(scope.querySelectorAll('button')).find(item=>item.textContent===text)!;
describe('server volume administration',()=>{
  it('sends only the policy revision and disabled flag when toggling',async()=>{
    const api=await render();await act(async()=>{const control=host.querySelector<HTMLElement>('.ui.checkbox')!;control.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));control.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));control.click();});
    expect(api.updateServerVolumePolicy).toHaveBeenCalledWith({disabled:true,revision:1});
  });
  it('shows paths and versions, and shows bulk buttons only when disabled',async()=>{
    await render();expect(host.textContent).toContain('/storage/server-volume/blobs/test');expect(host.textContent).toContain('决议.pdf');
    expect(host.textContent).toContain('v2');expect(host.textContent).not.toContain('清理所有委员会的服务器卷文件');
  });
  it('previews individual deletion and cancels without confirming',async()=>{
    const api=await render();await act(async()=>button('删除',host).click());
    expect(api.previewServerVolumeCleanup).toHaveBeenCalledWith('SELECTED','file');
    expect(document.querySelector('.ui.modal')?.textContent).toContain('可能永久无法下载');
    expect(api.confirmServerVolumeCleanup).not.toHaveBeenCalled();await act(async()=>button('取消',document.querySelector('.ui.modal')!).click());
    expect(api.confirmServerVolumeCleanup).not.toHaveBeenCalled();
  });
  it.each([['清理已归档委员会的服务器卷文件','ARCHIVED'],['清理所有委员会的服务器卷文件','ALL']])('confirms the %s scope',async(label,scope)=>{
    const api=await render(true);await act(async()=>button(label,host).click());
    expect(api.previewServerVolumeCleanup).toHaveBeenCalledWith(scope,undefined);
    await act(async()=>button('确认删除',document.querySelector('.ui.modal')!).click());
    expect(api.confirmServerVolumeCleanup).toHaveBeenCalledTimes(1);expect(api.confirmServerVolumeCleanup).toHaveBeenCalledWith('job');
  });
  it('keeps the confirmation open and shows a server rejection',async()=>{
    const api=await render();api.confirmServerVolumeCleanup.mockRejectedValueOnce(new Error('Cleanup changed'));
    await act(async()=>button('删除',host).click());await act(async()=>button('确认删除',document.querySelector('.ui.modal')!).click());
    expect(document.querySelector('.ui.modal [role="alert"]')).not.toBeNull();
  });
});
