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
import {templateBundleFixture, templateFlagImage} from '../server/dist/test/template-bundle-fixture.js';

if (!process.env.TEST_DATABASE_ADMIN_URL) {
  console.log('SKIP: TEST_DATABASE_ADMIN_URL is required.'); process.exit(0);
}
const {Client, Pool} = createRequire(new URL('../server/package.json', import.meta.url))('pg');
const admin = new Client({connectionString: process.env.TEST_DATABASE_ADMIN_URL});
const root = await mkdtemp(join(tmpdir(), 'quorum-template-e2e-'));
const artifacts = resolve(process.env.QUORUM_TEMPLATE_E2E_ARTIFACTS || 'outputs/template-transfer-e2e');
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
  const apiPort = Number(process.env.QUORUM_TEMPLATE_E2E_API_PORT || 4321) + index;
  const webPort = Number(process.env.QUORUM_TEMPLATE_E2E_WEB_PORT || 5181) + index;
  instance.origin = `http://localhost:${webPort}`;
  const storage = join(root, `storage-${index}`); await mkdir(storage);
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
async function exportFile(page, filename) {
  await page.getByRole('button', {name: '导出模板', exact: true}).click();
  const modal = page.locator('.template-transfer-modal');
  await modal.getByRole('button', {name: '下载文件', exact: true}).waitFor();
  const downloadPromise = page.waitForEvent('download');
  await modal.getByRole('button', {name: '下载文件', exact: true}).click();
  const download = await downloadPromise; const path = join(root, filename);
  await download.saveAs(path);
  return path;
}
async function importFile(page, path, screenshot) {
  await page.getByRole('button', {name: '导入模板', exact: true}).click();
  const modal = page.locator('.template-transfer-modal');
  await modal.locator('input[type=file]').setInputFiles(path);
  await modal.getByRole('button', {name: '导入为新模板', exact: true}).waitFor();
  await waitUntil(() => modal.getByRole('button', {name: '导入为新模板', exact: true}).isEnabled(), 'import preview');
  const bounds = await modal.evaluate(element => ({left: element.getBoundingClientRect().left,
    right: element.getBoundingClientRect().right, viewport: window.innerWidth}));
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewport, 'import dialog fits the viewport');
  if (screenshot) await page.screenshot({path: join(artifacts, screenshot), fullPage: true});
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/v1/template-imports') && response.request().method() === 'POST');
  await modal.getByRole('button', {name: '导入为新模板', exact: true}).click();
  const response = await responsePromise;
  assert.equal(response.status(), 201, await response.text());
  await modal.waitFor({state: 'hidden'});
  return (await response.json()).data;
}
async function assertImages(page) {
  await waitUntil(async () => page.locator('img.country-flag-display-image').evaluateAll(images =>
    images.length >= 2 && images.every(image => image.complete && image.naturalWidth > 0)), 'decoded standard and custom flags');
  const custom = page.locator('img.country-flag-display-image[src^="data:"]').first();
  assert.equal(await custom.getAttribute('src'), templateFlagImage);
  assert.equal(await custom.evaluate(image => image.naturalWidth), 24);
}

