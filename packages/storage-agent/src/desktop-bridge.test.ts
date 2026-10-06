// @vitest-environment node
// These exercise the real compiled Node child processes against an isolated HTTPS server.
import {spawn, execFileSync, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createServer, type Server} from 'node:https';
import {createInterface} from 'node:readline';
import {mkdtemp, readFile, rm, mkdir, writeFile, stat, symlink} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach, describe, expect, it} from 'vitest';
import {lockAgentRoot} from './runtime-lock';

const cleanup: (()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse()) await fn();});
async function fixture(pairStatus = 200, revokeStatus = 200, mustChangePassword = false, failLocalSave = false, pairingCodeStatus = 200) {
  const root=await mkdtemp(join(tmpdir(),'quorum-desktop-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const key=join(root,'key.pem'),crt=join(root,'ca.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',crt,
    '-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});
  const requests: {url:string; authorization?:string; body:string}[]=[];
  const server=createServer({key:await readFile(key),cert:await readFile(crt)}, async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    requests.push({url:req.url!,authorization:req.headers.authorization,body});
    if (req.url === '/api/v1/auth/login') {
      if (JSON.parse(body).password === 'wrong') {res.statusCode = 401; res.end(JSON.stringify({error:{code:'AUTHENTICATION_REQUIRED',reason:'INCORRECT_CREDENTIALS'}})); return;}
      res.setHeader('set-cookie', ['__Host-quorum_session=account-secret; Secure; HttpOnly; Path=/', '__Host-quorum_csrf=csrf; Secure; Path=/']);
      res.end(JSON.stringify({data: {user: {mustChangePassword}}})); return;
    }
    if (req.url === '/api/v1/storage-agent/committees') {
      res.end(JSON.stringify({data: [{id:'10000000-0000-4000-8000-000000000001', name:'Paused Council',
        conference:'Meeting', topic:'Files', role:'CHAIR', status:'PAUSED', revision:2,
        currentHost:null, storageProvider:'SERVER_VOLUME'}]})); return;
    }
    if (req.url?.endsWith('/pairing-codes')) {
      if (pairingCodeStatus !== 200) {res.statusCode = pairingCodeStatus; res.end(JSON.stringify({error:{code:'AUTHENTICATION_REQUIRED'}})); return;}
      res.end(JSON.stringify({data: {configuration: {schemaVersion:1, kind:'quorum-agent-pairing',
        serverUrl:`https://127.0.0.1:${(server.address() as {port:number}).port}`, committeeId:'10000000-0000-4000-8000-000000000001',
        committeeName:'Paused Council', pairingCode:'QRM-test-secret', purpose:'INITIAL', expiresAt:'2099-01-01T00:00:00Z'}}})); return;
    }
    if(req.url==='/api/v1/storage-agent/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': ready\n\n');return;}
    if(req.url==='/api/v1/storage-agent/pair' && pairStatus !== 200){res.writeHead(pairStatus,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'LINK_EXPIRED',message:'Pairing code expired.'}}));return;}
    if(req.url==='/api/v1/storage-agent/revoke' && revokeStatus !== 200){res.writeHead(revokeStatus,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:revokeStatus === 401 ? 'AUTHENTICATION_REQUIRED' : 'NOT_FOUND',message:'Revoke failed.'}}));return;}
    if (req.url === '/api/v1/storage-agent/pair' && failLocalSave) await mkdir(join(root, 'private.json'));
    const data=req.url==='/api/v1/storage-agent/revoke'?{revoked:true}:req.url==='/api/v1/storage-agent/pair'?{credential:'qsa1.20000000-0000-4000-8000-000000000001.'+'a'.repeat(43),
      host:{committeeId:'10000000-0000-4000-8000-000000000001',deviceId:'20000000-0000-4000-8000-000000000001',leaseGeneration:1}}
      :req.url?.includes('file-status')?{files:[],nextId:null,observedAt:new Date().toISOString()}
      :req.url?.includes('manifest')?{events:[],nextSequence:0,hasMore:false}
      :req.url?.includes('tasks')?{tasks:[],nextSequence:0,hasMore:false}:req.url?.includes('conflicts')?[]:{};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data}));
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));cleanup.push(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});
  const address=server.address();if(!address||typeof address==='string')throw Error('address');
  const process=spawn(globalThis.process.execPath,[resolve('packages/storage-agent/dist/desktop-bridge.js')],{stdio:'pipe',env:{...globalThis.process.env, XDG_CONFIG_HOME:join(root,'config-home'), LOCALAPPDATA:join(root,'config-home')}});
  cleanup.push(async()=>{if(process.exitCode===null){process.kill('SIGKILL');await new Promise(done=>process.once('close',done));}});
  const events:Record<string,any>[]=[];createInterface({input:process.stdout}).on('line',line=>events.push(JSON.parse(line)));
  async function wait(predicate:(e:Record<string,any>)=>boolean, from=0) {
    const until=Date.now()+15000;while(Date.now()<until){const e=events.slice(from).find(predicate);if(e)return e;await new Promise(r=>setTimeout(r,20));}
    throw Error('Desktop event timeout: '+JSON.stringify(events));
  }
  async function command(command:string,fields:Record<string,unknown>={}){
    const offset=events.length;process.stdin.write(JSON.stringify({command,...fields})+'\n');
    await wait(e=>e.event==='busy'&&e.value===false,offset);return events.slice(offset);
  }
  const settings={configPath:join(root,'private.json'),rootPath:join(root,'files'),serverUrl:`https://127.0.0.1:${address.port}`,
    caCertificatePath:crt,scanSeconds:2,pairingCode:'QRM-test-secret',deviceLabel:'测试设备'};
  return {root,process,events,wait,command,settings,requests};
}
describe('desktop bridge process lifecycle',()=>{
  it('keeps the original Agent running through selection and cancellation, including invalid directories', async () => {
    const old = await fixture(); const target = await fixture();
    await old.command('pair', old.settings); await old.command('start');
    await old.wait(e => e.event === 'snapshot' && e.connected === true);
    expect(await old.command('begin-switch')).toContainEqual(expect.objectContaining({event:'switching',active:true,revoked:false}));
    await old.command('login', {...target.settings,email:'chair@example.com',password:'password'});
    const choice = await old.command('select-committee',{committeeId:'10000000-0000-4000-8000-000000000001'});
    expect(choice).toContainEqual(expect.objectContaining({event:'setup'}));
    expect(old.requests.some(r=>r.url.endsWith('/revoke'))).toBe(false);
    const invalid = await old.command('switch-committee',{...target.settings,rootPath:old.settings.rootPath});
    expect(invalid).toContainEqual(expect.objectContaining({event:'error',code:'DIRECTORY_NOT_EMPTY',stage:'storage-directory'}));
    expect(invalid.some(e=>e.state==='STOPPING')).toBe(false);
    expect(old.requests.some(r=>r.url.endsWith('/revoke'))).toBe(false);
    const cancelled = await old.command('cancel-switch');
    expect(cancelled).toContainEqual(expect.objectContaining({event:'config',configPath:old.settings.configPath}));
    expect(cancelled).toContainEqual(expect.objectContaining({event:'state',state:'RUNNING'}));
    expect(target.requests.some(r=>r.url.endsWith('/pair'))).toBe(false);
    await old.command('stop');
  }, 30000);

  it.each([200,503])('commits a selected switch only after confirmation and handles revoke failure (%s)', async revokeStatus => {
    const old = await fixture(200,revokeStatus); const target = await fixture();
    await old.command('pair',old.settings); await old.command('start');
    await old.wait(e=>e.event==='snapshot'&&e.connected===true);
    await old.command('begin-switch');
    const signedIn = await old.command('login',{...target.settings,email:'chair@example.com',password:'password'});
    expect(signedIn).toContainEqual(expect.objectContaining({event:'candidates',email:'chair@example.com'}));
    await old.command('select-committee',{committeeId:'10000000-0000-4000-8000-000000000001'});
    const result = await old.command('switch-committee',target.settings);
    expect(old.requests.filter(r=>r.url.endsWith('/revoke'))).toHaveLength(1);
    if(revokeStatus===200) {
      expect(result).toContainEqual(expect.objectContaining({event:'config',serverUrl:target.settings.serverUrl}));
      expect(result).toContainEqual(expect.objectContaining({event:'switching',active:false}));
      expect(target.requests.filter(r=>r.url.endsWith('/pair'))).toHaveLength(1);
      expect(result.some(e=>e.state==='STARTING')).toBe(true);
    } else {
      expect(result).toContainEqual(expect.objectContaining({event:'error',operation:'switch-committee',stage:'revoke'}));
      expect(target.requests.filter(r=>r.url.endsWith('/pair'))).toHaveLength(0);
      const cancel = await old.command('cancel-switch');
      expect(cancel).toContainEqual(expect.objectContaining({event:'config',configPath:old.settings.configPath}));
      expect(cancel.some(e=>e.state==='STARTING')).toBe(true);
    }
    expect(JSON.stringify(result)).not.toContain('qsa1.');
    await old.command('stop');
  },30000);

  it('returns an expired target account to sign in without revoking the current connection', async () => {
    const old=await fixture();const target=await fixture(200,200,false,false,401);
    await old.command('pair',old.settings);
    await old.command('begin-switch');
    await old.command('login',{...target.settings,email:'chair@example.com',password:'password'});
    await old.command('select-committee',{committeeId:'10000000-0000-4000-8000-000000000001'});
    const failed=await old.command('switch-committee',target.settings);
    expect(failed).toContainEqual(expect.objectContaining({event:'account',page:'login'}));
    expect(failed).toContainEqual(expect.objectContaining({event:'error',code:'AUTHENTICATION_REQUIRED',stage:'pairing'}));
    expect(old.requests.some(r=>r.url.endsWith('/revoke'))).toBe(false);
    expect(await old.command('cancel-switch')).toContainEqual(expect.objectContaining({event:'config',configPath:old.settings.configPath}));
  },30000);

  it('keeps a failed target available for retry without revoking the old device twice',async()=>{
    const old=await fixture();const target=await fixture(410);
    await old.command('pair',old.settings);
    await old.command('begin-switch');
    await old.command('login',{...target.settings,email:'chair@example.com',password:'password'});
    await old.command('select-committee',{committeeId:'10000000-0000-4000-8000-000000000001'});
    const first=await old.command('switch-committee',target.settings);
    expect(first).toContainEqual(expect.objectContaining({event:'switching',revoked:true}));
    expect(first).toContainEqual(expect.objectContaining({event:'error',code:'LINK_EXPIRED'}));
    await old.command('switch-committee',target.settings);
    expect(old.requests.filter(r=>r.url.endsWith('/revoke'))).toHaveLength(1);
    expect(target.requests.filter(r=>r.url.endsWith('/pair'))).toHaveLength(2);
    expect(await old.command('cancel-switch')).toContainEqual(expect.objectContaining({event:'unpaired'}));
  },30000);

  it.each([200, 503])('stops before revoking a running connection (HTTP %s)', async status => {
    const f = await fixture(200, status);
    await f.command('pair', f.settings);
    await f.command('start');
    await f.wait(e => e.event === 'snapshot' && e.connected === true);
    const result = await f.command('unpair');
    const exited = result.findIndex(e => e.event === 'state' && e.state === 'EXITED');
    expect(exited).toBeGreaterThanOrEqual(0);
    expect(f.requests.filter(r => r.url === '/api/v1/storage-agent/revoke')).toHaveLength(1);
    await (await lockAgentRoot(f.settings.rootPath))();
    if (status === 200) {
      expect(result.findIndex(e => e.event === 'unpaired')).toBeGreaterThan(exited);
      expect(await f.command('start')).toContainEqual(expect.objectContaining({code:'CONFIG_REQUIRED'}));
    } else {
      expect(result).toContainEqual(expect.objectContaining({event:'error', operation:'unpair'}));
      expect(result.some(e => e.event === 'unpaired')).toBe(false);
      expect(await f.command('start')).toContainEqual(expect.objectContaining({state:'STARTING'}));
      await f.command('stop');
    }
  });

  it('stops an idle connected Agent promptly and releases its directory', async () => {
    const f = await fixture();
    await f.command('pair', f.settings);
    await f.command('start');
    await f.wait(e => e.event === 'snapshot' && e.connected === true);
    await new Promise(resolve => setTimeout(resolve, 200));
    const started = performance.now();
    const stopped = await f.command('stop');
    expect(performance.now() - started).toBeLessThan(1500);
    expect(stopped).toContainEqual(expect.objectContaining({event:'state', state:'EXITED'}));
    expect(stopped.some(e => e.event === 'log' && e.text.includes('storage_agent.stopped'))).toBe(true);
    await (await lockAgentRoot(f.settings.rootPath))();
  }, 25000);

  it('recovers local persistence after server pairing without pairing a second device', async () => {
    const f = await fixture(200, 200, false, true);
    const failed = await f.command('pair', f.settings);
    expect(failed).toContainEqual(expect.objectContaining({event:'error',stage:'paired-local-recovery'}));
    await rm(f.settings.configPath, {recursive:true});
    const recovered = await f.command('pair', f.settings);
    expect(recovered).toContainEqual(expect.objectContaining({event:'config',paired:true}));
    expect(f.requests.filter(r=>r.url==='/api/v1/storage-agent/pair')).toHaveLength(1);
    expect(JSON.stringify(f.events)).not.toContain('qsa1.');
  });

  it('keeps initial password changes inside the native account flow and translates incorrect credentials', async () => {
    const f = await fixture(200, 200, true);
    const wrong = await f.command('login', {...f.settings, email:'chair@example.com', password:'wrong'});
    expect(wrong).toContainEqual(expect.objectContaining({event:'error',code:'INCORRECT_CREDENTIALS'}));
    const login = await f.command('login', {...f.settings, email:'chair@example.com', password:'temporary'});
    expect(login).toContainEqual(expect.objectContaining({event:'account',page:'password'}));
    expect(f.requests.some(r=>r.url==='/api/v1/storage-agent/committees')).toBe(false);
    expect(await f.command('change-password', {password:'new-private-password'})).toContainEqual(expect.objectContaining({event:'candidates'}));
    expect(JSON.stringify(f.events)).not.toContain('new-private-password');
    expect(await f.command('logout')).toContainEqual(expect.objectContaining({event:'account',page:'login'}));
  });
  it('logs in, selects a paused committee and pairs without exposing or persisting account secrets', async () => {
    const f = await fixture();
    expect(await f.command('restore')).toContainEqual(expect.objectContaining({event:'defaults', serverUrl:'https://quorum.sramun.org'}));
    const login = await f.command('login', {...f.settings, email:'chair@example.com', password:'account-password'});
    expect(login).toContainEqual(expect.objectContaining({event:'candidates', candidates:[expect.objectContaining({status:'PAUSED'})]}));
    const selected = await f.command('select-committee', {committeeId:'10000000-0000-4000-8000-000000000001'});
    expect(selected).toContainEqual(expect.objectContaining({event:'setup', committeeStatus:'PAUSED', storageProvider:'SERVER_VOLUME'}));
    expect(f.requests.filter(r=>r.url.endsWith('/pairing-codes'))).toHaveLength(0);
    const paired = await f.command('account-pair', f.settings);
    expect(paired).toContainEqual(expect.objectContaining({event:'config', paired:true}));
    expect(f.requests.filter(r=>r.url==='/api/v1/auth/logout')).toHaveLength(1);
    const saved = paired.find(e=>e.event==='config')!;
    expect(await readFile(saved.configPath,'utf8')).not.toMatch(/account-secret|account-password/);
    expect(JSON.stringify(f.events)).not.toMatch(/account-secret|account-password/);
    expect(await f.command('stop')).toContainEqual(expect.objectContaining({event:'state',state:'EXITED'}));
    expect(await f.command('save', {...f.settings,configPath:saved.configPath,serverUrl:'https://other.example.com'}))
      .toContainEqual(expect.objectContaining({event:'error',code:'STOP_AND_UNPAIR_FIRST'}));
  });

  it('imports a normal downloaded pairing file, confirms storage, starts and restores without re-pairing', async () => {
    const f = await fixture();
    const setup = {schemaVersion: 1, kind: 'quorum-agent-pairing', serverUrl: f.settings.serverUrl,
      committeeId: '10000000-0000-4000-8000-000000000001', committeeName: '安理会',
      pairingCode: f.settings.pairingCode, purpose: 'INITIAL', expiresAt: '2099-01-01T00:00:00Z'};
    const downloaded = join(f.root, 'council.quorum-agent');
    await writeFile(downloaded, JSON.stringify(setup), {mode: 0o644});
    const opened = await f.command('open', {target: downloaded});
    const preview = opened.find(e => e.event === 'setup')!;
    expect(preview.committeeName).toBe('安理会');
    expect(f.requests).toHaveLength(0);
    expect(JSON.stringify(opened)).not.toContain(f.settings.pairingCode);
    await f.command('setup-pair', {...f.settings, rootPath: join(f.root, 'chosen')});
    await f.wait(e => e.event === 'snapshot' && e.connected === true);
    const privateConfig = JSON.parse(await readFile(preview.configPath, 'utf8'));
    expect(privateConfig.committeeName).toBe('安理会');
    expect((await stat(preview.configPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(downloaded, 'utf8')).toBe(JSON.stringify(setup));
    await f.command('stop');
    await f.command('restore');
    expect(f.requests.filter(r => r.url === '/api/v1/storage-agent/pair')).toHaveLength(1);
    const reopened = await f.command('open', {target: downloaded});
    expect(reopened.some(e => e.event === 'setup')).toBe(false);
    const other = {...setup, committeeId: '10000000-0000-4000-8000-000000000002'};
    expect(await f.command('open', {target: 'quorum-agent://pair#' + encodeURIComponent(JSON.stringify(other))}))
      .toContainEqual(expect.objectContaining({code: 'STOP_AND_UNPAIR_FIRST'}));
    expect(f.requests.filter(r => r.url === '/api/v1/storage-agent/pair')).toHaveLength(1);
    await f.command('stop'); await f.command('unpair-local');
    const restored = await f.command('restore');
    expect(restored.some(e => e.paired === true)).toBe(false);
  }, 30000);
  it('rejects expired and credential-bearing pairing downloads before a network request', async () => {
    const f = await fixture();
    const setup = {schemaVersion: 1, kind: 'quorum-agent-pairing', serverUrl: f.settings.serverUrl,
      committeeId: '10000000-0000-4000-8000-000000000001', committeeName: '安理会',
      pairingCode: f.settings.pairingCode, purpose: 'INITIAL', expiresAt: '2000-01-01T00:00:00Z'};
    const url = (v: unknown) => 'quorum-agent://pair#' + encodeURIComponent(JSON.stringify(v));
    expect(await f.command('open', {target: url(setup)})).toContainEqual(expect.objectContaining({code: 'LINK_EXPIRED'}));
    expect(await f.command('open', {target: url({...setup, credential: 'secret'})}))
      .toContainEqual(expect.objectContaining({code: 'PAIRING_CONFIG_INVALID'}));
    expect(f.requests).toHaveLength(0);
  }, 30000);
  it('reports validation and TLS failures at the failing step without submitting pairing', async () => {
    const f = await fixture();
    expect(await f.command('pair',{...f.settings,serverUrl:'not a URL'}))
      .toContainEqual(expect.objectContaining({event:'error',code:'HTTPS_REQUIRED',stage:'server-address',operation:'pair'}));
    expect(await f.command('pair',{...f.settings,pairingCode:''}))
      .toContainEqual(expect.objectContaining({event:'error',code:'PAIRING_CODE_REQUIRED',stage:'pairing-input'}));
    expect(await f.command('pair',{...f.settings,caCertificatePath:''}))
      .toContainEqual(expect.objectContaining({event:'error',code:'DEPTH_ZERO_SELF_SIGNED_CERT',stage:'tls'}));
    expect(f.requests).toHaveLength(0);
    expect(JSON.stringify(f.events)).not.toContain(f.settings.pairingCode);
    expect(await f.command('pair',f.settings)).toContainEqual({event:'completed',operation:'pair'});
  },30000);
  it('reports malformed and missing configs without exposing file contents', async () => {
    const f = await fixture();
    expect(await f.command('load',f.settings)).toContainEqual(expect.objectContaining({code:'ENOENT',stage:'config-read'}));
    await writeFile(f.settings.configPath,'not-json-secret',{mode:0o600});
    expect(await f.command('load',f.settings)).toContainEqual(expect.objectContaining({code:'CONFIG_INVALID',stage:'config-read'}));
    expect(JSON.stringify(f.events)).not.toContain('not-json-secret');
  },30000);
  it('saves, reloads and pairs an unpaired configuration without saving the one-time code', async () => {
    const f = await fixture();
    const fields = {...f.settings, deviceLabel:'会议电脑'};
    expect(await f.command('save',fields)).toContainEqual(expect.objectContaining({event:'config',paired:false}));
    const saved = await readFile(fields.configPath,'utf8');
    expect(JSON.parse(saved)).toMatchObject({kind:'unpaired',deviceLabel:'会议电脑',rootPath:fields.rootPath});
    expect(saved).not.toContain(fields.pairingCode);
    expect(saved).not.toContain('credential');
    expect((await stat(fields.configPath)).mode & 0o777).toBe(0o600);
    expect(f.requests).toHaveLength(0);
    expect(await f.command('start')).toContainEqual(expect.objectContaining({event:'error',code:'CONFIG_REQUIRED'}));
    await f.command('save',{...fields,scanSeconds:7});
    const copy = join(f.root,'draft-copy.json');
    await f.command('save-as',{...fields,savePath:copy,scanSeconds:7});
    expect(await f.command('load',{configPath:fields.configPath})).toContainEqual(expect.objectContaining({paired:false,scanSeconds:7,deviceLabel:'会议电脑'}));
    expect(await f.command('pair',fields)).toContainEqual(expect.objectContaining({paired:true}));
    const paired = JSON.parse(await readFile(fields.configPath,'utf8'));
    expect(paired.credential).toMatch(/^qsa1/);
    expect(paired.kind).toBeUndefined();
    expect(JSON.parse(await readFile(copy,'utf8')).kind).toBe('unpaired');
    // Importing a draft after a paired config clears the launch identity without revoking it.
    expect(await f.command('load',{configPath:copy})).toContainEqual(expect.objectContaining({paired:false}));
    expect(await f.command('start')).toContainEqual(expect.objectContaining({event:'error',code:'CONFIG_REQUIRED'}));
    expect(f.requests.some(r=>r.url.endsWith('/revoke'))).toBe(false);
  },30000);
  it('keeps the saved draft when the server rejects pairing', async () => {
    const f = await fixture(400); await f.command('save',f.settings);
    const original = await readFile(f.settings.configPath,'utf8');
    expect(await f.command('pair',f.settings)).toContainEqual(expect.objectContaining({event:'error',code:'LINK_EXPIRED'}));
    expect(await readFile(f.settings.configPath,'utf8')).toBe(original);
    expect(await f.command('load',f.settings)).toContainEqual(expect.objectContaining({paired:false}));
    expect(await f.command('start')).toContainEqual(expect.objectContaining({event:'error',code:'CONFIG_REQUIRED'}));
  },30000);
  it('preserves an existing config and rejects drafts containing credentials', async () => {
    const f = await fixture(); await f.command('save',f.settings);
    const original = await readFile(f.settings.configPath,'utf8');
    expect(await f.command('save-as',{...f.settings,savePath:f.settings.configPath})).toContainEqual(expect.objectContaining({event:'error',code:'EEXIST'}));
    await writeFile(f.settings.configPath,JSON.stringify({...JSON.parse(original),credential:'secret'}),{mode:0o600});
    expect(await f.command('load',f.settings)).toContainEqual(expect.objectContaining({event:'error',code:'INVALID_DRAFT'}));
    expect(await f.command('save',f.settings)).toContainEqual(expect.objectContaining({event:'error',code:'CONFIG_EXISTS'}));
    expect(await f.command('pair',f.settings)).toContainEqual(expect.objectContaining({event:'error',code:'CONFIG_EXISTS'}));
    expect(f.requests).toHaveLength(0);
  },30000);
  it('pairs through private code input, starts, restarts and stops on GUI pipe EOF without exposing secrets',async()=>{
    const f=await fixture();
    expect((await f.command('pair',f.settings)).some(e=>e.event==='config')).toBe(true);
    expect(JSON.stringify(f.events)).not.toContain('QRM-test-secret');
    expect(JSON.stringify(f.events)).not.toContain('qsa1.');
    await f.command('start');await f.wait(e=>e.event==='snapshot'&&e.connected===true);
    await expect(lockAgentRoot(f.settings.rootPath)).rejects.toThrow('AGENT_ALREADY_RUNNING');
    await f.command('restart');
    await f.command('stop');await (await lockAgentRoot(f.settings.rootPath))();
    await f.command('start');
    f.process.stdin.end();
    const exit=await new Promise(resolve=>f.process.once('close',resolve));expect(exit).toBe(0);
    await (await lockAgentRoot(f.settings.rootPath))();
    expect(f.requests.find(r=>r.url.endsWith('/pair'))?.authorization).toBeUndefined();
    expect(f.requests.some(r=>r.url.includes('file-status')&&r.authorization?.startsWith('QuorumAgent '))).toBe(true);
  },30000);
  it('saves a private copy without overwriting and revokes before clearing the loaded identity', async () => {
    const f = await fixture(); await f.command('pair', f.settings);
    const original = await readFile(f.settings.configPath, 'utf8');
    const savePath = join(f.root, 'copy.json');
    expect(await f.command('save-as', {...f.settings, savePath})).toContainEqual(expect.objectContaining({event:'config', configPath:savePath}));
    expect(await readFile(savePath,'utf8')).toBe(original);
    expect((await stat(savePath)).mode & 0o777).toBe(0o600);
    expect(await f.command('save-as', {...f.settings, savePath})).toContainEqual(expect.objectContaining({event:'error',code:'EEXIST'}));
    expect(await f.command('unpair', {serverUrl:'https://wrong.invalid'})).toContainEqual({event:'unpaired'});
    expect(f.requests.find(r=>r.url.endsWith('/revoke'))?.authorization).toMatch(/^QuorumAgent /);
    expect(await readFile(f.settings.configPath,'utf8')).toBe(original);
    expect(await f.command('start')).toContainEqual(expect.objectContaining({event:'error',code:'CONFIG_REQUIRED'}));
    expect(JSON.stringify(f.events)).not.toContain('qsa1.');
  },30000);
  it('keeps the loaded config when the original server cannot be reached for revocation', async () => {
    const f = await fixture(); await f.command('pair', f.settings);
    const saved = JSON.parse(await readFile(f.settings.configPath,'utf8'));
    saved.serverUrl = 'https://127.0.0.1:1';
    await writeFile(f.settings.configPath,JSON.stringify(saved),{mode:0o600});
    await f.command('load',f.settings);
    const events = await f.command('unpair');
    expect(events.some(e=>e.event==='error')).toBe(true);
    expect(events.some(e=>e.event==='unpaired')).toBe(false);
    expect(await f.command('save',{...f.settings,serverUrl:saved.serverUrl})).toContainEqual(expect.objectContaining({event:'config'}));
    await rm(f.settings.rootPath,{recursive:true,force:true});
    await rm(f.settings.caCertificatePath);
    expect(await f.command('unpair-local')).toContainEqual({event:'unpaired'});
    expect(await f.command('start')).toContainEqual(expect.objectContaining({code:'CONFIG_REQUIRED'}));
  },30000);
  it.each([401,404,503])('allows explicit local unpair after revocation fails with HTTP %s', async status => {
    const f = await fixture(200, status); await f.command('pair', f.settings);
    const original = await readFile(f.settings.configPath, 'utf8');
    const localFile = join(f.settings.rootPath, 'notes.txt');
    await writeFile(localFile, 'committee notes');
    const failed = await f.command('unpair');
    expect(failed.some(e=>e.event==='error')).toBe(true);
    expect(failed.some(e=>e.event==='unpaired')).toBe(false);
    const count = f.requests.length;
    expect(await f.command('unpair-local')).toContainEqual({event:'unpaired'});
    expect(f.requests).toHaveLength(count);
    expect(await f.command('start')).toContainEqual(expect.objectContaining({code:'CONFIG_REQUIRED'}));
    expect(await readFile(f.settings.configPath,'utf8')).toBe(original);
    expect(await readFile(localFile,'utf8')).toBe('committee notes');
  },30000);
  it('rejects local unpair while the Agent is running', async () => {
    const f = await fixture(); await f.command('pair',f.settings);
    await f.command('start'); await f.wait(e=>e.event==='snapshot'&&e.connected===true);
    expect(await f.command('unpair-local')).toContainEqual(expect.objectContaining({code:'STOP_FIRST'}));
    await f.command('stop');
    expect(await f.command('unpair-local')).toContainEqual({event:'unpaired'});
  },30000);
  it('overwrites a draft or private copy only after explicit confirmation', async () => {
    const f = await fixture();
    await writeFile(f.settings.configPath, 'original', {mode:0o600});
    expect(await f.command('save',f.settings)).toContainEqual(expect.objectContaining({code:'EEXIST'}));
    expect(await readFile(f.settings.configPath,'utf8')).toBe('original');
    expect(await f.command('save',{...f.settings,overwrite:true})).toContainEqual(expect.objectContaining({paired:false}));
    expect(JSON.parse(await readFile(f.settings.configPath,'utf8')).kind).toBe('unpaired');
    await f.command('pair',{...f.settings,overwrite:true});
    const copy = join(f.root,'existing-copy.json');
    await writeFile(copy,'keep until confirmed',{mode:0o600});
    expect(await f.command('save-as',{...f.settings,savePath:copy})).toContainEqual(expect.objectContaining({code:'EEXIST'}));
    expect(await readFile(copy,'utf8')).toBe('keep until confirmed');
    expect(await f.command('save-as',{...f.settings,savePath:copy,overwrite:true})).toContainEqual(expect.objectContaining({paired:true,configPath:copy}));
    expect(JSON.parse(await readFile(copy,'utf8')).credential).toMatch(/^qsa1/);
    expect((await stat(copy)).mode & 0o777).toBe(0o600);
  },30000);
  it.each([200,400])('preserves the old config until confirmed pairing succeeds (%s)', async status => {
    const f = await fixture(status);
    await writeFile(f.settings.configPath,'old configuration',{mode:0o600});
    expect(await f.command('pair',f.settings)).toContainEqual(expect.objectContaining({code:'CONFIG_EXISTS'}));
    expect(f.requests).toHaveLength(0);
    const result = await f.command('pair',{...f.settings,overwrite:true});
    if (status === 200) {
      expect(result).toContainEqual(expect.objectContaining({paired:true}));
      expect(JSON.parse(await readFile(f.settings.configPath,'utf8')).credential).toMatch(/^qsa1/);
    } else {
      expect(result).toContainEqual(expect.objectContaining({code:'LINK_EXPIRED'}));
      expect(await readFile(f.settings.configPath,'utf8')).toBe('old configuration');
    }
  },30000);
  it('rejects overwriting a symbolic link even after confirmation', async () => {
    const f = await fixture();
    const target = join(f.root,'target.json');
    await writeFile(target,'keep',{mode:0o600});
    await symlink(target,f.settings.configPath);
    expect(await f.command('save',{...f.settings,overwrite:true})).toContainEqual(expect.objectContaining({code:'UNSAFE_PATH'}));
    expect(await f.command('pair',{...f.settings,overwrite:true})).toContainEqual(expect.objectContaining({code:'UNSAFE_PATH'}));
    expect(await readFile(target,'utf8')).toBe('keep');
    expect(f.requests).toHaveLength(0);
  },30000);
  it('preserves existing config on repeated pairing and rejects another directory identity',async()=>{
    const f=await fixture();await f.command('pair',f.settings);
    const original=await readFile(f.settings.configPath,'utf8');
    expect(await f.command('pair',f.settings)).toContainEqual(expect.objectContaining({event:'error',code:'CONFIG_EXISTS'}));
    expect(await readFile(f.settings.configPath,'utf8')).toBe(original);
    expect(await f.command('pair',{...f.settings,configPath:join(f.root,'new.json')}))
      .toContainEqual(expect.objectContaining({event:'error',code:'ROOT_ALREADY_PAIRED'}));
    expect(await f.command('pair',{...f.settings,configPath:''}))
      .toContainEqual(expect.objectContaining({event:'error',code:'CONFIG_PATH_REQUIRED'}));
    expect(await f.command('load',{configPath:''}))
      .toContainEqual(expect.objectContaining({event:'error',code:'CONFIG_PATH_REQUIRED'}));
    const wrongRoot=join(f.root,'other-files');await mkdir(wrongRoot);
    await writeFile(join(wrongRoot,'.quorum-storage.json'),JSON.stringify({committeeId:'other',deviceId:'other'}),{mode:0o600});
    expect(await f.command('save',{...f.settings,rootPath:wrongRoot})).toContainEqual(expect.objectContaining({event:'error',code:'ROOT_IDENTITY_MISMATCH'}));
    const result=await f.command('save',{...f.settings,scanSeconds:0});
    expect(result).toContainEqual(expect.objectContaining({event:'error',code:'INVALID_SCAN_INTERVAL'}));
    expect(await readFile(f.settings.configPath,'utf8')).toBe(original);
  },30000);
});
