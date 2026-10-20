import {saveAs} from 'file-saver';
import {setLanguage} from '../../i18n';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {beforeEach, afterEach, describe, expect, it, vi} from 'vitest';
import ServerVolumeAdminPanel from './ServerVolumeAdminPanel';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import type {ServerVolumeCleanup} from '@quorum/contracts';

vi.mock('file-saver',()=>({saveAs:vi.fn()}));
beforeEach(()=>setLanguage('zh-CN'));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root: Root;let host: HTMLDivElement;
afterEach(()=>{if(root)act(()=>root.unmount());host?.remove();vi.restoreAllMocks();});
const preview: ServerVolumeCleanup={id:'job',scope:'SELECTED',status:'PREVIEW',total:1,completed:0,failed:0,
  sizeBytes:5,withoutOtherCopy:1,committeeCount:1,files:[{id:'file',blobId:'blob',committeeId:'committee',committeeName:'安理会',ownerEmail:'owner@example.test',
    committeeStatus:'ACTIVE',bindingStatus:'ACTIVE',path:'/storage/server-volume/blobs/test',sizeBytes:5,present:true,
    modifiedAt:1,state:'COMMITTED',hasOtherCopy:false,references:[{fileId:'entry',name:'决议.pdf',version:2}]}]};
async function render(disabled=false, file=preview.files![0]){
  const api={serverVolumePolicy:vi.fn(async()=>({disabled,revision:1})),updateServerVolumePolicy:vi.fn(async value=>({...value,revision:2})),
    serverVolumeFiles:vi.fn(async()=>({files:[file],page:1,total:1,totalBytes:5,rootPath:'/storage/server-volume'})),
    downloadServerVolumeFile:vi.fn(async()=>({name:'决议.pdf',blob:new Blob(['bytes'])})),
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
    expect(host.textContent).toContain('v2');expect(host.textContent).toContain('owner@example.test');
    expect(host.textContent).toContain('归属账号');expect(host.textContent).toContain('文件记录');expect(host.textContent).toContain('容器内路径');
    expect(host.textContent).toContain('其他存储无已验证副本');expect(host.textContent).not.toContain('清理所有委员会的服务器卷文件');
  });
  it('shows dashes for untracked ownership and records, retaining the status and download',async()=>{
    const api=await render(false,{...preview.files![0],blobId:null,ownerEmail:null,committeeId:null,committeeName:null,
      committeeStatus:null,bindingStatus:null,references:[],state:'UNTRACKED'});
    const cells=host.querySelectorAll('tbody tr td');
    expect(Array.from(cells).slice(0,3).map(cell=>cell.textContent)).toEqual(['—','—','—']);
    expect(cells[5].textContent).toContain('未关联文件');expect(cells[5].textContent).toContain('副本情况未知');
    await act(async()=>button('下载',host).click());
    expect(api.downloadServerVolumeFile).toHaveBeenCalledWith('file');
    expect(saveAs).toHaveBeenCalledWith(expect.any(Blob),'决议.pdf');
  });
  it.each([{present:false},{state:'DELETE_PENDING'}])('disables download for unavailable files %j',async change=>{
    await render(false,{...preview.files![0],...change});expect(button('下载',host).disabled).toBe(true);
  });
  it('shows download failures in the panel',async()=>{
    const api=await render();api.downloadServerVolumeFile.mockRejectedValueOnce(new Error('Download failed'));
    await act(async()=>button('下载',host).click());expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(button('下载',host).disabled).toBe(false);
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
