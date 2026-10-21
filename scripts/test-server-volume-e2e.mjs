import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,rm,mkdir,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {chromium} from 'playwright-core';
import {runMigrations} from '../server/dist/db/migrations.js';
import {IdentityService} from '../server/dist/modules/identity/service.js';
import {PostgresIdentityStore} from '../server/dist/modules/identity/postgres.js';
import {Stage3Service} from '../server/dist/modules/stage3/service.js';
import {Stage4Service} from '../server/dist/modules/stage4/service.js';
import {Stage6StorageService} from '../server/dist/modules/storage/service.js';
import {Stage6UploadService} from '../server/dist/modules/storage/upload-service.js';
import {Stage6ServerVolumeService} from '../server/dist/modules/storage/server-volume-service.js';
import {ServerVolumeStore} from '../server/dist/modules/storage/server-volume.js';
import {DurableStagingStore} from '../server/dist/modules/storage/staging.js';
import {testCommitteeInput} from '../server/dist/test/committee-fixture.js';

// Uses only a randomly named temporary database, never the configured application DB.
if(!process.env.TEST_DATABASE_ADMIN_URL){console.log('SKIP: TEST_DATABASE_ADMIN_URL is required.');process.exit(0);}
const {Client,Pool}=createRequire(new URL('../server/package.json',import.meta.url))('pg');
const database=`quorum_volume_e2e_${randomUUID().replaceAll('-','')}`;
const admin=new Client({connectionString:process.env.TEST_DATABASE_ADMIN_URL});
const root=await mkdtemp(join(tmpdir(),'quorum-volume-e2e-'));
const artifacts=resolve(process.env.QUORUM_E2E_ARTIFACTS || 'outputs/server-volume-e2e');
const backendPort=Number(process.env.QUORUM_E2E_API_PORT || 4319);
const webPort=Number(process.env.QUORUM_E2E_WEB_PORT || 5178);
const origin=`http://localhost:${webPort}`;
let pool,browser;const children=[];const logs=[];
const context=requestId=>({requestId,sourceIp:'127.0.0.1',userAgent:'VolumeE2E'});
const digest=value=>createHash('sha256').update(value).digest('hex');
const start=(cmd,args,env)=>{const child=spawn(cmd,args,{cwd:resolve('.'),env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  children.push(child);child.stdout.on('data',data=>logs.push(data.toString()));child.stderr.on('data',data=>logs.push(data.toString()));child.on('exit',code=>{console.log(`Test service exited: ${cmd} (${code})`);if(code)console.log(logs.slice(0,12).join(''));});return child;};
async function waitUntil(check,label,timeout=30000){const until=Date.now()+timeout;let last;
  while(Date.now()<until){try{if(await check())return;}catch(error){last=error;}await new Promise(resolve=>setTimeout(resolve,200));}
  throw new Error(`Timed out: ${label}`,{cause:last});}
try{
  await mkdir(artifacts,{recursive:true});await admin.connect();await admin.query(`CREATE DATABASE "${database}"`);
  const url=new URL(process.env.TEST_DATABASE_ADMIN_URL);url.pathname=`/${database}`;pool=new Pool({connectionString:url.toString()});
  await runMigrations(pool,resolve('server/migrations'));
  const identity=new IdentityService(new PostgresIdentityStore(pool));const stage3=new Stage3Service(pool);const stage4=new Stage4Service(pool);
  await stage3.ensureBuiltins();
  const login=await identity.bootstrapAdmin({secret:await identity.ensureBootstrapSecret(),email:'volume-admin@example.test',
    displayName:'Volume administrator',password:'Volume-admin-test-123!'},context('bootstrap'));
  const administrator=await identity.authenticate(login.sessionToken);
  const created=await identity.createUser(administrator,{email:'volume-owner@example.test',displayName:'Volume owner'},context('owner'));
  const temporary=await identity.login({email:created.user.email,password:created.temporaryPassword},context('login-owner'));
  const ownerLogin=await identity.changePassword(await identity.authenticate(temporary.sessionToken),
    {currentPassword:created.temporaryPassword,newPassword:'Volume-owner-test-123!'},context('password'));
  const owner=await identity.authenticate(ownerLogin.sessionToken);
  const storage=new Stage6StorageService(pool);const staging=new DurableStagingStore(join(root,'staging'),1048576,2097152);
  await staging.initialize();const volume=new ServerVolumeStore(join(root,'server-volume'),1048576);await volume.initialize();
  const uploads=new Stage6UploadService(pool,staging);const commits=new Stage6ServerVolumeService(pool,storage,staging,volume);
  const committees=[];const files=[];
  for(const [name,archived] of [['Active volume committee',false],['Archived volume committee',true],['Unconfigured committee',false],['Selected volume committee',false]]){
    const committee=await stage4.createCommittee(owner,await testCommitteeInput(pool,owner,{name,visibility:'PUBLIC',countryTemplateKey:'builtin:default'}),randomUUID(),context(name));
    committees.push(committee);if(name==='Unconfigured committee')continue;
    await storage.createServerVolumeBinding(owner,committee.id,{baseRevision:committee.revision},randomUUID(),context('binding'));
    const content=`content for ${name}`;const upload=await uploads.createUpload(owner,committee.id,{logicalName:`${name}.txt`,originalName:'file.txt',mediaType:'text/plain',
      expectedSizeBytes:Buffer.byteLength(content),sha256:digest(content)},randomUUID(),context('upload'));
    await uploads.receiveContent(owner,upload.id,(async function*(){yield content;})(),randomUUID(),Buffer.byteLength(content),context('bytes'));
    files.push(await commits.commitUpload(owner,upload.id,{},randomUUID(),context('commit')));
    if(archived)await pool.query("UPDATE committees SET status='ARCHIVED',archived_at=now() WHERE id=$1",[committee.id]);
  }
  const sourcePaths=(await pool.query("SELECT c.name,b.storage_key FROM file_blobs b JOIN committees c ON c.id=b.committee_id ORDER BY c.name")).rows
    .map(row=>({name:row.name,path:volume.pathForKey(row.storage_key)}));
  await mkdir(join(root,'published-cache'),{recursive:true});const cachePath=join(root,'published-cache','keep');await writeFile(cachePath,'independent cache');
  start(process.execPath,['server/dist/index.js'],{DATABASE_URL:url.toString(),PORT:String(backendPort),HOST:'127.0.0.1',
    QUORUM_ALLOWED_ORIGINS:`http://localhost:${backendPort}`,QUORUM_STORAGE_PATH:root});
  start(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(webPort),'--strictPort'],{QUORUM_DEV_API_ORIGIN:`http://localhost:${backendPort}`});
  await waitUntil(async()=>{const response=await fetch(`${origin}/api/v1/bootstrap/status`,{signal:AbortSignal.timeout(2000)});return response.ok;},'application startup',60000);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const newPage=async token=>{const session=await browser.newContext({viewport:{width:1440,height:1000}});
    await session.addInitScript(()=>localStorage.setItem('muncoordinated-language','zh-CN'));
    await session.addCookies([{name:'__Host-quorum_session',value:token,domain:'localhost',path:'/',secure:true,httpOnly:true,sameSite:'Lax'},
      {name:'__Host-quorum_csrf',value:'volume-e2e-csrf',domain:'localhost',path:'/',secure:true,httpOnly:false,sameSite:'Lax'}]);
    const page=await session.newPage();page.on('pageerror',error=>logs.push(`BROWSER: ${error.message}`));return page;};
  const page=await newPage(login.sessionToken);await page.goto(`${origin}/system-settings/storage`);
  await page.getByRole('heading',{name:'服务器卷文件',exact:true}).waitFor();
  await page.getByText('Active volume committee.txt',{exact:false}).first().waitFor();
  assert.equal(await page.getByRole('button',{name:'清理所有委员会的服务器卷文件',exact:true}).count(),0);
  const toggled=page.waitForResponse(response=>response.url().endsWith('/admin/server-volume/policy') && response.request().method()==='PUT');
  await page.getByText('禁用服务器卷存储',{exact:true}).click();
  assert.equal((await toggled).status(),200,'policy update succeeds');
  await page.getByRole('button',{name:'清理所有委员会的服务器卷文件',exact:true}).waitFor();
  const ownerPage=await newPage(ownerLogin.sessionToken);await ownerPage.goto(`${origin}/committees/${committees[0].id}/posts/upload`);
  await ownerPage.getByText('服务器卷已被管理员禁用，无法提交新文件或新版本。请迁移到其他存储位置。',{exact:true}).waitFor();
  assert.equal(await ownerPage.locator('input[type="file"]').isDisabled(),true);
  await ownerPage.getByRole('button',{name:'迁移存储',exact:true}).click();await ownerPage.waitForURL('**/posts/storage');
  await ownerPage.screenshot({path:join(artifacts,'migration-guidance.png'),fullPage:true});
  await ownerPage.goto(`${origin}/committees/${committees[2].id}/posts/storage`);
  await waitUntil(async()=>await ownerPage.locator('.storage-empty-target').count()>0,'unconfigured storage choices');
  assert.equal(await ownerPage.locator('.storage-target-row').count(),0);
  await page.screenshot({path:join(artifacts,'volume-inventory.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:join(artifacts,'volume-inventory-mobile.png'),fullPage:true});
  assert.ok(await page.locator('.server-volume-admin').evaluate(panel=>panel.getBoundingClientRect().right<=window.innerWidth),'inventory stays within mobile viewport');
  assert.ok(await page.locator('.server-volume-table-scroll').evaluate(container=>container.scrollWidth>container.clientWidth),'wide table scrolls inside the panel');
  await page.getByRole('button',{name:'清理已归档委员会的服务器卷文件',exact:true}).click();
  const modal=page.locator('.ui.modal');await modal.waitFor();
  await modal.getByText('待清理文件',{exact:true}).click();
  assert.ok((await modal.innerText()).includes('Archived volume committee'));
  assert.ok(!(await modal.innerText()).includes('Active volume committee'));
  await page.screenshot({path:join(artifacts,'cleanup-confirmation-mobile.png'),fullPage:true});
  await modal.getByRole('button',{name:'取消',exact:true}).click();
  for(const item of sourcePaths)await access(item.path);
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'清理已归档委员会的服务器卷文件',exact:true}).click();await modal.waitFor();
  await modal.getByRole('button',{name:'确认删除',exact:true}).click();
  const archivedPath=sourcePaths.find(item=>item.name.startsWith('Archived')).path;
  await waitUntil(async()=>{try{await access(archivedPath);return false;}catch{return true;}},'archived file physical deletion');
  await access(sourcePaths.find(item=>item.name.startsWith('Active')).path);await access(cachePath);
  await page.getByRole('row').filter({hasText:'Selected volume committee.txt'}).getByRole('button',{name:'删除',exact:true}).click();
  await modal.waitFor();assert.ok((await modal.innerText()).includes('Selected volume committee.txt'));
  assert.ok(!(await modal.innerText()).includes('Active volume committee'));
  await modal.getByRole('button',{name:'确认删除',exact:true}).click();
  await waitUntil(async()=>{try{await access(sourcePaths.find(item=>item.name.startsWith('Selected')).path);return false;}catch{return true;}},'selected file physical deletion');
  await access(sourcePaths.find(item=>item.name.startsWith('Active')).path);await access(cachePath);
  await page.getByRole('button',{name:'清理所有委员会的服务器卷文件',exact:true}).click();await modal.waitFor();
  await modal.getByRole('button',{name:'确认删除',exact:true}).click();
  await waitUntil(async()=>{try{await access(sourcePaths.find(item=>item.name.startsWith('Active')).path);return false;}catch{return true;}},'all volume files physical deletion');
  await access(cachePath);
  await waitUntil(async()=>Number((await pool.query("SELECT count(*) AS count FROM server_volume_cleanup_batches WHERE status='RUNNING'")).rows[0].count)===0,'cleanup jobs completed');
  await page.reload();await page.getByText('文件数：0；占用：0 B',{exact:true}).waitFor();
  await page.screenshot({path:join(artifacts,'cleanup-completed.png'),fullPage:true});
  const runtimeErrors=logs.filter(line=>line.startsWith('BROWSER:'));assert.deepEqual(runtimeErrors,[]);
  const report={passed:true,checks:['administrator policy toggle','blocked upload and migration navigation','hidden volume target',
    'filesystem paths','responsive mobile inventory and confirmation','archive preview scope','cancel without deletion','archive-only physical deletion',
    'selected file physical deletion','all volume physical deletion','cache preservation','durable completion'],screenshots:5};
  await writeFile(join(artifacts,'result.json'),JSON.stringify(report,null,2));
  for(const name of ['failure.log','failure-0.png','failure-1.png'])await rm(join(artifacts,name),{force:true});
  console.log(JSON.stringify(report));
}catch(error){if(browser){for(const [i,session] of browser.contexts().entries()){const page=session.pages()[0];if(page)await page.screenshot({path:join(artifacts,`failure-${i}.png`),fullPage:true}).catch(()=>{});}}await writeFile(join(artifacts,'failure.log'),`${error.stack}\n${logs.join('')}`);throw error;}
finally{
  await browser?.close();
  for(const child of children)child.kill('SIGTERM');
  await Promise.all(children.map(child=>child.exitCode!==null?Promise.resolve():new Promise(resolve=>{child.once('exit',resolve);setTimeout(()=>{child.kill('SIGKILL');resolve();},5000).unref();})));
  await pool?.end();await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(()=>{});await admin.end();await rm(root,{recursive:true,force:true});
}
