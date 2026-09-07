const assert = require("node:assert/strict");
const test = require("node:test");
const { loadScreen } = require("./helpers/screen-harness.cjs");

test("未配置设备令牌不使用演示凭据或请求学习后端", async () => {
  const { screen, calls } = loadScreen();
  await screen.init();
  assert.equal(screen.deviceToken, "");
  assert.match(screen.error, /配置设备/);
  assert.equal(calls.length, 0);
});

test("设备令牌按设备保存且从地址栏移除", () => {
  const { screen, storage, historyCalls } = loadScreen(undefined, { search: "?deviceId=D2&deviceToken=synthetic-device-token&mode=screen" });
  assert.equal(screen.deviceId, "D2");
  assert.equal(storage.get("fenghao-screen-device-token:D2"), "synthetic-device-token");
  assert.equal(storage.has("fenghao-screen-device-token"), false);
  assert.equal(historyCalls[0], "/screen.html?deviceId=D2&mode=screen");
});

test("切换设备不得沿用其他设备或旧公共键的令牌", () => {
  const { screen } = loadScreen(undefined, { search: "?deviceId=D2", storage: [["fenghao-screen-device-token:D1", "old-token"], ["fenghao-screen-device-token", "legacy-token"]] });
  assert.equal(screen.deviceToken, "");
});

test("设备轮询在学习完成后持续同步心跳、音量和禁止自动播放", async () => {
  const { screen, calls, intervals } = loadScreen(async ({ url }) => url.endsWith("/config") ? { deviceId: "D1", playback: { volume: 35, autoPlay: false } } : []);
  screen.deviceId = "D1"; screen.deviceToken = "device-token"; screen.stage = "completed";
  screen.$refs.learningVideo = { volume: 1, autoplay: true };
  screen.startDevicePolling();
  await screen.pollDeviceCommands();
  assert.equal(screen.$refs.learningVideo.volume, 0.35);
  assert.equal(screen.$refs.learningVideo.autoplay, false);
  assert.ok([...intervals.values()].some(({ delay }) => delay <= 30000));
  assert.ok(calls.some(({ url }) => url.endsWith("/commands")));
  assert.ok(calls.every(({ headers }) => headers["X-Screen-Device-Token"] === "device-token"));
});

test("重启明确失败，重连读取当前配置会话后才确认成功", async () => {
  const { screen, calls } = loadScreen(async ({ url }) => {
    if (url.endsWith("/config")) return { deviceId: "D1", playback: {} };
    if (url.endsWith("/commands")) return [{ id: "C1", action: "RESTART" }, { id: "C2", action: "RECONNECT" }];
    if (url.endsWith("/S1")) return { sessionId: "S1", status: "waiting_scan" };
    return {};
  });
  screen.deviceId = "D1"; screen.deviceToken = "device-token"; screen.session = { sessionId: "S1" }; screen.stage = "waiting";
  await screen.pollDeviceCommands();
  const acks = calls.filter(({ url }) => url.endsWith("/ack"));
  assert.equal(acks[0].body.status, "FAILED");
  assert.match(acks[0].body.detail, /不支持.*重启/);
  assert.equal(acks[1].body.status, "SUCCESS");
  assert.ok(calls.findIndex(({ url }) => url.endsWith("/S1")) < calls.indexOf(acks[1]));
});

test("助手请求携带设备认证且配置状态不宣称云端已连接", async () => {
  const { screen, calls } = loadScreen(async () => ({ rawResponse: { ok: true, json: async () => ({ configured: true, speech: false }) } }));
  screen.deviceId = "D1"; screen.deviceToken = "device-token";
  await screen.checkAssistantStatus();
  assert.equal(calls[0].headers["X-Screen-Device-ID"], "D1");
  assert.equal(calls[0].headers["X-Screen-Device-Token"], "device-token");
  assert.match(screen.assistantConnection, /已配置/);
  assert.doesNotMatch(screen.assistantConnection, /已连接/);
});

test("初始密码账号得到管理端改密指引而不访问资源", async () => {
  const { screen, calls } = loadScreen(async () => ({ token: "initial-token", role: "PROJECT_ADMIN", passwordChangeRequired: true }));
  screen.adminLoginForm = { username: "new-admin", password: "synthetic-password" };
  await screen.submitAdminLogin();
  assert.equal(screen.adminSession, null);
  assert.equal(screen.adminVideoOpen, false);
  assert.match(screen.adminLoginError, /管理后台.*修改.*密码/);
  assert.equal(screen.adminLoginForm.password, "");
  assert.equal(calls.length, 1);
});

test("后台清空设备会话后独立轮询停止旧视频并重新进入扫码", async () => {
  let paused = false;
  const { screen } = loadScreen(async ({ url }) => {
    if (url.endsWith("/config")) return { deviceId: "D1", currentSessionId: null, playback: {} };
    if (url.endsWith("/commands")) return [];
    return { sessionId: "S2", status: "waiting_scan" };
  });
  screen.deviceId = "D1"; screen.deviceToken = "device-token";
  screen.session = { sessionId: "S1" }; screen.stage = "playing";
  screen.$refs.learningVideo = { pause() { paused = true; } };
  await screen.pollDeviceCommands();
  assert.equal(paused, true);
  assert.equal(screen.session.sessionId, "S2");
  assert.equal(screen.stage, "waiting");
});

test("问答设备认证失败指向配对，不冒充服务端缺少语音配置", async () => {
  const { screen } = loadScreen(async () => ({ rawResponse: { ok: false, status: 401 } }), { createVoice: () => ({ isAvailable: () => true }) });
  screen.deviceId = "D1"; screen.deviceToken = "expired-token";
  await screen.checkAssistantStatus();
  assert.match(screen.assistantConnection, /设备配对/);
  assert.match(screen.assistantVoiceHint, /设备配对/);
  assert.doesNotMatch(screen.assistantVoiceHint, /缺少.*配置/);
  assert.equal(screen.assistantSpeechEnabled, false);
});

test("尚无设备身份时网络失败仍先指向配对", async () => {
  const { screen } = loadScreen(async () => { throw new Error("network unavailable"); }, { createVoice: () => ({ isAvailable: () => true }) });
  await screen.checkAssistantStatus();
  assert.match(screen.assistantVoiceHint, /设备配对/);
});

test("已配对状态查询暂不可用不猜测语音配置缺失", async () => {
  const { screen } = loadScreen(async () => ({ rawResponse: { ok: false, status: 503 } }), { createVoice: () => ({ isAvailable: () => true }) });
  screen.deviceId = "D1"; screen.deviceToken = "synthetic-token";
  await screen.checkAssistantStatus();
  assert.match(screen.assistantVoiceHint, /暂无法确认.*稍后重试/);
  assert.doesNotMatch(screen.assistantVoiceHint, /缺少.*配置|设备配对/);
});

test("认证成功且服务端明确speech=false时保留未配置提示", async () => {
  const { screen } = loadScreen(async () => ({ rawResponse: { ok: true, json: async () => ({ configured: true, speech: false }) } }), { createVoice: () => ({ isAvailable: () => true }) });
  screen.deviceId = "D1"; screen.deviceToken = "synthetic-token";
  await screen.checkAssistantStatus();
  assert.equal(screen.assistantVoiceHint, "语音未启用：服务端缺少语音识别与合成配置");
  assert.equal(screen.assistantSpeechEnabled, false);
});