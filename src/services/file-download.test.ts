import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {saveAs} from 'file-saver';
import {downloadActivity, downloadPreparedFile} from './file-download';
vi.mock('file-saver',()=>({saveAs:vi.fn()}));
beforeEach(()=>{vi.useFakeTimers();vi.clearAllMocks();});afterEach(()=>{downloadActivity.cancel();vi.useRealTimers();vi.unstubAllGlobals();});
const ready=async()=>({status:'READY' as const});
it('saves only fully received bytes and decodes the server filename',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('complete',{headers:{'content-length':'8','content-disposition':"attachment; filename*=UTF-8''%E6%96%87%E4%BB%B6.txt"}})));
  await downloadPreparedFile(ready,ready,'/file');expect(saveAs).toHaveBeenCalledWith(expect.objectContaining({size:8}),'文件.txt');expect(downloadActivity.count()).toBe(0);
});
it('preserves structured HTTP diagnostics and stops automatic retry after three attempts',async()=>{
  const fetchMock=vi.fn(async()=>new Response(JSON.stringify({error:{code:'UNAVAILABLE',reason:'STORAGE_AGENT_SOURCE_MISSING',requestId:'trace'}}),{status:503}));vi.stubGlobal('fetch',fetchMock);
  const result=expect(downloadPreparedFile(ready,ready,'/file')).rejects.toMatchObject({code:'UNAVAILABLE',reason:'STORAGE_AGENT_SOURCE_MISSING',requestId:'trace'});
  await vi.runAllTimersAsync();await result;expect(fetchMock).toHaveBeenCalledTimes(3);expect(saveAs).not.toHaveBeenCalled();
});
it('does not save truncated file contents',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('short',{headers:{'content-length':'90'}})));
  await expect(downloadPreparedFile(ready,ready,'/file')).rejects.toMatchObject({code:'NETWORK_ERROR'});expect(saveAs).not.toHaveBeenCalled();
});
it('bounds preparation polling to two minutes',async()=>{
  const prepare=vi.fn(async()=>({status:'PREPARING' as const,retryAfterSeconds:2}));
  const result=expect(downloadPreparedFile(prepare,prepare,'/file')).rejects.toMatchObject({code:'REQUEST_TIMEOUT'});
  await vi.runAllTimersAsync();await result;expect(prepare.mock.calls.length).toBeLessThanOrEqual(62);expect(downloadActivity.count()).toBe(0);
});
it('cancels preparation immediately without a save or another poll',async()=>{
  const prepare=vi.fn(async()=>({status:'PREPARING' as const,retryAfterSeconds:2}));
  const result=expect(downloadPreparedFile(prepare,prepare,'/file')).rejects.toMatchObject({name:'AbortError'});downloadActivity.cancel();await result;
  await vi.runAllTimersAsync();expect(prepare).toHaveBeenCalledTimes(1);expect(saveAs).not.toHaveBeenCalled();
});
it('ends a stalled content stream after thirty seconds without saving a partial file',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1]));}}))));
  const result=expect(downloadPreparedFile(ready,ready,'/file')).rejects.toMatchObject({code:'REQUEST_TIMEOUT'});
  await vi.runAllTimersAsync();await result;expect(saveAs).not.toHaveBeenCalled();
});