try {
  await mkdir(artifacts, {recursive: true}); await admin.connect();
  const source = await createInstance(0); const target = await createInstance(1);
  const countries = await source.stage4.createCountryTemplate(source.owner.auth, templateBundleFixture.countryTemplate, randomUUID(), context('seed-country'));
  const committee = await source.stage4.createCommitteeTemplate(source.owner.auth,
    {...templateBundleFixture.committeeTemplate, countryTemplateKey: countries.key}, randomUUID(), context('seed-committee'));
  browser = await chromium.launch({executablePath: process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox']});
  const sourcePage = await openPage(source);
  await sourcePage.locator('.selection.list .item').filter({hasText: '未来峰会'}).click();
  await assertImages(sourcePage);
  const path = await exportFile(sourcePage, 'committee.quorum-template.json');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), templateBundleFixture);
  checks.push('download contains complete names, flags, permissions, manual search codes and unused countries');

  const sameInstanceUser = await createUser(source, 'other-account');
  const accountPage = await openPage(source, sameInstanceUser);
  const accountResult = await importFile(accountPage, path);
  const accountCountry = (await source.stage4.listCountryTemplates(sameInstanceUser.auth)).find(item => item.id === accountResult.countryTemplateId);
  assert.ok(accountCountry); assert.equal(accountCountry.countries.length, 4);
  await assertImages(accountPage);
  checks.push('cross-account import creates an owned visible country template');
  await sourcePage.close(); await accountPage.close();
  source.backend.kill('SIGTERM'); source.web.kill('SIGTERM');
  await waitUntil(() => source.backend.exitCode !== null || source.backend.signalCode !== null, 'source instance stopped');

  const targetPage = await openPage(target);
  const imported = await importFile(targetPage, path, 'committee-import-preview.png');
  await assertImages(targetPage);
  assert.ok((await targetPage.locator('.template-members-table').innerText()).includes('🌳'));
  await targetPage.screenshot({path: join(artifacts, 'committee-imported.png'), fullPage: true});
  assert.deepEqual(await target.stage4.exportTemplate(target.owner.auth, 'committee', imported.committeeTemplateId), templateBundleFixture);
  const row = (await target.pool.query('SELECT owner_user_id,country_template_id FROM committee_templates WHERE id=$1', [imported.committeeTemplateId])).rows[0];
  assert.equal(row.owner_user_id, target.owner.auth.user.id); assert.equal(row.country_template_id, imported.countryTemplateId);
  checks.push('independent database import displays all flag types with the source instance stopped');

  const createdCommittee = await target.stage4.createCommittee(target.owner.auth,
    await testCommitteeInput(target.pool, target.owner.auth, {name: 'Imported summit', visibility: 'PRIVATE',
      committeeLanguage: 'zh-CN', committeeTemplateId: imported.committeeTemplateId}), randomUUID(), context('use-imported'));
  const snapshot = await target.stage4.snapshot(createdCommittee.id, target.owner.auth);
  assert.equal(snapshot.seats.length, 3);
  assert.equal(snapshot.seats.find(seat => seat.stableKey === 'hailan').flag.value, templateFlagImage);
  const added = await target.stage4.createSeat(target.owner.auth, createdCommittee.id, {stableKey: 'extra'}, randomUUID(), context('add-bundled-country'));
  assert.equal(added.flag.value, '🏳️‍🌈');
  checks.push('imported committee creates real seats and retains the full country catalogue for later additions');

  await targetPage.goto(`${target.origin}/countries`);
  await targetPage.locator('.country-manager-sidebar .list .item').filter({hasText: '未来峰会国家'}).click();
  await assertImages(targetPage);
  const editedName = '接收账号修改后的国家模板';
  await targetPage.locator('.country-manager-editor form input').first().fill(editedName);
  await targetPage.getByRole('button', {name: '保存国家模板', exact: true}).click();
  await waitUntil(async () => (await target.stage4.getCountryTemplate(target.owner.auth, imported.countryTemplateId)).names['zh-CN'] === editedName, 'editable imported country');
  const countryPath = await exportFile(targetPage, 'country.quorum-template.json');
  const countryBundle = JSON.parse(await readFile(countryPath, 'utf8'));
  assert.equal(countryBundle.kind, 'country'); assert.equal(countryBundle.countryTemplate.countries.length, 4);
  assert.equal(countryBundle.countryTemplate.countries[1].flag.value, templateFlagImage);
  await targetPage.setViewportSize({width: 360, height: 900});
  const secondImport = await importFile(targetPage, countryPath, 'country-import-mobile.png');
  assert.notEqual(secondImport.countryTemplateId, imported.countryTemplateId);
  const copied = await target.stage4.getCountryTemplate(target.owner.auth, secondImport.countryTemplateId);
  assert.equal(copied.names['zh-CN'], `${editedName}（导入）`);
  await assertImages(targetPage);
  await targetPage.reload();
  await targetPage.locator('.country-manager-sidebar .list .item').filter({hasText: `${editedName}（导入）`}).click();
  await assertImages(targetPage);
  await targetPage.screenshot({path: join(artifacts, 'country-imported-mobile.png'), fullPage: true});
  checks.push('country templates can be edited, exported and imported with collision renaming and persist after reload');
  const retained = (await target.pool.query("SELECT flag_value FROM country_template_countries WHERE country_template_id=$1 AND stable_key='hailan'", [secondImport.countryTemplateId])).rows[0].flag_value;
  assert.equal(digest(Buffer.from(retained.split(',')[1], 'base64')), digest(Buffer.from(templateFlagImage.split(',')[1], 'base64')));
  const runtimeErrors = logs.filter(line => line.startsWith('BROWSER:')); assert.deepEqual(runtimeErrors, []);
  const report = {passed: true, checks, imageSha256: digest(Buffer.from(templateFlagImage.split(',')[1], 'base64')), screenshots: 4};
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
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
