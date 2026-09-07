const assert = require("node:assert/strict");
const test = require("node:test");
const { loadScreen, deferred } = require("./helpers/screen-harness.cjs");
const answer = text => ({ rawResponse: { ok: true, headers: { get: () => "application/json" }, json: async () => ({ choices: [{ delta: { content: text } }] }) } });

test("新识别问题取消旧SSE请求并提交，不因busy被丢弃", async () => {
  const old = deferred();
  const { screen, calls } = loadScreen(({ body }) => body.messages.at(-1).content === "旧问题" ? old.promise : answer("新回答"));
  screen.deviceId = "D1"; screen.deviceToken = "device-token";
  screen.assistantInput = "旧问题";
  const first = screen.sendAssistantQuestion();
  screen.assistantInput = "新问题";
  await screen.sendAssistantQuestion();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[1].headers["X-Screen-Device-ID"], "D1");
  assert.equal(calls[1].headers["X-Screen-Device-Token"], "device-token");
  old.resolve(answer("迟到旧回答")); await first;
  assert.equal(screen.assistantLiveAnswer, "新回答");
  assert.equal(screen.assistantBusy, false);
});

test("关闭问答取消请求及文字播报，迟到回复不再播放", async () => {
  const pending = deferred(); let stopped = 0;
  const { screen, calls } = loadScreen(() => pending.promise);
  screen.assistantVoice = { isListening: () => false, stopListening: () => { stopped++; } };
  screen.assistantInput = "问题";
  const request = screen.sendAssistantQuestion();
  screen.closeAssistant();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(stopped, 1);
  pending.resolve(answer("迟到回答")); await request;
  assert.equal(screen.assistantBusy, false);
  assert.equal(screen.assistantLiveAnswer, "");
});

test("文字问题等待语音认证再发送文本且无需开始聆听", async () => {
  const ready = deferred(); let begin = 0;
  const { screen, calls } = loadScreen(() => answer("回答"));
  screen.assistantSpeechEnabled = true;
  screen.assistantVoice = { preparePlayback() {}, beginSpeech: () => { begin++; return ready.promise; }, pushText() {}, endSpeech() {}, cancelSpeech() {} };
  screen.assistantInput = "文字问题";
  const request = screen.sendAssistantQuestion();
  assert.equal(begin, 1);
  assert.equal(calls.length, 0);
  ready.resolve(true); await request;
  assert.equal(calls.length, 1);
  assert.equal(screen.assistantLiveAnswer, "回答");
});

test("语音客户端配置带设备身份并可通知页面中断旧回答", () => {
  let options;
  const { screen } = loadScreen(undefined, { createVoice: value => { options = value; return { isAvailable: () => true }; } });
  screen.deviceId = "D1"; screen.deviceToken = "device-token";
  screen.setupAssistantVoice();
  assert.equal(options.deviceId, "D1");
  assert.equal(options.deviceToken, "device-token");
  screen.assistantBusy = true;
  options.onInterrupt();
  assert.equal(screen.assistantBusy, false);
});
