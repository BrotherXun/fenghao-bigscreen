const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

function voiceHarness() {
  const sockets = [], timers = new Map(), errors = [], states = [];
  let micCalls = 0;
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    open() { this.readyState = 1; this.onopen(); }
    message(value) { this.onmessage({ data: JSON.stringify(value) }); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  class AudioContext {
    constructor() { this.state = "running"; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    close() {} resume() {}
  }
  class Worklet { constructor() { this.port = { postMessage() {} }; } connect() {} disconnect() {} }
  const sandbox = {
    WebSocket: Socket, AudioWorkletNode: Worklet,
    location: { protocol: "https:", host: "screen.test" },
    navigator: { mediaDevices: { getUserMedia: async () => { micCalls++; return { getTracks: () => [{ stop() {} }] }; } } },
    window: { AudioContext, AudioWorklet: function () {} },
    setTimeout(fn, delay) { const id = timers.size + 1; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/screen-voice.js"), "utf8"), sandbox);
  const voice = sandbox.window.createVoice({ deviceId: "D1", deviceToken: "synthetic-token", onError: (...args) => errors.push(args), onStateChange: state => states.push(state), onFinalTranscript() {}, onPartialTranscript() {} });
  return { voice, sockets, timers, errors, states, micCalls: () => micCalls };
}

test("WS首条只发设备认证，等待认证通过才开麦与ASR", async () => {
  const h = voiceHarness();
  const pending = h.voice.startListening();
  const ws = h.sockets[0]; ws.open();
  await Promise.resolve();
  assert.equal(h.micCalls(), 0);
  assert.deepEqual(ws.sent, [{ type: "authenticate", deviceId: "D1", deviceToken: "synthetic-token" }]);
  assert.equal(ws.url, "wss://screen.test/ws/voice");
  ws.message({ type: "authenticated" });
  assert.equal(await pending, true);
  assert.equal(h.micCalls(), 1);
  assert.equal(ws.sent[1].type, "asr_start");
});

test("并行连接等待共享认证结果，不提前视为已连接", async () => {
  const h = voiceHarness();
  const one = h.voice.connect(), two = h.voice.connect();
  let resolved = false; two.then(() => { resolved = true; });
  h.sockets[0].open();
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(h.sockets.length, 1);
  h.sockets[0].message({ type: "authenticated" });
  assert.equal(await one, true); assert.equal(await two, true);
});

test("文字播报可单独连接和认证且不申请麦克风", async () => {
  const h = voiceHarness();
  const pending = h.voice.beginSpeech(1.3);
  assert.equal(h.sockets.length, 1);
  const ws = h.sockets[0]; ws.open();
  assert.equal(ws.sent.length, 1);
  ws.message({ type: "authenticated" });
  assert.equal(await pending, true);
  assert.equal(h.micCalls(), 0);
  assert.equal(ws.sent[1].type, "tts_start");
  assert.equal(ws.sent[1].speedRatio, 1.3);
});

test("认证等待有超时并停止语音启动", async () => {
  const h = voiceHarness();
  const pending = h.voice.startListening();
  h.sockets[0].open();
  const timeout = [...h.timers.values()].find(({ delay }) => delay === 8000);
  assert.ok(timeout); timeout.fn();
  assert.equal(await pending, false);
  assert.equal(h.micCalls(), 0);
});

test("ASR连续错误按退避重试三次后停麦", async () => {
  const h = voiceHarness();
  const pending = h.voice.startListening();
  const ws = h.sockets[0]; ws.open(); ws.message({ type: "authenticated" }); await pending;
  for (const delay of [1000, 2000, 4000]) {
    const before = ws.sent.filter(x => x.type === "asr_start").length;
    ws.message({ type: "error", scope: "asr", message: "暂不可用" });
    assert.equal(ws.sent.filter(x => x.type === "asr_start").length, before);
    const entry = [...h.timers.entries()].find(([, value]) => value.delay === delay);
    assert.ok(entry); h.timers.delete(entry[0]); entry[1].fn();
  }
  ws.message({ type: "error", scope: "asr", message: "暂不可用" });
  assert.equal(h.voice.isListening(), false);
});

test("明确不可重试的识别错误立即停麦", async () => {
  const h = voiceHarness();
  const pending = h.voice.startListening();
  const ws = h.sockets[0]; ws.open(); ws.message({ type: "authenticated" }); await pending;
  ws.message({ type: "error", scope: "asr", retryable: false, message: "无服务权限" });
  assert.equal(h.voice.isListening(), false);
  assert.equal(h.timers.size, 0);
});

test("tts_begin迟到时缓存分句和结束，不丢失快速SSE回答", async () => {
  const h = voiceHarness(); const pending = h.voice.beginSpeech(1.2);
  const ws = h.sockets[0]; ws.open(); ws.message({ type: "authenticated" }); await pending;
  const start = ws.sent.find(x => x.type === "tts_start");
  h.voice.pushText("请先停止作业。"); h.voice.endSpeech();
  assert.equal(ws.sent.filter(x => x.type === "tts_text" || x.type === "tts_end").length, 0);
  ws.message({ type: "tts_begin", requestId: start.requestId, sampleRate: 24000 });
  assert.deepEqual(ws.sent.slice(-2).map(x => x.type), ["tts_text", "tts_end"]);
  assert.equal(ws.sent.at(-2).text, "请先停止作业。");
});

test("取消后迟到旧tts_begin不得放行新问题的文本", async () => {
  const h = voiceHarness(); const pending = h.voice.beginSpeech(1.2);
  const ws = h.sockets[0]; ws.open(); ws.message({ type: "authenticated" }); await pending;
  const first = ws.sent.find(x => x.type === "tts_start");
  h.voice.cancelSpeech(); await h.voice.beginSpeech(1.2);
  const second = ws.sent.filter(x => x.type === "tts_start").at(-1);
  h.voice.pushText("新的回答。"); h.voice.endSpeech();
  ws.message({ type: "tts_begin", requestId: first.requestId });
  assert.equal(ws.sent.filter(x => x.type === "tts_text").length, 0);
  ws.message({ type: "tts_begin", requestId: second.requestId });
  assert.equal(ws.sent.filter(x => x.type === "tts_text").length, 1);
});

test("结束聆听后迟到认证不得打开麦克风", async () => {
  const h = voiceHarness(); const pending = h.voice.startListening();
  const ws = h.sockets[0]; ws.open();
  h.voice.stopListening();
  ws.message({ type: "authenticated" });
  assert.equal(await pending, false);
  assert.equal(h.micCalls(), 0);
});
