import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {chromium} from 'playwright-core';
import {runMigrations} from '../server/dist/db/migrations.js';
import {IdentityService} from '../server/dist/modules/identity/service.js';
import {PostgresIdentityStore} from '../server/dist/modules/identity/postgres.js';
import {Stage3Service} from '../server/dist/modules/stage3/service.js';
import {Stage4Service} from '../server/dist/modules/stage4/service.js';
import {testCommitteeInput} from '../server/dist/test/committee-fixture.js';
import {Stage6StorageService} from '../server/dist/modules/storage/service.js';
import {Stage6UploadService} from '../server/dist/modules/storage/upload-service.js';
import {Stage6ServerVolumeService} from '../server/dist/modules/storage/server-volume-service.js';
import {ServerVolumeStore} from '../server/dist/modules/storage/server-volume.js';
import {DurableStagingStore} from '../server/dist/modules/storage/staging.js';
import {templateBundleFixture, templateFlagImage} from '../server/dist/test/template-bundle-fixture.js';

if (!process.env.TEST_DATABASE_ADMIN_URL) {
  console.log('SKIP: TEST_DATABASE_ADMIN_URL is required.'); process.exit(0);
}
const {Client, Pool} = createRequire(new URL('../server/package.json', import.meta.url))('pg');
const admin = new Client({connectionString: process.env.TEST_DATABASE_ADMIN_URL});
const root = await mkdtemp(join(tmpdir(), 'quorum-template-e2e-'));
const artifacts = resolve(process.env.QUORUM_INTERACTION_E2E_ARTIFACTS || 'outputs/interaction-e2e');
const instances = [], children = [], logs = [], checks = [];
let browser;
const context = requestId => ({requestId, sourceIp: '127.0.0.1', userAgent: 'TemplateE2E'});
const digest = value => createHash('sha256').update(value).digest('hex');
const start = (args, env) => {
  const child = spawn(process.execPath, args, {cwd: resolve('.'), env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
  children.push(child);
  child.stdout.on('data', data => logs.push(data.toString()));
  child.stderr.on('data', data => logs.push(data.toString()));
  return child;
};
async function waitUntil(check, label, timeout = 60000) {
  const until = Date.now() + timeout; let last;
  while (Date.now() < until) {
    try {if (await check()) return;} catch (error) {last = error;}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${label}`, {cause: last});
}
async function createUser(instance, name) {
  const created = await instance.identity.createUser(instance.administrator,
    {email: `${name}@example.test`, displayName: name}, context(`create-${name}`));
  const login = await instance.identity.login({email: created.user.email, password: created.temporaryPassword}, context(`login-${name}`));
  const session = await instance.identity.changePassword(await instance.identity.authenticate(login.sessionToken),
    {newPassword: `${name}-test-password-123!`}, context(`password-${name}`));
  return {auth: await instance.identity.authenticate(session.sessionToken), token: session.sessionToken};
}
async function createInstance(index) {
  const database = `quorum_template_e2e_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${database}"`);
  const instance = {database}; instances.push(instance);
  const url = new URL(process.env.TEST_DATABASE_ADMIN_URL); url.pathname = `/${database}`;
  const pool = new Pool({connectionString: url.toString()}); instance.pool = pool;
  await runMigrations(pool, resolve('server/migrations'));
  const identity = new IdentityService(new PostgresIdentityStore(pool));
  const stage3 = new Stage3Service(pool), stage4 = new Stage4Service(pool);
  await stage3.ensureBuiltins();
  const session = await identity.bootstrapAdmin({secret: await identity.ensureBootstrapSecret(), email: 'admin@example.test',
    displayName: 'Template test administrator', password: 'Template-admin-test-123!'}, context('bootstrap'));
  Object.assign(instance, {identity, stage4, administrator: await identity.authenticate(session.sessionToken)});
  instance.owner = await createUser(instance, `owner-${index}`);
  const apiPort = Number(process.env.QUORUM_INTERACTION_E2E_API_PORT || 4331) + index;
  const webPort = Number(process.env.QUORUM_INTERACTION_E2E_WEB_PORT || 5191) + index;
  instance.origin = `http://localhost:${webPort}`;
  const storage = join(root, `storage-${index}`); await mkdir(storage); instance.storage=storage;
  instance.backend = start(['server/dist/index.js'], {DATABASE_URL: url.toString(), PORT: String(apiPort), HOST: '127.0.0.1',
    QUORUM_ALLOWED_ORIGINS: `http://localhost:${apiPort}`, QUORUM_STORAGE_PATH: storage});
  instance.web = start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
    {QUORUM_DEV_API_ORIGIN: `http://localhost:${apiPort}`});
  await waitUntil(async () => (await fetch(`${instance.origin}/api/v1/bootstrap/status`, {signal: AbortSignal.timeout(2000)})).ok, 'instance startup');
  return instance;
}
async function openPage(instance, user = instance.owner) {
  const session = await browser.newContext({viewport: {width: 1440, height: 1000}});
  await session.addInitScript(() => localStorage.setItem('muncoordinated-language', 'zh-CN'));
  await session.addCookies([
    {name: '__Host-quorum_session', value: user.token, domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax'},
    {name: '__Host-quorum_csrf', value: 'template-e2e-csrf', domain: 'localhost', path: '/', secure: true, httpOnly: false, sameSite: 'Lax'}
  ]);
  const page = await session.newPage();
  page.on('pageerror', error => logs.push(`BROWSER: ${error.message}`));
  await page.goto(`${instance.origin}/templates`);
  await page.getByRole('button', {name: '导入模板', exact: true}).waitFor();
  return page;
}

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
  await mkdir(artifacts,{recursive:true}); await admin.connect();
  const instance=await createInstance(0);
  const committee=await instance.stage4.createCommittee(instance.owner.auth,
    await testCommitteeInput(instance.pool,instance.owner.auth,{name:'交互验收委员会',visibility:'PUBLIC',operationMode:'CHAIR_OPERATED'}),randomUUID(),context('committee'));
  const country=await instance.stage4.createCountryTemplate(instance.owner.auth,templateBundleFixture.countryTemplate,randomUUID(),context('country'));
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const page=await openPage(instance);
  await page.goto(`${instance.origin}/committees/${committee.id}/notes`);
  await page.locator('#note-content').waitFor();
  let firstPost, releaseFirst; let creates=0;
  const created=new Promise(resolve=>firstPost=resolve);
  const release=new Promise(resolve=>releaseFirst=resolve);
  await page.route(`**/api/v1/committees/${committee.id}/notes`,async route=>{
    if(route.request().method()!=='POST')return route.continue();
    creates++; const result=await route.fetch(); if(creates===1){firstPost(); await release;}
    await route.fulfill({response:result});
  });
  await page.locator('#note-title').fill('慢响应笔记'); await page.locator('#note-content').fill('第一段');
  await created; await page.locator('#note-content').fill('第一段，继续输入'); releaseFirst();
  await waitUntil(async()=> (await instance.stage4.snapshot(committee.id,instance.owner.auth)).notes.some(note=>note.content==='第一段，继续输入'),'latest note persisted');
  assert.equal(creates,1); let snapshot=await instance.stage4.snapshot(committee.id,instance.owner.auth);
  assert.equal(snapshot.notes.length,1); const note=snapshot.notes[0];
  console.log("CHECK",checks.length+1); checks.push('typing during a delayed real create response creates one note and persists the latest text');
  await page.unroute(`**/api/v1/committees/${committee.id}/notes`);

  // Two real browser tabs write against the same database revision.
  const otherPage=await page.context().newPage();
  await otherPage.goto(`${instance.origin}/committees/${committee.id}/notes`);await otherPage.locator('#note-content').waitFor();
  await page.locator('#note-content').fill('我的未保存草稿');
  await otherPage.evaluate(async note=>{const {selfHostedApi:api}=await import('/src/services/self-hosted-api.ts');
    await api.updateNote(note.id,note.revision,{content:'第二个窗口保存的正文'});},note);
  await page.getByText('此笔记已在其他窗口修改。请比较内容后选择保留的版本。').waitFor();
  assert.equal(await page.locator('#note-content').inputValue(),'我的未保存草稿');
  const old=await instance.stage4.snapshot(committee.id,instance.owner.auth);
  await pause(1600); assert.equal((await instance.stage4.snapshot(committee.id,instance.owner.auth)).notes[0].content,old.notes[0].content);
  await page.getByText('比较内容',{exact:true}).click();
  await page.screenshot({path:join(artifacts,'notes-conflict.png'),fullPage:true});
  const comparison=await page.locator('.note-conflict-comparison').evaluate(element=>{
    const columns=[...element.querySelectorAll('.note-conflict-columns > .column')].map(item=>item.getBoundingClientRect());
    return {gap:columns[0].top-element.querySelector('summary').getBoundingClientRect().bottom,columnsApart:columns[1].left-columns[0].right};
  });assert.ok(comparison.gap>=10 && comparison.columnsApart>=10,'comparison has clear spacing and two aligned desktop columns');
  assert.equal(await page.locator('.note-conflict-actions .primary.button').count(),1);assert.equal(await page.locator('.note-conflict-actions .basic.button').count(),1);
  for(const width of [390,320]) {
    await page.setViewportSize({width,height:844});
    await waitUntil(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),`notes reflow at ${width}px`,5000);
    assert.ok(await page.locator('.note-conflict-columns').evaluate(element=>{
      const parent=element.getBoundingClientRect();return parent.right<=window.innerWidth && [...element.querySelectorAll(':scope > .column')].every(item=>item.getBoundingClientRect().right<=parent.right+1);
    }),`comparison cards fit their container at ${width}px`);
    await page.screenshot({path:join(artifacts,width===390?'notes-conflict-mobile.png':'notes-conflict-320.png'),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
  assert.equal(old.notes[0].content,'第二个窗口保存的正文');await otherPage.close();
  await page.getByRole('button',{name:'保存我的版本',exact:true}).click();
  await waitUntil(async()=> (await instance.stage4.snapshot(committee.id,instance.owner.auth)).notes[0].content==='我的未保存草稿','explicit conflict decision');
  await page.locator('#note-content').fill('离开页面自动保存');
  await page.locator(`a[href="/committees/${committee.id}/info"]`).first().click();
  await page.waitForURL('**/info');
  assert.equal((await instance.stage4.snapshot(committee.id,instance.owner.auth)).notes[0].content,'离开页面自动保存');
  console.log("CHECK",checks.length+1); checks.push('conflict pauses autosave, preserves the draft, requires an explicit decision; navigation flushes the draft');

  const crisis=await page.evaluate(async cid=>{
    const {selfHostedApi:api}=await import('/src/services/self-hosted-api.ts');
    const meeting=await api.startMeetingSession(cid);return api.createCrisis(cid,meeting.id);
  },committee.id);
  await page.goto(`${instance.origin}/committees/${committee.id}/crises/${crisis.id}`);
  await page.getByRole('textbox',{name:'危机标题',exact:true}).fill('离开时保存的危机草稿');
  await page.getByRole('spinbutton',{name:'处理时间（分钟）',exact:true}).fill('3');
  await page.locator(`a[href="/committees/${committee.id}/info"]`).first().click();await page.waitForURL('**/info');
  const savedCrisis=(await instance.stage4.snapshot(committee.id,instance.owner.auth)).crises.find(item=>item.id===crisis.id).updates[0];
  assert.equal(savedCrisis.title,'离开时保存的危机草稿');assert.equal(savedCrisis.handlingDurationMs,180000);assert.equal(savedCrisis.status,'UNPUBLISHED');
  console.log('CHECK',checks.length+1);checks.push('leaving a crisis saves its title and duration as a draft without publishing it');

  const representedSeat=await instance.stage4.createSeat(instance.owner.auth,committee.id,{stableKey:'china',canVote:true,canProceduralVote:true},randomUUID(),context('seat'));
  const meeting=(await instance.stage4.snapshot(committee.id,instance.owner.auth)).meetingSession;
  await instance.stage4.createAttendanceEvent(instance.owner.auth,committee.id,{meetingSessionId:meeting.id,seatId:representedSeat.id,type:'PRESENT'},context('present'));
  const document=await page.evaluate(async cid=>{
    const {selfHostedApi:api}=await import('/src/services/self-hosted-api.ts');const snapshot=await api.snapshot(cid);
    return api.createResolution(cid,{meetingSessionId:snapshot.meetingSession.id,customTitle:'原始名称',content:'原始正文'});
  },committee.id);
  await page.goto(`${instance.origin}/committees/${committee.id}/resolutions/${document.id}`);
  const documentTitle=page.getByPlaceholder('设置决议草案名称');await documentTitle.fill('尚未保存的名称');
  await page.evaluate(async document=>{const {selfHostedApi:api}=await import('/src/services/self-hosted-api.ts');
    await api.createDocumentVersion(document.id,{baseRevision:document.revision,customTitle:'另一窗口的新名称',content:'另一窗口的新正文',onBehalfOfSeatId:document.representedSeatId});},{...document,representedSeatId:representedSeat.id});
  await page.getByText('文书已有新版本。请比较内容后选择保留的版本。').waitFor();
  assert.equal(await documentTitle.inputValue(),'尚未保存的名称');
  await page.screenshot({path:join(artifacts,'document-conflict.png'),fullPage:true});
  await page.getByRole('button',{name:'使用最新版本',exact:true}).click();
  assert.equal(await documentTitle.inputValue(),'另一窗口的新名称');
  console.log('CHECK',checks.length+1);checks.push('a real document revision event preserves unsaved text until the user chooses the latest version');

  // Flag validation points to the missing image rather than the valid name.
  await page.goto(`${instance.origin}/countries`);
  await page.locator('.country-manager-sidebar .list .item').filter({hasText:'未来峰会国家'}).click();
  const row=page.locator('.country-template-table tbody tr').first();
  // Existing editor switches between standard / emoji / custom images.
  await page.screenshot({path:join(artifacts,'country-editor.png'),fullPage:true});
  const imageMode=page.locator('.country-flag-editor .dropdown').first();
  await imageMode.click(); await imageMode.locator('.menu .item').filter({hasText:'图片'}).click();
  await page.getByRole('button',{name:'保存国家模板',exact:true}).click();
  assert.ok(await page.locator('input[type=file][aria-invalid=true]').evaluate(input=>document.activeElement===input));
  assert.ok(await page.getByRole('alert').filter({hasText:'请选择旗帜图片'}).isVisible());
  await page.screenshot({path:join(artifacts,'flag-validation.png'),fullPage:true});
  for (const width of [1440,1024,390,320]) {
    await page.setViewportSize({width,height:1000});
    const layout=await page.locator('.country-editor-table').evaluate(table=>{
      const overflow=[...table.querySelectorAll('tbody td')].flatMap(cell=>[...cell.querySelectorAll('input,.ui.selection.dropdown,.country-flag-display')].filter(element=>{
        const bounds=element.getBoundingClientRect(),parent=cell.getBoundingClientRect();
        return bounds.width>0 && (bounds.left<parent.left-1 || bounds.right>parent.right+1);
      }).map(element=>element.className || element.tagName));
      return {overflow,pageWidth:document.documentElement.scrollWidth,viewport:window.innerWidth};
    });
    assert.deepEqual(layout.overflow,[],`country controls stay in their cells at ${width}px`);assert.ok(layout.pageWidth<=layout.viewport+1,`country page fits ${width}px`);
    if(width!==1440)await page.screenshot({path:join(artifacts,`country-editor-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
  console.log("CHECK",checks.length+1); checks.push('missing flag image focuses its file input and exposes its inline accessible error');
  // Discard the deliberately invalid template edit.
  page.on('dialog',dialog=>dialog.accept());

  // Actual downloads use the same production helper and real HTTP file bytes.
  const storage=new Stage6StorageService(instance.pool);
  const staging=new DurableStagingStore(join(instance.storage,'staging'),1048576,2097152); await staging.initialize();
  const volume=new ServerVolumeStore(join(instance.storage,'server-volume'),1048576); await volume.initialize();
  await storage.createServerVolumeBinding(instance.owner.auth,committee.id,{baseRevision:(await instance.stage4.snapshot(committee.id,instance.owner.auth)).committee.revision},randomUUID(),context('binding'));
  const content=Buffer.from('完整下载验收\n'.repeat(500));
  const uploads=new Stage6UploadService(instance.pool,staging);
  const upload=await uploads.createUpload(instance.owner.auth,committee.id,{logicalName:'验收文件',fileType:'WORKING_PAPER',originalName:'download.txt',mediaType:'text/plain',expectedSizeBytes:content.length,sha256:digest(content)},randomUUID(),context('upload'));
  await uploads.receiveContent(instance.owner.auth,upload.id,(async function*(){yield content;})(),randomUUID(),content.length,context('content'));
  const file=await new Stage6ServerVolumeService(instance.pool,storage,staging,volume).commitUpload(instance.owner.auth,upload.id,{},randomUUID(),context('commit'));
  await page.goto(`${instance.origin}/committees/${committee.id}/posts/attachments`);
  await page.locator('.committee-files-page').waitFor();
  const fileUrl=`/api/v1/files/${file.id}/download`;
  const downloadAction=()=>page.evaluate(async id=>{
    const {downloadPreparedFile}=await import('/src/services/file-download.ts');
    const {selfHostedApi:api}=await import('/src/services/self-hosted-api.ts');
    try {await downloadPreparedFile(()=>api.prepareFileDownload(id),()=>api.fileDownloadReadiness(id),api.fileDownloadUrl(id));return {saved:true};}
    catch(error){return {code:error.code,name:error.name,requestId:error.requestId};}
  },file.id);
  const downloadPromise=page.waitForEvent('download');
  const received=page.getByRole('button',{name:'下载文件',exact:true}).click(); const download=await downloadPromise; const downloadPath=join(root,'received.txt'); await download.saveAs(downloadPath); await received;
  assert.equal(digest(await readFile(downloadPath)),digest(content));
  let failures=0;
  await page.route(`**${fileUrl}`,route=>{failures++;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'FILE_CONTENT_UNAVAILABLE',reason:'STORAGE_AGENT_SOURCE_MISSING',message:'Unavailable',requestId:'e2e-download'}})});});
  const before=page.url(); const failed=await downloadAction(); assert.equal(failed.code,'FILE_CONTENT_UNAVAILABLE'); assert.equal(failed.requestId,'e2e-download');assert.equal(failures,3);assert.equal(page.url(),before);
  failures=0; await page.getByRole('button',{name:'下载文件',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'主席电脑上的源文件缺失'}).waitFor();
  assert.equal(failures,3);assert.equal(page.url(),before);
  await page.screenshot({path:join(artifacts,'download-failure.png'),fullPage:true});
  await pause(1200);assert.equal(failures,3); await page.unroute(`**${fileUrl}`);
  console.log("CHECK",checks.length+1); checks.push('real download SHA-256 matches; HTTP failure stays in the app, preserves diagnostics and stops after three attempts');

  // Admin read failures recover automatically, but stop after the retry limit.
  const adminLogin=await instance.identity.login({email:'admin@example.test',password:'Template-admin-test-123!'},context('admin-browser'));
  const session=await browser.newContext({viewport:{width:1440,height:1000}});
  await session.addInitScript(()=>localStorage.setItem('muncoordinated-language','zh-CN'));
  await session.addCookies([{name:'__Host-quorum_session',value:adminLogin.sessionToken,domain:'localhost',path:'/',secure:true,httpOnly:true,sameSite:'Lax'},
    {name:'__Host-quorum_csrf',value:'e2e',domain:'localhost',path:'/',secure:true,sameSite:'Lax'}]);
  const adminPage=await session.newPage(); let reads=0;
  await adminPage.route('**/api/v1/admin/users',route=>{
    if(route.request().method()!=='GET')return route.continue(); reads++;
    return reads<3?route.fulfill({status:503,body:'Unavailable'}):route.continue();
  });
  await adminPage.goto(`${instance.origin}/admin`);
  await adminPage.getByRole('cell',{name:'admin@example.test',exact:true}).waitFor(); assert.equal(reads,3);
  console.log("CHECK",checks.length+1); checks.push('account list recovers automatically from two transient server failures');

  // Local logout remains effective offline, across tabs and after a page reload.
  let logoutRequests=0;
  await session.route('**/api/v1/auth/logout',route=>{logoutRequests++;return route.abort('failed');});
  await adminPage.getByRole('button',{name:'退出登录',exact:true}).click();
  await adminPage.getByRole('button',{name:'登录',exact:true}).waitFor();
  await adminPage.reload(); await adminPage.getByRole('button',{name:'登录',exact:true}).waitFor();
  assert.ok(await adminPage.evaluate(()=>localStorage.getItem('quorum-local-logout')));
  await pause(4300);assert.ok(logoutRequests<=3);
  await adminPage.screenshot({path:join(artifacts,'offline-logout.png'),fullPage:true});
  const anonymous=await adminPage.evaluate(async()=>{const response=await fetch('/api/v1/admin/users');return response.status;});
  assert.equal(anonymous,401,'the server honors the local logout marker for privileged APIs');

  console.log("CHECK",checks.length+1); checks.push('logout immediately removes local access and survives reload while the server is unreachable; retries are bounded');
  await session.unroute('**/api/v1/auth/logout');
  await adminPage.locator('input[type=email]').fill('admin@example.test');await adminPage.locator('input[type=password]').fill('Template-admin-test-123!');
  await adminPage.getByRole('button',{name:'登录',exact:true}).click();
  await waitUntil(async()=>adminPage.evaluate(async()=> (await fetch('/api/v1/auth/me')).status===200),'fresh login after offline logout');
  const oldSession=(await instance.identity.authenticate(adminLogin.sessionToken).catch(()=>null))?.sessionId;
  assert.equal(oldSession,undefined,'the next login invalidates the previous cookie session');
  const late=await adminPage.evaluate(async()=>{
    const csrf=document.cookie.split(';').map(value=>value.trim()).find(value=>value.startsWith('__Host-quorum_csrf='))?.split('=')[1];
    const response=await fetch('/api/v1/auth/logout',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({localLogout:true,sessionId:'obsolete-session'})});
    return {logout:response.status,me:(await fetch('/api/v1/auth/me')).status};
  });
  assert.deepEqual(late,{logout:200,me:200});console.log('CHECK',checks.length+1);checks.push('fresh login clears the local marker, invalidates the previous session and survives a delayed old logout');
  const report={passed:true,checks,screenshots:11};await writeFile(join(artifacts,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} catch (error) {
  if (browser) for (const [index, session] of browser.contexts().entries()) {
    const page = session.pages()[0];
    if (page) await page.screenshot({path: join(artifacts, `failure-${index}.png`), fullPage: true}).catch(() => {});
  }
  await writeFile(join(artifacts, 'failure.log'), `${error.stack}\n${logs.join('')}`); throw error;
} finally {
  await browser?.close();
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => {
    child.once('exit', resolve); setTimeout(() => {child.kill('SIGKILL'); resolve();}, 5000).unref();
  })));
  for (const instance of instances) {
    await instance.pool?.end();
    // pg Pool.end can resolve before the socket has finished closing. Avoid forcing a
    // database shutdown into those closing clients (57P01 / unhandled pool error).
    await waitUntil(async()=>Number((await admin.query('SELECT count(*) FROM pg_stat_activity WHERE datname=$1',[instance.database])).rows[0].count)===0,'database connections closed',10000);
    await admin.query(`DROP DATABASE IF EXISTS "${instance.database}"`);
  }
  await admin.end(); await rm(root, {recursive: true, force: true});
}
