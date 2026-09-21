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
async function fixture(pairStatus = 200, revokeStatus = 200) {
  const root=await mkdtemp(join(tmpdir(),'quorum-desktop-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const key=join(root,'key.pem'),crt=join(root,'ca.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',crt,
    '-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});
  const requests: {url:string; authorization?:string; body:string}[]=[];
  const server=createServer({key:await readFile(key),cert:await readFile(crt)}, async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    requests.push({url:req.url!,authorization:req.headers.authorization,body});
    if(req.url==='/api/v1/storage-agent/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': ready\n\n');return;}
    if(req.url==='/api/v1/storage-agent/pair' && pairStatus !== 200){res.writeHead(pairStatus,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'LINK_EXPIRED'}}));return;}
    if(req.url==='/api/v1/storage-agent/revoke' && revokeStatus !== 200){res.writeHead(revokeStatus,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:revokeStatus === 401 ? 'AUTHENTICATION_REQUIRED' : 'NOT_FOUND'}}));return;}
    const data=req.url==='/api/v1/storage-agent/revoke'?{revoked:true}:req.url==='/api/v1/storage-agent/pair'?{credential:'qsa1.20000000-0000-4000-8000-000000000001.'+'a'.repeat(43),
      host:{committeeId:'10000000-0000-4000-8000-000000000001',deviceId:'20000000-0000-4000-8000-000000000001',leaseGeneration:1}}
      :req.url?.includes('file-status')?{files:[],nextId:null,observedAt:new Date().toISOString()}
      :req.url?.includes('manifest')?{events:[],nextSequence:0,hasMore:false}
      :req.url?.includes('tasks')?{tasks:[],nextSequence:0,hasMore:false}:req.url?.includes('conflicts')?[]:{};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data}));
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));cleanup.push(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});
  const address=server.address();if(!address||typeof address==='string')throw Error('address');
  const process=spawn(globalThis.process.execPath,[resolve('packages/storage-agent/dist/desktop-bridge.js')],{stdio:'pipe'});
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
