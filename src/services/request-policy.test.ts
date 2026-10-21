import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {requestWithPolicy, RequestTimeout} from './request-policy';
beforeEach(()=>{vi.useFakeTimers();}); afterEach(()=>{vi.useRealTimers();});
it('retries temporary reads after 1 and 3 seconds and stops after the third failure',async()=>{
  const operation=vi.fn().mockRejectedValue({code:'NETWORK_ERROR'});
  const result=expect(requestWithPolicy(operation,{read:true})).rejects.toMatchObject({code:'NETWORK_ERROR'});
  await vi.runAllTimersAsync();await result;expect(operation).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(60000);expect(operation).toHaveBeenCalledTimes(3);
});
it('recovers a transient failure without asking the user to repeat it',async()=>{
  const operation=vi.fn().mockRejectedValueOnce({status:503}).mockResolvedValue('loaded');
  const result=requestWithPolicy(operation,{read:true});await vi.runAllTimersAsync();expect(await result).toBe('loaded');expect(operation).toHaveBeenCalledTimes(2);
});
it('times out a read even when its response body never resolves',async()=>{
  const result=expect(requestWithPolicy(()=>new Promise(()=>{}),{read:true})).rejects.toBeInstanceOf(RequestTimeout);
  await vi.runAllTimersAsync();await result;
});
it('never replays a write without an idempotency key',async()=>{
  const operation=vi.fn().mockRejectedValue({code:'NETWORK_ERROR'});
  await expect(requestWithPolicy(operation)).rejects.toMatchObject({code:'NETWORK_ERROR'});expect(operation).toHaveBeenCalledTimes(1);
});
it('does not retry permission, validation or revision errors',async()=>{
  for(const status of [401,403,409,422]){
    const operation=vi.fn().mockRejectedValue({status});await expect(requestWithPolicy(operation,{repeatable:true})).rejects.toMatchObject({status});expect(operation).toHaveBeenCalledTimes(1);
  }
});
it('cancels an in-flight request and its pending retries',async()=>{
  const controller=new AbortController();const operation=vi.fn(()=>new Promise(()=>{}));
  const result=expect(requestWithPolicy(operation,{signal:controller.signal,read:true})).rejects.toMatchObject({name:'AbortError'});
  controller.abort();await result;await vi.runAllTimersAsync();expect(operation).toHaveBeenCalledTimes(1);
});
