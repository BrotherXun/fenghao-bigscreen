const assert = require("node:assert/strict");
const test = require("node:test");
const { loadScreen, deferred } = require("./helpers/screen-harness.cjs");

const ACCESS = "/api/v1/screen/access-sessions";
const TOKEN = "synthetic-share-token";
const hash = "#token=" + TOKEN;
const session = (id = "A1") => ({ accessSessionId: id, deviceId: "R-" + id, deviceToken: "runtime-" + id,
  expiresAt: new Date(Date.now() + 86400000).toISOString(), usedCount: 1, maxUses: 200, remainingUses: 199, projectId: "P1" });
const rejection = (status, code) => ({ rawResponse: { ok: false, status, json: async () => ({ success: false, code, message: code }) } });
function backend(call) {
  if (call.url.startsWith(ACCESS)) return session();
  if (call.url.endsWith("/config")) return { deviceId: "R-A1", currentSessionId: "S1", playback: {} };
  if (call.url.endsWith("/S1")) return { sessionId: "S1", status: "waiting_scan" };
  if (call.url.endsWith("/commands")) return [];
  if (call.url.endsWith("/status")) return { rawResponse: { ok: true, json: async () => ({ configured: true, speech: false }) } };
  throw new Error("Unexpected request " + call.url);
}
async function mount(fixture) { await fixture.options.mounted.call(fixture.screen); }

test("token链接预览不启动后端会话、问答或录音，也不使用旧设备", async () => {
  let voices = 0;
  const f = loadScreen(backend, { hash, storage: [["fenghao-screen-device-id", "LEGACY"], ["fenghao-screen-device-token:LEGACY", "legacy"]], createVoice: () => { voices++; } });
  await mount(f);
  f.screen.assistantInput = "安全问题";
  await f.screen.sendAssistantQuestion();
  await f.screen.toggleAssistantVoice();
  await f.screen.openAdminVideoCenter();
  assert.equal(f.calls.length, 0);
  assert.equal(voices, 0);
  assert.equal(f.screen.deviceToken, "");
  assert.equal(f.screen.accessState, "ready");
  assert.match(f.screen.accessMessage, /开始使用/);
  assert.equal(f.screen.adminLoginOpen, false);
  assert.equal(f.historyCalls.length, 0, "保留片段链接供微信复制到其他电脑");
});

test("显式开始仅创建一次授权并沿用当前学习会话，不自动开麦", async () => {
  const pending = deferred(); let voices = 0;
  const f = loadScreen(call => call.url === ACCESS ? pending.promise : backend(call), { hash, createVoice: () => { voices++; return { isAvailable: () => true }; } });
  await mount(f);
  const first = f.screen.startAccessSession();
  await f.screen.startAccessSession();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, "POST");
  assert.equal(f.calls[0].body.token, TOKEN);
  assert.match(f.calls[0].body.requestId, /^[\w-]{20,}$/);
  pending.resolve(session()); await first;
  assert.equal(f.screen.accessState, "active");
  assert.equal(f.screen.deviceToken, "runtime-A1");
  assert.equal(f.screen.session.sessionId, "S1");
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
  assert.equal(voices, 1);
  assert.equal(f.screen.assistantVoiceListening, false);
  assert.equal(f.storage.size, 0);
});

test("同页刷新只GET恢复，保留已签到学习状态并且不再次扣次", async () => {
  const f = loadScreen(backend, { hash }); await mount(f); await f.screen.startAccessSession();
  const refreshed = loadScreen(call => call.url.endsWith("/S1") ? { sessionId: "S1", status: "playing", videos: [{ videoId: "V1" }] } : backend(call), { sessionStorage: f.sessionStorage });
  await mount(refreshed);
  assert.equal(refreshed.calls[0].url, ACCESS + "/A1");
  assert.equal(refreshed.calls[0].headers["X-Screen-Device-Token"], "runtime-A1");
  assert.equal(refreshed.calls.filter(c => c.method === "POST").length, 0);
  assert.equal(refreshed.screen.stage, "playing");
  assert.equal(refreshed.screen.videos[0].videoId, "V1");
});

test("刷新从状态接口恢复服务端二维码地址，不重开授权或学习会话", async () => {
  const qrUrl = "https://configured-files.example.invalid/files/qr/screen-session-S1.png";
  const expireAt = new Date(Date.now() + 600000).toISOString();
  let currentSessionId = null;
  function responses(call) {
    if (call.url.endsWith("/config")) return { deviceId: "R-A1", currentSessionId, playback: {} };
    if (call.url === "/api/v1/screen-sessions" && call.method === "POST") {
      currentSessionId = "S1";
      return { sessionId: "S1", status: "waiting_scan", qrToken: "synthetic-qr", qrUrl, expireAt };
    }
    if (call.url.endsWith("/S1")) {
      return { sessionId: "S1", status: "waiting_scan", qrToken: "synthetic-qr", qrUrl, expireAt };
    }
    return backend(call);
  }
  const first = loadScreen(responses, { hash });
  await mount(first); await first.screen.startAccessSession();
  assert.equal(first.screen.session.qrUrl, qrUrl);
  const refreshed = loadScreen(responses, { hash, sessionStorage: first.sessionStorage });
  await mount(refreshed); await refreshed.screen.pollSession();
  assert.equal(refreshed.screen.session.qrUrl, qrUrl, "use the backend URL rather than guessing a file host/path");
  assert.equal(refreshed.screen.session.sessionId, "S1");
  assert.equal(refreshed.screen.session.qrToken, "synthetic-qr");
  assert.equal(refreshed.screen.session.expireAt, expireAt);
  assert.equal(refreshed.screen.accessSession.accessSessionId, first.screen.accessSession.accessSessionId);
  assert.equal(refreshed.calls.filter(call => call.method === "POST").length, 0);
});

