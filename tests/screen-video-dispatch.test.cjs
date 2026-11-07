const assert = require('node:assert/strict');
const test = require('node:test');
const { loadScreen, deferred } = require('./helpers/screen-harness.cjs');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const reactive = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/vendor/vue.global.prod.js'), 'utf8') + '; Vue.reactive', { setTimeout, clearTimeout });

const dispatch = (overrides = {}) => ({ dispatchId: 'DSP-TEST', deviceId: 'D1', title: '现场安全交底', status: 'ACTIVE',
  qrCode: 'screen-video:DSP-TEST:synthetic-random-token', expiresAt: new Date(Date.now() + 60000).toISOString(),
  video: { resourceId: 'V1', title: '安全交底', durationMs: 120000 }, participantCount: 2, completedCount: 1, ...overrides });
function fixture(handle = async () => dispatch(), config = {}) {
  const h = loadScreen(handle, config);
  h.screen.deviceId = 'D1'; h.screen.deviceToken = 'synthetic-runtime-token';
  return h;
}
test('扫码学习只读取当前临时分发并复用设备认证，不创建个人场次或开启授权', async () => {
  const h = fixture();
  assert.equal(typeof h.screen.openDispatchLearning, 'function');
  await h.screen.openDispatchLearning();
  assert.equal(h.screen.stage, 'dispatch');
  assert.equal(h.screen.videoDispatch.dispatchId, 'DSP-TEST');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, '/api/v1/screen-devices/D1/video-dispatch');
  assert.equal(h.calls[0].method, 'GET');
  assert.equal(h.calls[0].headers['X-Screen-Device-Token'], 'synthetic-runtime-token');
});
test('关闭与更换设备阻断迟到分发响应', async () => {
  const pending = deferred(); const h = fixture(() => pending.promise);
  assert.equal(typeof h.screen.openDispatchLearning, 'function');
  const loading = h.screen.openDispatchLearning();
  h.screen.stopDispatchPolling(); h.screen.deviceId = 'D2'; h.screen.deviceToken = 'new-runtime';
  pending.resolve(dispatch()); await loading;
  assert.equal(h.screen.videoDispatch, null);
});
test('结束、过期与不匹配的二维码不能继续展示', async () => {
  let row = dispatch(); const h = fixture(() => row);
  assert.equal(typeof h.screen.openDispatchLearning, 'function');
  await h.screen.openDispatchLearning();
  assert.equal(h.screen.videoDispatch.dispatchId, 'DSP-TEST');
  for (const invalid of [dispatch({ status: 'ENDED' }), dispatch({ expiresAt: new Date(Date.now() - 1).toISOString() }),
    dispatch({ qrCode: 'screen-video:OTHER:synthetic-random-token' }), dispatch({ qrCode: '<img src=x onerror=alert(1)>' })]) {
    row = invalid; await h.screen.pollVideoDispatch();
    assert.equal(h.screen.videoDispatch, null);
  }
});
test('未开启设备会话的管理员分发只给指引，不能自动消费授权', async () => {
  const h = fixture(); h.screen.accessMode = true; h.screen.accessState = 'ready';
  h.screen.adminSession = { token: 'synthetic-admin' };
  h.screen.adminVideos = [{ resourceId: 'V1', type: 'VIDEO', url: '/files/test.mp4', processingStatus: 'READY' }];
  assert.equal(typeof h.screen.publishAdminVideoDispatch, 'function');
  await h.screen.publishAdminVideoDispatch();
  assert.equal(h.calls.length, 0);
  assert.match(h.screen.adminDispatchError, /先.*开启|开始使用/);
});
test('管理员向已开启本机发布所选视频，重复点击不重复发布', async () => {
  const pending = deferred(); const h = fixture(call => call.method === 'POST' ? pending.promise : dispatch());
  h.screen.adminSession = { token: 'synthetic-admin' };
  h.screen.adminVideos = [{ resourceId: 'V1', type: 'VIDEO', title: '安全交底', url: '/files/test.mp4', status: 'ACTIVE', processingStatus: 'READY', durationMs: 120000 }];
  h.screen.adminDispatchTitle = '现场安全交底'; h.screen.adminDispatchHours = 24;
  assert.equal(typeof h.screen.publishAdminVideoDispatch, 'function');
  const first = h.screen.publishAdminVideoDispatch(); await h.screen.publishAdminVideoDispatch();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].body, { deviceId: 'D1', resourceId: 'V1', title: '现场安全交底', validHours: 24 });
  assert.equal(h.calls[0].headers.Authorization, 'Bearer synthetic-admin');
  pending.resolve(dispatch()); await first;
  assert.equal(h.screen.adminDispatchBusy, false);
  assert.match(h.screen.adminDispatchNotice, /已发布/);
});
test('管理员不能分发无可信时长或非READY的视频', async () => {
  const h = fixture(); h.screen.adminSession = { token: 'synthetic-admin' };
  for (const video of [{ processingStatus: 'SUCCESS', durationMs: 60000 }, { processingStatus: 'READY', durationSec: 60 }]) {
    h.screen.adminVideos = [{ resourceId: 'V1', type: 'VIDEO', title: '安全交底', status: 'ACTIVE', url: '/files/test.mp4', ...video }];
    await h.screen.publishAdminVideoDispatch();
    assert.equal(h.calls.length, 0);
    assert.match(h.screen.adminDispatchError, /可用视频|可信时长|处理完成/);
  }
});
test('真实Vue响应式代理下轮询释放busy、管理员发布能确认成功', async () => {
  const h = fixture();
  const screen = reactive(h.screen);
  for (const [name, method] of Object.entries(h.options.methods)) screen[name] = method.bind(screen);
  await screen.openDispatchLearning();
  assert.equal(screen.dispatchBusy, false);
  assert.equal(screen.dispatchRequest, null);
  screen.adminSession = { token: 'synthetic-admin' };
  screen.adminVideos = [{ resourceId: 'V1', type: 'VIDEO', title: '安全交底', url: '/files/test.mp4', status: 'ACTIVE', processingStatus: 'READY', durationMs: 120000 }];
  await screen.publishAdminVideoDispatch();
  assert.match(screen.adminDispatchNotice, /已发布/);
  assert.equal(screen.adminDispatchBusy, false);
});
test('退出项目管理员清除其分发输入，迟到发布结果不得重新提示成功', async () => {
  const response = deferred(); const h = fixture(() => response.promise);
  h.screen.adminSession = { token: 'synthetic-admin' };
  h.screen.adminVideos = [{ resourceId: 'V1', type: 'VIDEO', title: '安全交底', url: '/files/test.mp4', status: 'ACTIVE', processingStatus: 'READY', durationMs: 120000 }];
  h.screen.adminDispatchTitle = '旧管理员输入'; h.screen.adminDispatchHours = 12;
  const request = h.screen.publishAdminVideoDispatch(); h.screen.logoutProjectAdmin();
  response.resolve(dispatch()); await request;
  assert.equal(h.screen.adminDispatchNotice, ''); assert.equal(h.screen.adminDispatchTitle, '');
  assert.equal(h.screen.adminDispatchHours, 24); assert.equal(h.screen.adminDispatchBusy, false);
});
for (const overlay of ['assistant', 'admin-video', 'admin-login']) {
  test(`关闭${overlay}返回现场扫码页时恢复当前二维码、轮询与到期计时`, async () => {
    const h = fixture();
    h.screen.checkAssistantStatus = async () => {};
    h.screen.adminSession = overlay === 'admin-login' ? null : { token: 'synthetic-admin' };
    h.screen.adminVideosLoaded = true;
    await h.screen.openDispatchLearning();
    if (overlay === 'assistant') await h.screen.openAssistant();
    else h.screen.openAdminVideoCenter();
    assert.equal(h.screen.videoDispatch, null);
    assert.equal(h.screen.dispatchTimer, null);
    assert.equal(h.screen.dispatchExpiryTimer, null);
    if (overlay === 'assistant') await h.screen.closeAssistant();
    else if (overlay === 'admin-login') await h.screen.closeAdminLogin();
    else await h.screen.closeAdminVideoCenter();
    assert.equal(h.screen.videoDispatch?.dispatchId, 'DSP-TEST');
    assert.ok(h.screen.dispatchTimer);
    assert.ok(h.screen.dispatchExpiryTimer);
    assert.equal(h.calls.length, 2, 'initial read plus exactly one recovery read');
    assert.ok(h.calls.every(call => call.url.endsWith('/video-dispatch') && call.method === 'GET'));
  });
}
test('弹层之间切换不启动后台分发请求，旧弹层前的迟到读取不能覆盖返回后的新码', async () => {
  const old = deferred(); let reads = 0;
  const h = fixture(() => ++reads === 2 ? old.promise : dispatch({ title: reads > 2 ? '返回后的当前场次' : '初始场次' }));
  h.screen.checkAssistantStatus = async () => {};
  h.screen.adminSession = { token: 'synthetic-admin' }; h.screen.adminVideosLoaded = true;
  await h.screen.openDispatchLearning(); const pendingRead = h.screen.pollVideoDispatch();
  await h.screen.openAssistant(); h.screen.openAdminVideoCenter();
  assert.equal(reads, 2, 'switching overlays must not fetch behind another overlay');
  await h.screen.closeAdminVideoCenter();
  assert.equal(h.screen.videoDispatch?.title, '返回后的当前场次');
  old.resolve(dispatch({ title: '旧请求不应恢复' })); await pendingRead;
  assert.equal(h.screen.videoDispatch?.title, '返回后的当前场次');
});
function timeoutClock() {
  const active = new Map(); let sequence = 0;
  return { active,
    setTimeout(callback, delay) { const id = ++sequence; active.set(id, { callback, delay }); return id; },
    clearTimeout(id) { active.delete(id); },
  };
}
test('当前分发一直不返回时在15至20秒内中止并释放忙碌状态，下一次轮询可恢复', async () => {
  const clock = timeoutClock(); let requests = 0;
  const h = fixture(() => ++requests === 1 ? new Promise(() => {}) : dispatch(), clock);
  const opening = h.screen.openDispatchLearning();
  assert.ok(h.calls[0].signal, 'the current-dispatch request must expose a cancellation signal');
  const timeout = [...clock.active.values()].find(timer => timer.delay >= 15000 && timer.delay <= 20000);
  assert.ok(timeout, 'a bounded deadline must exist even when fetch ignores abort');
  timeout.callback(); await opening;
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.screen.dispatchBusy, false); assert.equal(h.screen.dispatchRequest, null);
  assert.match(h.screen.dispatchError, /超时.*重试/); assert.equal(clock.active.size, 0);
  await h.screen.pollVideoDispatch();
  assert.equal(requests, 2); assert.equal(h.screen.videoDispatch?.dispatchId, 'DSP-TEST');
  assert.equal(h.screen.dispatchBusy, false); assert.equal(clock.active.size, 0);
  await h.api.screenConfig('D1', 'synthetic-runtime-token');
  assert.equal(h.calls.at(-1).signal, undefined, 'legacy device reads must retain their existing behavior');
});
test('打开弹层中止未返回读取；旧超时及迟到响应不能释放或覆盖新读取', async () => {
  const clock = timeoutClock(), old = deferred(), fresh = deferred(); let requests = 0;
  const h = fixture(() => ++requests === 1 ? old.promise : fresh.promise, clock);
  h.screen.checkAssistantStatus = async () => {};
  const opening = h.screen.openDispatchLearning();
  const oldTimeout = [...clock.active.values()].find(timer => timer.delay >= 15000);
  assert.ok(oldTimeout, 'the pending read must have a deadline');
  await h.screen.openAssistant(); await opening;
  assert.equal(h.calls[0].signal.aborted, true); assert.equal(clock.active.size, 0);
  const returning = h.screen.closeAssistant(); const newRequestId = h.screen.dispatchRequest;
  assert.ok(h.screen.dispatchBusy); oldTimeout.callback(); old.resolve(dispatch({ title: '迟到旧场次' }));
  await new Promise(setImmediate);
  assert.equal(h.screen.dispatchRequest, newRequestId); assert.equal(h.screen.dispatchBusy, true);
  assert.equal(h.calls[1].signal.aborted, false);
  fresh.resolve(dispatch({ title: '新的当前场次' })); await returning;
  assert.equal(h.screen.videoDispatch?.title, '新的当前场次');
  assert.equal(h.screen.dispatchBusy, false); assert.equal(clock.active.size, 0);
});
test('页面卸载中止当前分发读取并清除超时及轮询', async () => {
  const clock = timeoutClock(); const h = fixture(() => new Promise(() => {}), clock);
  const opening = h.screen.openDispatchLearning();
  assert.ok(h.calls[0].signal, 'unmount requires an abortable current read');
  h.options.beforeUnmount.call(h.screen); await opening;
  assert.equal(h.calls[0].signal.aborted, true); assert.equal(clock.active.size, 0);
  assert.equal(h.screen.dispatchBusy, false); assert.equal(h.screen.dispatchRequest, null);
  assert.equal(h.screen.dispatchTimer, null); assert.equal(h.screen.dispatchExpiryTimer, null);
});
test('超时后的旧401响应不能使恢复后的设备授权失效', async () => {
  const clock = timeoutClock(), old = deferred(); let requests = 0, rejected = 0;
  const h = fixture(() => ++requests === 1 ? old.promise : dispatch(), clock);
  h.api.onAccessRejected = () => { rejected++; };
  const opening = h.screen.openDispatchLearning();
  const timeout = [...clock.active.values()].find(timer => timer.delay >= 15000);
  assert.ok(timeout, 'the read requires a timeout'); timeout.callback(); await opening;
  await h.screen.pollVideoDispatch();
  old.resolve({ rawResponse: { ok: false, status: 401, json: async () => ({ success: false, code: 'ERR_SCREEN_ACCESS_INVALID' }) } });
  await new Promise(setImmediate);
  assert.equal(rejected, 0); assert.equal(h.screen.videoDispatch?.dispatchId, 'DSP-TEST');
});
