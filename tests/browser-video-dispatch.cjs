const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.FENGHAO_PLAYWRIGHT_MODULE || 'playwright-core');
const publicRoot = path.resolve(__dirname, '../public');
const artifactRoot = path.resolve(__dirname, '../.artifacts/screen-video-dispatch-20261025/screen');
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.webm': 'video/webm' };
const row = (overrides = {}) => ({ dispatchId: 'DSP-LOCAL', deviceId: 'D1', title: '本地现场安全交底', status: 'ACTIVE',
  qrCode: 'screen-video:DSP-LOCAL:synthetic-local-test-token', expiresAt: new Date(Date.now() + 60000).toISOString(),
  video: { resourceId: 'V1', title: '现场视频', durationMs: 120000 }, participantCount: 2, completedCount: 1,
  workerName: 'DO-NOT-DISPLAY-WORKER', phone: 'DO-NOT-DISPLAY-PHONE', ...overrides });

(async () => {
  const heldDispatchResponses = new Set();
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/api/v1/screen-devices/D1/video-dispatch') {
      heldDispatchResponses.add(response);
      response.on('close', () => heldDispatchResponses.delete(response));
      return;
    }
    const file = path.resolve(publicRoot, `.${pathname}`);
    if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': `${types[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` }); fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    let current = row(), accessCount = 0, personalCount = 0, publishCount = 0, delayNext = false, hangNext = false, resolveDelayed;
    const calls = [];
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== baseUrl) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      calls.push({ path: url.pathname, method: request.method() });
      const respond = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) })
        .catch(error => { if (!request.failure()) throw error; });
      if (url.pathname === '/api/v1/screen/access-sessions') {
        accessCount++; return respond({ accessSessionId: 'ACCESS-LOCAL', deviceId: 'D1', deviceToken: 'synthetic-runtime', expiresAt: new Date(Date.now() + 86400000).toISOString(), maxUses: 200, remainingUses: 199, projectId: 'P1' });
      }
      if (url.pathname.endsWith('/config')) return respond({ deviceId: 'D1', deviceName: '本地合成终端', currentSessionId: personalCount ? 'PERSONAL-LOCAL' : null, playback: {} });
      if (url.pathname.endsWith('/video-dispatch')) {
        assert.equal(request.headers()['x-screen-device-token'], 'synthetic-runtime');
        if (hangNext) { hangNext = false; return route.continue(); }
        if (delayNext) { delayNext = false; await new Promise(resolve => { resolveDelayed = resolve; }); return respond(row({ title: '不应恢复的旧分发' })); }
        return respond(current);
      }
      if (url.pathname.endsWith('/commands')) return respond([]);
      if (url.pathname.endsWith('/assistant/status')) return respond({ configured: false, speech: false });
      if (url.pathname === '/api/v1/screen-sessions') {
        personalCount++; return respond({ sessionId: 'PERSONAL-LOCAL', status: 'waiting_scan', qrUrl: '/files/synthetic-qr.png', expireAt: new Date(Date.now() + 600000).toISOString() });
      }
      if (url.pathname.endsWith('/PERSONAL-LOCAL')) return respond({ sessionId: 'PERSONAL-LOCAL', status: 'waiting_scan', qrUrl: '/files/synthetic-qr.png', expireAt: new Date(Date.now() + 600000).toISOString() });
      if (url.pathname.endsWith('/admin/auth/login')) return respond({ token: 'synthetic-project-admin', role: 'PROJECT_ADMIN', projectId: 'P1', name: '本地项目管理员' });
      if (url.pathname.endsWith('/admin/training-resources')) return respond([{ resourceId: 'V1', title: '本机库内视频', type: 'VIDEO', status: 'ACTIVE', processingStatus: 'READY', durationMs: 120000, durationSec: 120, url: '/files/synthetic-video.mp4' }]);
      if (url.pathname === '/api/v1/admin/screen-video-dispatches') {
        publishCount++; assert.equal(request.headers().authorization, 'Bearer synthetic-project-admin');
        assert.deepEqual(request.postDataJSON(), { deviceId: 'D1', resourceId: 'V1', title: '本机发布交底', validHours: 24 });
        current = row({ title: '本机发布交底' }); return respond(current);
      }
      return respond(null);
    });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseUrl + '/screen.html#token=synthetic-link', { waitUntil: 'networkidle' });
    assert.equal(calls.length, 0, 'preview must not consume authorization or request any business API');
    await page.getByRole('button', { name: '开始使用（扣 1 次）', exact: true }).click();
    await page.locator('.assistant-overlay').getByRole('button', { name: '扫码学习', exact: true }).click();
    const dispatchView = page.getByRole('region', { name: '现场视频扫码学习', exact: true });
    await dispatchView.getByText('本地现场安全交底', { exact: true }).waitFor();
    await page.locator('.dispatch-qr canvas').waitFor({ state: 'attached' });
    assert.equal(personalCount, 0); assert.equal(accessCount, 1);
    assert.doesNotMatch(await dispatchView.innerText(), /DO-NOT-DISPLAY/);
    assert.equal(await page.locator('.dispatch-qr').getAttribute('title'), null);
    await page.locator('.term-top').getByRole('button', { name: '项目管理员登录', exact: true }).click();
    await page.getByRole('dialog', { name: '项目管理员登录', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('.admin-login-overlay').waitFor({ state: 'detached' });
    await page.locator('.dispatch-qr canvas').waitFor({ state: 'attached' });
    assert.equal(personalCount, 0); assert.equal(accessCount, 1);
    hangNext = true;
    const abortedRead = page.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).pathname.endsWith('/video-dispatch'), timeout: 20000 });
    await dispatchView.getByRole('button', { name: '刷新当前分发', exact: true }).click();
    await dispatchView.getByText('现场视频读取超时，请点击刷新重试。', { exact: true }).waitFor({ timeout: 20000 });
    await abortedRead;
    await new Promise(setImmediate);
    assert.equal(heldDispatchResponses.size, 0, 'timeout must abort the actual held HTTP connection');
    await dispatchView.getByRole('button', { name: '刷新当前分发', exact: true }).click();
    await dispatchView.getByText('本地现场安全交底', { exact: true }).waitFor();
    await page.locator('.dispatch-qr canvas').waitFor({ state: 'attached' });
    assert.equal(personalCount, 0); assert.equal(accessCount, 1);
    current = row({ title: '<img src=x onerror=alert(1)>安全交底' });
    await dispatchView.getByRole('button', { name: '刷新当前分发', exact: true }).click();
    await dispatchView.getByText(current.title, { exact: true }).waitFor();
    assert.equal(await dispatchView.locator('.scan-copy img').count(), 0);
    await page.locator('.term-top').getByRole('button', { name: '安全问答', exact: true }).click();
    await page.locator('.assistant-overlay').focus();
    current = row({ expiresAt: new Date(Date.now() + 1800).toISOString() });
    await page.keyboard.press('Escape');
    await page.locator('.assistant-overlay').waitFor({ state: 'detached' });
    await page.locator('.dispatch-qr canvas').waitFor({ state: 'attached' });
    await page.locator('.dispatch-qr').waitFor({ state: 'detached' });
    current = row({ status: 'ENDED' });
    await dispatchView.getByRole('button', { name: '刷新当前分发', exact: true }).click();
    assert.equal(await page.locator('.dispatch-qr').count(), 0);
    delayNext = true;
    await dispatchView.getByRole('button', { name: '刷新当前分发', exact: true }).click();
    await page.locator('.term-top').getByRole('button', { name: '安全问答', exact: true }).click();
    resolveDelayed();
    await page.locator('.assistant-overlay').waitFor();
    assert.doesNotMatch(await page.locator('.scan-copy').innerText(), /不应恢复的旧分发/);
    current = null;
    await page.locator('.assistant-overlay').getByRole('button', { name: '扫码学习', exact: true }).click();
    await dispatchView.getByRole('button', { name: '个人集中学习（原流程）', exact: true }).click();
    await page.getByText('扫码后开始个人学习', { exact: true }).waitFor();
    assert.equal(personalCount, 1); assert.equal(accessCount, 1);
    await page.locator('.term-top').getByRole('button', { name: '项目管理员登录', exact: true }).click();
    await page.getByLabel('登录账号').fill('synthetic-admin');
    await page.getByLabel('登录密码').fill('synthetic-password');
    await page.getByRole('button', { name: '登录并查看视频', exact: true }).click();
    const form = page.getByRole('region', { name: '分发当前视频到本机', exact: true });
    await form.getByLabel('分发标题').fill('本机发布交底');
    await form.getByRole('button', { name: '发布到本机', exact: true }).evaluate(button => { button.click(); button.click(); });
    await form.getByText(/已发布临时视频/).waitFor();
    assert.equal(publishCount, 1);
    await form.getByRole('button', { name: '查看当前分发码', exact: true }).click();
    await page.locator('.admin-video-overlay').waitFor({ state: 'detached' });
    await dispatchView.getByText('本机发布交底', { exact: true }).waitFor();
    await page.locator('.dispatch-qr canvas').waitFor({ state: 'attached' });
    const readsBeforeVideoOverlay = calls.filter(call => call.path.endsWith('/video-dispatch')).length;
    await page.locator('.term-top').getByRole('button', { name: '视频查看', exact: true }).click();
    await page.getByRole('button', { name: '关闭培训视频查看', exact: true }).click();
    await page.locator('.admin-video-overlay').waitFor({ state: 'detached' });
    await dispatchView.getByText('本机发布交底', { exact: true }).waitFor();
    await page.locator('.dispatch-qr canvas').waitFor({ state: 'attached' });
    assert.equal(calls.filter(call => call.path.endsWith('/video-dispatch')).length, readsBeforeVideoOverlay + 1, 'closing the video overlay resumes exactly one current-dispatch read');
    assert.equal(accessCount, 1); assert.equal(personalCount, 1);
    assert.deepEqual(errors, []);
    fs.mkdirSync(artifactRoot, { recursive: true });
    await page.screenshot({ path: path.join(artifactRoot, 'dispatch-code-local.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    console.log('Screen local HTTP browser passed: no preview consumption, runtime-authenticated local QR, safe aggregate view, 15-second held HTTP timeout/abort/retry, expiry/end clear, stale response ignored, explicit legacy entry, project-admin publish, assistant/admin/login close restores QR and expiry, mobile layout.');
  } finally {
    if (browser) await browser.close();
    for (const response of heldDispatchResponses) response.destroy();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
