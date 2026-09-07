const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function loadScreen(handleRequest) {
  let options;
  const calls = [];
  const sandbox = {
    URL, URLSearchParams,
    location: { search: "", origin: "http://test.invalid" },
    localStorage: { getItem() { return null; }, setItem() {} },
    setInterval() { return 1; }, clearInterval() {},
    window: {},
    Vue: { createApp(value) { options = value; return { mount() {} }; } },
    async fetch(url, init) {
      const call = { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const data = await handleRequest(call);
      return { ok: true, status: 200, json: async () => ({ success: true, data }) };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/api.js"), "utf8"), sandbox);
  sandbox.FenghaoApi = sandbox.window.FenghaoApi;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/screen.js"), "utf8"), sandbox);
  const screen = Object.assign(options.data(), options.methods, { $refs: {}, $nextTick(fn) { fn(); } });
  for (const [name, getter] of Object.entries(options.computed)) {
    Object.defineProperty(screen, name, { get: () => getter.call(screen) });
  }
  screen.session = { sessionId: "S1", status: "playing" };
  screen.stage = "playing";
  screen.videos = [
    { videoId: "V1", durationSec: 60, progress: 0, status: "pending" },
    { videoId: "V2", durationSec: 90, progress: 0, status: "pending" },
  ];
  return { screen, calls };
}

const complete = (overrides = {}) => ({ sessionId: "S1", status: "learning_completed", allCompleted: true, examUnlocked: true, ...overrides });
const progress = (overrides = {}) => ({ sessionId: "S1", videoId: "V1", progress: 100, status: "finished", videoCompleted: true, allCompleted: false, examUnlocked: false, ...overrides });

test("完成请求失败保留播放页和错误，不宣称考试已解锁", async () => {
  const { screen } = loadScreen(async () => { throw new Error("还有必学视频未完成"); });
  await screen.finishAll();
  assert.equal(screen.stage, "playing");
  assert.equal(screen.error, "还有必学视频未完成");
  assert.doesNotMatch(screen.message, /已解锁/);
  assert.equal(screen.busy, false);
});

for (const examUnlocked of [false, undefined]) {
  test(`完成响应 examUnlocked=${examUnlocked} 不展示答题完成页`, async () => {
    const { screen } = loadScreen(async () => complete({ examUnlocked }));
    await screen.finishAll();
    assert.equal(screen.stage, "playing");
    assert.match(screen.error, /尚未解锁/);
    assert.doesNotMatch(screen.message, /已解锁/);
  });
}

test("完成响应未确认全部完成时仍可重试", async () => {
  const { screen } = loadScreen(async () => complete({ allCompleted: false }));
  await screen.finishAll();
  assert.equal(screen.stage, "playing");
  assert.match(screen.error, /尚未确认/);
});

test("上报失败不跳段，重试成功正常推进并清除旧错误", async () => {
  let failed = true;
  const { screen, calls } = loadScreen(async () => {
    if (failed) throw new Error("进度保存失败");
    return progress();
  });
  await screen.finishCurrentVideo();
  assert.equal(screen.currentIndex, 0);
  assert.equal(screen.videos[0].progress, 0);
  assert.equal(screen.error, "进度保存失败");
  assert.equal(screen.busy, false);
  failed = false;
  await screen.finishCurrentVideo();
  assert.equal(screen.currentIndex, 1);
  assert.equal(screen.videos[0].progress, 100);
  assert.equal(screen.error, "");
  assert.equal(calls[1].body.videoId, "V1");
});

test("最终视频进度及考试解锁均确认后进入完成页", async () => {
  const { screen, calls } = loadScreen(async ({ url }) => url.endsWith("/complete") ? complete() : progress({ allCompleted: true }));
  await screen.finishCurrentVideo();
  assert.equal(screen.stage, "completed");
  assert.match(screen.message, /已解锁/);
  assert.equal(screen.session.status, "learning_completed");
  assert.equal(screen.currentIndex, 0);
  assert.equal(screen.busy, false);
  assert.equal(calls[1].url, "/api/v1/screen-sessions/S1/complete");
});

test("上报成功但服务端未确认本段完成时不跳段", async () => {
  const { screen } = loadScreen(async () => progress({ progress: 50, status: "playing", videoCompleted: false }));
  await screen.finishCurrentVideo();
  assert.equal(screen.currentIndex, 0);
  assert.equal(screen.videos[0].progress, 50);
  assert.match(screen.error, /尚未确认/);
});

test("切换视频后旧进度只更新原视频且不自动移动当前选择", async () => {
  const response = deferred();
  const { screen, calls } = loadScreen(() => response.promise);
  const pending = screen.finishCurrentVideo();
  screen.currentIndex = 1;
  response.resolve(progress());
  await pending;
  assert.equal(calls[0].body.videoId, "V1");
  assert.equal(screen.videos[0].progress, 100);
  assert.equal(screen.videos[1].progress, 0);
  assert.equal(screen.currentIndex, 1);
});

test("其他视频的进度响应不得写入当前视频", async () => {
  const { screen } = loadScreen(async () => progress({ videoId: "V2" }));
  await screen.finishCurrentVideo();
  assert.equal(screen.videos[0].progress, 0);
  assert.equal(screen.currentIndex, 0);
  assert.match(screen.error, /不匹配/);
});

for (const failure of [false, true]) {
  test(`换会话后旧进度${failure ? "失败" : "完成"}响应不污染新会话`, async () => {
    const response = deferred();
    const { screen, calls } = loadScreen(() => response.promise);
    const pending = screen.finishCurrentVideo();
    screen.session = { sessionId: "S2", status: "playing" };
    screen.videos = [{ videoId: "V1", progress: 0 }];
    screen.error = "新会话提示";
    screen.busy = true;
    if (failure) response.reject(new Error("旧会话失败"));
    else response.resolve(progress({ allCompleted: true }));
    await pending;
    assert.equal(screen.videos[0].progress, 0);
    assert.equal(screen.stage, "playing");
    assert.equal(screen.error, "新会话提示");
    assert.equal(screen.busy, true);
    assert.equal(calls.length, 1);
  });
}

test("清空开始后旧完成响应不得覆盖当前会话或解锁提示", async () => {
  const completion = deferred(), clearing = deferred();
  const { screen } = loadScreen(({ url }) => url.endsWith("/complete") ? completion.promise : clearing.promise);
  const pending = screen.finishAll();
  const reset = screen.clearAndRestart();
  completion.resolve(complete());
  await pending;
  assert.equal(screen.stage, "playing");
  assert.doesNotMatch(screen.message, /已解锁/);
  assert.equal(screen.busy, true);
  clearing.reject(new Error("设备清空失败"));
  await reset;
  assert.equal(screen.error, "设备清空失败");
  assert.equal(screen.busy, false);
});

test("换会话后旧完成结果不改变新会话", async () => {
  const response = deferred();
  const { screen } = loadScreen(() => response.promise);
  const pending = screen.finishAll();
  screen.session = { sessionId: "S2", status: "waiting_scan" };
  screen.stage = "waiting";
  response.resolve(complete());
  await pending;
  assert.equal(screen.stage, "waiting");
  assert.equal(screen.session.sessionId, "S2");
  assert.doesNotMatch(screen.message, /已解锁/);
});

test("旧轮询的完成状态不得回写已更换会话", async () => {
  const response = deferred();
  const { screen, calls } = loadScreen(() => response.promise);
  screen.stage = "waiting";
  const pending = screen.pollSession();
  screen.session = { sessionId: "S2", status: "waiting_scan" };
  response.resolve({ sessionId: "S1", status: "learning_completed", videos: [] });
  await pending;
  assert.equal(screen.stage, "waiting");
  assert.equal(screen.session.sessionId, "S2");
  assert.equal(calls.length, 1);
});

test("当前轮询完成状态还需确认考试是否解锁", async () => {
  const { screen, calls } = loadScreen(async ({ url }) => url.endsWith("/complete")
    ? complete({ examUnlocked: false })
    : { sessionId: "S1", status: "learning_completed", videos: [{ videoId: "V1", progress: 100 }] });
  screen.stage = "waiting";
  await screen.pollSession();
  assert.equal(screen.stage, "playing");
  assert.match(screen.error, /尚未解锁/);
  assert.equal(calls[1].url, "/api/v1/screen-sessions/S1/complete");
});

test("最后进度已保存但完成确认失败时留在当前段并可重试", async () => {
  let failed = true;
  const { screen } = loadScreen(async ({ url }) => {
    if (!url.endsWith("/complete")) return progress({ allCompleted: true });
    if (failed) throw new Error("完成确认暂不可用");
    return complete();
  });
  await screen.finishCurrentVideo();
  assert.equal(screen.stage, "playing");
  assert.equal(screen.currentIndex, 0);
  assert.equal(screen.videos[0].progress, 100);
  assert.equal(screen.error, "完成确认暂不可用");
  assert.equal(screen.busy, false);
  failed = false;
  await screen.finishCurrentVideo();
  assert.equal(screen.stage, "completed");
  assert.equal(screen.error, "");
});

test("正常部分进度保存不触发跳段或完成请求", async () => {
  const { screen, calls } = loadScreen(async () => progress({ progress: 50, status: "playing", videoCompleted: false }));
  await screen.reportProgress(50);
  assert.equal(screen.videos[0].progress, 50);
  assert.equal(screen.currentIndex, 0);
  assert.equal(screen.stage, "playing");
  assert.equal(screen.error, "");
  assert.equal(calls.length, 1);
});

test("清空成功后新会话创建失败仍展示可重试错误", async () => {
  const { screen } = loadScreen(async ({ url }) => {
    if (url.endsWith("/clear")) return { sessionId: "S1", deviceId: "D1", status: "cleared" };
    throw new Error("二维码创建失败");
  });
  await screen.clearAndRestart();
  assert.equal(screen.error, "二维码创建失败");
  assert.equal(screen.busy, false);
});

test("重新生成二维码失败不得丢弃旧会话或失败提示", async () => {
  const { screen, calls } = loadScreen(async () => { throw new Error("清空失败"); });
  await screen.resetSession();
  assert.equal(screen.session.sessionId, "S1");
  assert.equal(screen.error, "清空失败");
  assert.equal(calls.length, 1);
});

test("清空并创建新会话后旧完成响应不恢复旧会话", async () => {
  const response = deferred();
  const { screen } = loadScreen(async ({ url }) => {
    if (url.endsWith("/complete")) return response.promise;
    if (url.endsWith("/clear")) return { sessionId: "S1", status: "cleared" };
    return { sessionId: "S2", status: "waiting_scan", deviceId: "D1" };
  });
  const pending = screen.finishAll();
  await screen.resetSession();
  response.resolve(complete());
  await pending;
  assert.equal(screen.session.sessionId, "S2");
  assert.equal(screen.stage, "waiting");
  assert.equal(screen.videos.length, 0);
  assert.equal(screen.error, "");
  assert.equal(screen.busy, false);
});

test("完成确认期间的旧轮询不将已完成状态退回签到", async () => {
  const response = deferred();
  const { screen } = loadScreen(async ({ url }) => url.endsWith("/complete") ? complete() : response.promise);
  screen.stage = "identified";
  const pending = screen.pollSession();
  await screen.finishAll();
  response.resolve({ sessionId: "S1", status: "checked_in", videos: [] });
  await pending;
  assert.equal(screen.stage, "completed");
  assert.equal(screen.session.status, "learning_completed");
});

test("清空期间旧签到响应不得恢复学习列表或解除忙碌状态", async () => {
  const checking = deferred(), clearing = deferred();
  const { screen } = loadScreen(({ url }) => url.endsWith("/checkin") ? checking.promise : clearing.promise);
  screen.stage = "identified";
  const pending = screen.startLearning();
  const reset = screen.clearAndRestart();
  checking.resolve({ sessionId: "S1", status: "checked_in", videos: [] });
  await pending;
  assert.equal(screen.stage, "identified");
  assert.equal(screen.videos.length, 2);
  assert.equal(screen.busy, true);
  clearing.reject(new Error("清空失败"));
  await reset;
});