test("创建响应丢失后刷新不得自动重试，主动重试沿用同一requestId", async () => {
  const f = loadScreen(async () => { throw new Error("connection lost after commit"); }, { hash });
  await mount(f); await f.screen.startAccessSession();
  const requestId = f.calls[0].body.requestId;
  const refreshed = loadScreen(backend, { sessionStorage: f.sessionStorage }); await mount(refreshed);
  assert.equal(refreshed.calls.length, 0);
  await refreshed.screen.startAccessSession();
  assert.equal(refreshed.calls[0].body.requestId, requestId);
  assert.equal(refreshed.screen.accessState, "active");
});

test("学习二维码410过期保留访问授权，刷新和重新生成二维码不再扣次", async () => {
  let qrExpired = false;
  function responses(call) {
    if (call.url.endsWith("/S1") && qrExpired) return rejection(410, "ERR_QR_EXPIRED");
    if (call.url.endsWith("/S1/clear")) return { sessionId: "S1", status: "cleared" };
    if (call.url === "/api/v1/screen-sessions" && call.method === "POST") {
      return { sessionId: "S2", status: "waiting_scan", qrUrl: "/files/qr/screen-session-S2.png" };
    }
    if (call.url.endsWith("/S2")) return { sessionId: "S2", status: "waiting_scan" };
    return backend(call);
  }
  const f = loadScreen(responses, { hash }); await mount(f); await f.screen.startAccessSession();
  const saved = f.sessionStorage.get("fenghao-screen-access");
  qrExpired = true; await f.screen.pollSession();
  assert.equal(f.screen.accessState, "active");
  assert.equal(f.screen.accessSession.accessSessionId, "A1");
  assert.equal(f.sessionStorage.get("fenghao-screen-access"), saved);
  assert.match(f.screen.error, /ERR_QR_EXPIRED/);
  const refreshed = loadScreen(responses, { hash, sessionStorage: f.sessionStorage }); await mount(refreshed);
  assert.equal(refreshed.screen.accessState, "active");
  assert.equal(refreshed.screen.accessSession.accessSessionId, "A1");
  await refreshed.screen.resetSession();
  assert.equal(refreshed.screen.session.sessionId, "S2");
  assert.equal(refreshed.screen.accessSession.accessSessionId, "A1");
  assert.equal(refreshed.calls.filter(call => call.url === ACCESS && call.method === "POST").length, 0);
});

for (const [status, code] of [[502, "PROXY_ERROR"], [503, "device_auth_unavailable"]]) {
  test(`${status}服务暂不可用保留访问授权，刷新后仍只重试恢复`, async () => {
    let unavailable = false;
    const responses = call => unavailable && (call.url.endsWith("/config") || call.url === ACCESS + "/A1")
      ? rejection(status, code) : backend(call);
    const f = loadScreen(responses, { hash }); await mount(f); await f.screen.startAccessSession();
    const saved = f.sessionStorage.get("fenghao-screen-access");
    unavailable = true; await f.screen.pollDeviceCommands();
    assert.equal(f.screen.accessState, "active");
    assert.equal(f.sessionStorage.get("fenghao-screen-access"), saved);
    const refreshed = loadScreen(responses, { hash, sessionStorage: f.sessionStorage }); await mount(refreshed);
    assert.equal(refreshed.screen.accessState, "error");
    assert.equal(refreshed.screen.accessSession.accessSessionId, "A1");
    assert.equal(refreshed.sessionStorage.get("fenghao-screen-access"), saved);
    unavailable = false; await refreshed.screen.startAccessSession();
    assert.equal(refreshed.screen.accessState, "active");
    assert.equal(refreshed.screen.accessSession.accessSessionId, "A1");
    assert.equal(refreshed.calls.filter(call => call.method === "POST").length, 0);
  });
}

test("不同电脑同token分别开启独立访问请求", async () => {
  const a = loadScreen(backend, { hash }), b = loadScreen(backend, { hash });
  await mount(a); await mount(b); await a.screen.startAccessSession(); await b.screen.startAccessSession();
  assert.notEqual(a.calls[0].body.requestId, b.calls[0].body.requestId);
  assert.equal(a.calls[0].body.token, b.calls[0].body.token);
});

test("耗尽时不初始化学习或问答，并显示次数用完", async () => {
  const f = loadScreen(() => rejection(409, "ERR_SCREEN_ACCESS_EXHAUSTED"), { hash });
  await mount(f); await f.screen.startAccessSession();
  assert.equal(f.calls.length, 1);
  assert.equal(f.screen.accessState, "exhausted");
  assert.match(f.screen.accessMessage, /次数.*用完/);
  assert.equal(f.screen.deviceToken, "");
});

