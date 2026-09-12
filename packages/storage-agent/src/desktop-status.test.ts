// @vitest-environment node
import {describe, it, expect} from 'vitest';
import type {StorageAgentFileStatus, StorageAgentTask} from '@quorum/contracts';
import type {AgentDirectoryState} from './state';
import {desktopFiles} from './desktop-status';
const file: StorageAgentFileStatus = {fileEntryId: 'file',logicalName: '决议.pdf',fileRevision: 3,blobId: 'blob',
  sizeBytes: 100,status:'PUBLISHED',cacheState:'MISSING',updatedAt: 'now'};
const state = {schemaVersion: 1,committeeId:'c',deviceId:'d',manifestSequence:1, files: {
  file:{fileEntryId:'file',blobId:'blob',revision:1,relativePath:'决议.pdf',sizeBytes:100,sha256:'h',modifiedTimeMs:0}
},pendingUploads:{},conflicts:{}} as AgentDirectoryState;
const task = {id:'task',fileEntryId:'file',blobId:'blob',sequence:1,type:'FETCH_BLOB_TO_CACHE',status:'PENDING'} as StorageAgentTask;
const rows = (remote=[file], s=state, tasks:StorageAgentTask[]=[], active=new Map(), fresh=true, verified=new Set(['file'])) => desktopFiles(remote,s,tasks,verified,active,fresh);
describe('desktop file status uses content and server authority separately', () => {
  it('publication revision changes do not invalidate identical local content', () => {
    expect(rows()[0]).toMatchObject({local:'已就绪 - 公开可见',cache:'服务器无缓存 · 本地可用'});
    expect(rows([{...file,status:'UPLOAD_COMPLETE'}])[0]?.local).toBe('已就绪 - 未提交审核');
    expect(rows([{...file,status:'PENDING_REVIEW'}])[0]?.local).toBe('已就绪 - 待审核');
  });
  it('does not claim a missing, unverified or older local blob is ready', () => {
    expect(rows([{...file,blobId:'new'}])[0]?.local).not.toContain('已就绪');
    expect(rows([file],state,[],new Map(),true,new Set())[0]?.cache).toBe('服务器无缓存');
  });
  it('distinguishes queued refill from active transfer, and verification from readiness', () => {
    expect(rows([file],state,[task])[0]?.cache).toBe('等待回传');
    const active = new Map([['file',{fileEntryId:'file',taskId:'task',type:'FETCH_BLOB_TO_CACHE',phase:'transfer',bytes:50,total:100}]]);
    expect(rows([file],state,[task],active)[0]).toMatchObject({local:'已就绪 - 公开可见',cache:'正在回传',bytes:50,progress:true});
    active.get('file')!.type='STORE_BLOB';active.get('file')!.phase='verify';
    expect(rows([file],state,[],active)[0]?.local).toBe('校验中');
  });
  it('shows a newly received task immediately before the next metadata poll', () => {
    const active = new Map([['new',{fileEntryId:'new',taskId:'t',name:'新文件.pdf',type:'HOST_COMMIT_BLOB',phase:'transfer',bytes:20,total:100}]]);
    expect(rows([], {...state,files:{}}, [], active)[0]).toMatchObject({name:'新文件.pdf',local:'下载中',bytes:20,progress:true});
  });
  it('does not present cached remote status as live when disconnected', () => {
    expect(rows([file],state,[],new Map(),false)[0]).toMatchObject({cache:'状态未知',local:'本地已保存 · 审核状态未知'});
  });
  it('distinguishes server deletion pending local removal from completed deletion', () => {
    expect(rows([{...file,status:'DELETED'}])[0]?.local).toBe('待删除');
    expect(rows([{...file,status:'DELETED'}],{...state,files:{}})[0]?.local).toBe('已删除');
  });
  it('does not let old failures override a later successful refill', () => {
    expect(rows([file],state,[{...task,status:'FAILED'},{...task,sequence:2,status:'COMPLETED'}])[0]?.cache)
      .toBe('服务器无缓存 · 本地可用');
  });
});
