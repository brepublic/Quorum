import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {chromium} from 'playwright-core';

// Exercise the real portal, HTTP client and EventSource against controlled local
// HTTP responses. Database/provider behavior is covered by the integration suite.
const artifacts = resolve('outputs/merge-sync-e2e');
await mkdir(artifacts, {recursive: true});
const streams = new Set();
const checks = [], errors = [];
let reads = 0, connections = 0, failReads = false, stallReads = false;
let pending = false, saved = false;
const portal = () => ({
  committeeId: 'committee', committeeLanguage: 'zh-CN', committeeName: '合并同步验收', shareId: 'share',
  claimedSeat: {id: 'seat', displayName: '中国', rank: 'STANDARD'}, eligibleSeats: [],
  mayUpload: true, storageAvailable: true, eventSequence: 7, maxUploadSizeBytes: 1024,
  categoryOpenedAt: {}, files: [],
  pendingUploads: pending ? [{id: 'upload', logicalName: 'draft.txt', status: 'SAVING'}] : [],
  savedUploadIds: saved ? ['upload'] : []
});
const send = (res, data, status = 200) => {
  res.writeHead(status, {'content-type': 'application/json'});
  res.end(JSON.stringify(status === 200 ? {data} : {error: {code: 'SERVICE_NOT_READY'}}));
};
const vite = await createServer({server: {host: '127.0.0.1', port: 0}, plugins: [{
  name: 'merge-sync-fixture',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/__merge-sync') {
        const html = await server.transformIndexHtml(path, `<html><body><div id="root"></div>
          <script type="module">
          import React from 'react';
          import {createRoot} from 'react-dom/client';
          import Portal from '/src/pages/self-hosted/DelegateFilePortal.tsx';
          import {setLanguage} from '/src/i18n.tsx';
          import '/node_modules/semantic-ui-css/semantic.min.css';
          import '/src/App.css';
          setLanguage('zh-CN');createRoot(document.getElementById('root')).render(React.createElement(Portal));
          </script></body></html>`);
        res.setHeader('content-type', 'text/html'); res.end(html); return;
      }
      if (!path.startsWith('/api/v1/delegate-files/')) return next();
      if (path.endsWith('/events')) {
        connections++;
        res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'});
        res.write(': connected\n\n'); streams.add(res);
        res.on('close', () => streams.delete(res)); return;
      }
      for await (const _chunk of req) { /* Drain actual upload/request bytes. */ }
      if (path.endsWith('/bootstrap')) {
        reads++;
        if (stallReads) return;
        send(res, portal(), failReads ? 503 : 200); return;
      }
      if (path.endsWith('/uploads')) {send(res, {id: 'upload'}); return;}
      if (path.endsWith('/content')) {send(res, {}); return;}
      if (path.endsWith('/commit')) {pending = true; send(res, {kind: 'PENDING_HOST_COMMIT'}); return;}
      send(res, {}, 404);
    });
  }
}]});
let browser;
const heartbeat = setInterval(() => {
  for (const res of streams) res.write('event: portal.status\ndata: {"storageAvailable":true}\n\n');
}, 1000);
try {
  await vite.listen();
  const url = `http://localhost:${vite.httpServer.address().port}/__merge-sync#test-capability`;
  browser = await chromium.launch({executablePath: process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium',
    headless: true, args: ['--no-sandbox']});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  page.on('pageerror', error => errors.push(error.message));
  const status = page.locator('.delegate-file-navigation-desktop .right.menu');
  await page.goto(url);
  await status.getByText('实时', {exact: true}).waitFor();
  const originalConnections = connections;
  failReads = true;
  for (let i = 0; i < 3; i++) {
    const response = page.waitForResponse('**/api/v1/delegate-files/bootstrap');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    assert.equal((await response).status(), 503);
    await status.getByText('正在同步', {exact: true}).waitFor();
    await page.waitForTimeout(150); // Exceed the focus/visibility coalescing window.
  }
  failReads = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await status.getByText('实时', {exact: true}).waitFor();
  assert.equal(connections, originalConnections);
  checks.push('three failed reads recover without replacing a healthy EventSource');

  stallReads = true;
  await page.waitForTimeout(150);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('status').filter({hasText: '请求超时'}).waitFor({timeout: 20000});
  await status.getByText('正在同步', {exact: true}).waitFor();
  stallReads = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await status.getByText('实时', {exact: true}).waitFor();
  checks.push('the real HTTP deadline reports timeout and a subsequent refresh recovers');

  await page.locator('.delegate-file-navigation-desktop').getByText('上传文件', {exact: true}).click();
  await page.locator('input[type=file]').setInputFiles({name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('draft')});
  await page.locator('form').getByRole('button', {name: '提交', exact: true}).click();
  await page.getByText('正在保存', {exact: true}).first().waitFor();
  assert.equal(await page.locator('.delegate-file-upload-success').count(), 0);
  pending = false; saved = true;
  for (const res of streams) res.end();
  await page.locator('.delegate-file-upload-success').waitFor({timeout: 20000});
  await status.getByText('实时', {exact: true}).waitFor();
  checks.push('an asynchronous upload completed during disconnect is confirmed by its receipt on reconnect');
  await page.screenshot({path: resolve(artifacts, 'recovered-upload.png'), fullPage: true});

  const wechat = await browser.newPage({userAgent: 'Android MicroMessenger/8.0', viewport: {width: 390, height: 844}});
  let requests = 0;
  wechat.on('request', request => {if (request.url().includes('/api/v1/delegate-files/')) requests++;});
  await wechat.goto(url);
  await wechat.getByText('选择“在浏览器打开”', {exact: true}).waitFor();
  assert.equal(requests, 0);
  assert.equal(new URL(wechat.url()).hash, '#test-capability');
  checks.push('WeChat keeps the capability link and never starts portal HTTP/SSE operations');
  assert.deepEqual(errors, []);
  const report = {passed: true, checks, reads, connections};
  await writeFile(resolve(artifacts, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  clearInterval(heartbeat);
  await browser?.close();
  for (const res of streams) res.end();
  await vite.close();
}