test("恢复过期只显示重新开始，用户点击时才用新的requestId扣次", async () => {
  const f = loadScreen(backend, { hash }); await mount(f); await f.screen.startAccessSession();
  const firstId = f.calls[0].body.requestId;
  const refreshed = loadScreen(call => call.url === ACCESS + "/A1" ? rejection(410, "ERR_SCREEN_ACCESS_EXPIRED") : backend(call), { sessionStorage: f.sessionStorage });
  await mount(refreshed);
  assert.equal(refreshed.calls.length, 1);
  assert.equal(refreshed.screen.accessState, "expired");
  assert.equal(refreshed.screen.deviceToken, "");
  await refreshed.screen.startAccessSession();
  assert.notEqual(refreshed.calls.find(c => c.method === "POST").body.requestId, firstId);
  assert.equal(refreshed.screen.accessState, "active");
});

test("本地无法保存幂等记录时不发送扣次请求", async () => {
  const f = loadScreen(backend, { hash, storageBlocked: true }); await mount(f);
  await f.screen.startAccessSession();
  assert.equal(f.calls.length, 0);
  assert.match(f.screen.accessMessage, /存储/);
});

test("运行授权失效停止学习和录音，显示到期而非设备配对", async () => {
  let revoked = false, stopped = 0, paused = 0;
  const f = loadScreen(call => revoked && call.url.endsWith("/config") ? rejection(410, "ERR_SCREEN_ACCESS_EXPIRED") : backend(call), { hash });
  await mount(f); await f.screen.startAccessSession();
  f.screen.$refs.learningVideo = { pause() { paused++; } };
  f.screen.assistantVoice = { stopListening() { stopped++; }, cancelSpeech() {} };
  revoked = true; await f.screen.pollDeviceCommands();
  assert.equal(f.screen.accessState, "expired");
  assert.equal(f.screen.deviceToken, "");
  assert.ok(stopped > 0); assert.ok(paused > 0);
  assert.match(f.screen.accessMessage, /到期/);
  assert.doesNotMatch(f.screen.assistantVoiceHint, /配对/);
});

test("新token链接不会恢复另一个token的会话或沿用未确认requestId", async () => {
  const f = loadScreen(backend, { hash }); await mount(f); await f.screen.startAccessSession();
  const another = loadScreen(backend, { hash: "#token=another-synthetic-token", sessionStorage: f.sessionStorage }); await mount(another);
  assert.equal(another.calls.length, 0);
  assert.equal(another.screen.deviceToken, "");
  await another.screen.startAccessSession();
  assert.equal(another.calls[0].body.token, "another-synthetic-token");
});

test("语音并发繁忙不清除有效授权或要求重新扣次", async () => {
  let voiceHandlers;
  const f = loadScreen(backend, { hash, createVoice: handlers => { voiceHandlers = handlers; return { isAvailable: () => true, stopListening() {} }; } });
  await mount(f); await f.screen.startAccessSession();
  voiceHandlers.onError("auth", "请求繁忙", { code: "assistant_busy" });
  assert.equal(f.screen.accessState, "active");
  assert.equal(f.screen.accessSession.accessSessionId, "A1");
});

test("授权到期关闭管理员层，迟到登录不能重新打开或继续加载资料", async () => {
  const login = deferred();
  const f = loadScreen(call => call.url.endsWith("/admin/auth/login") ? login.promise : backend(call), { hash });
  await mount(f); await f.screen.startAccessSession();
  f.screen.adminLoginOpen = true;
  f.screen.adminLoginForm = { username: "synthetic-admin", password: "synthetic-password" };
  const pending = f.screen.submitAdminLogin();
  f.screen.handleAccessError({ code: "ERR_SCREEN_ACCESS_EXPIRED", status: 410 });
  assert.equal(f.screen.adminLoginOpen, false);
  login.resolve({ token: "synthetic-admin-token", role: "PROJECT_ADMIN" }); await pending;
  assert.equal(f.screen.adminVideoOpen, false);
  assert.equal(f.screen.adminSession, null);
  assert.equal(f.calls.filter(c => c.url.includes("training-resources")).length, 0);
});

test("授权到期后迟到设备配置不能恢复旧学习或继续命令请求", async () => {
  const config = deferred(); let late = false;
  const f = loadScreen(call => late && call.url.endsWith("/config") ? config.promise : backend(call), { hash });
  await mount(f); await f.screen.startAccessSession();
  late = true;
  const pending = f.screen.pollDeviceCommands();
  const count = f.calls.length;
  f.screen.handleAccessError({ code: "ERR_SCREEN_ACCESS_EXPIRED", status: 410 });
  config.resolve({ deviceId: "R-A1", currentSessionId: "S1", playback: {} }); await pending;
  assert.equal(f.calls.length, count);
  assert.equal(f.screen.device.deviceId, undefined);
  assert.equal(f.screen.session.sessionId, undefined);
});
