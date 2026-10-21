import * as React from 'react';
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {Router, Route, Switch, useHistory} from 'react-router-dom';
import {createMemoryHistory} from 'history';
import {afterEach, expect, it, vi} from 'vitest';
import {useSaveBeforeLeave} from './useSaveBeforeLeave';
import {setLanguage} from '../i18n';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:ReturnType<typeof createRoot>;let host:HTMLDivElement;
afterEach(()=>{act(()=>root?.unmount());host?.remove();});
async function render(save:()=>Promise<boolean>){
  setLanguage('en');host=document.createElement('div');document.body.append(host);root=createRoot(host);
  const history=createMemoryHistory({initialEntries:['/edit']});
  function Editor(){const history=useHistory();const confirmation=useSaveBeforeLeave(true,save);return <>{confirmation}<input defaultValue="preserved draft" /><button onClick={()=>history.push('/target')}>Leave</button></>;}
  await act(async()=>root.render(<Router history={history}><Switch><Route path="/edit"><Editor /></Route><Route><p>Target</p></Route></Switch></Router>));return history;
}
it('saves before continuing navigation without a confirmation dialog',async()=>{
  const save=vi.fn(async()=>true);const history=await render(save);
  await act(async()=>host.querySelector('button')!.click());expect(save).toHaveBeenCalledTimes(1);expect(history.location.pathname).toBe('/target');expect(document.querySelector('.ui.modal')).toBeNull();
});
it('keeps a failed draft editable and allows an explicit discard instead of trapping the user',async()=>{
  const save=vi.fn(async()=>false);const history=await render(save);
  await act(async()=>host.querySelector('button')!.click());expect(history.location.pathname).toBe('/edit');expect(document.querySelector('.ui.modal')?.textContent).toContain('Your changes could not be saved.');
  const button=(name:string)=>[...document.querySelectorAll<HTMLButtonElement>('.ui.modal button')].find(button=>button.textContent===name)!;
  await act(async()=>button('Keep editing').click());expect(host.querySelector('input')?.value).toBe('preserved draft');
  await act(async()=>host.querySelector('button')!.click());await act(async()=>button('Discard changes').click());expect(history.location.pathname).toBe('/target');expect(save).toHaveBeenCalledTimes(2);
});
