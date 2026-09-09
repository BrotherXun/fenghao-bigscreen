const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const vm = require("node:vm");
const { gunzipSync } = require("node:zlib");

const voiceDir = path.resolve(__dirname, "../voice");
const screenSource = fs.readFileSync(path.join(__dirname, "../public/screen.js"), "utf8");
const screenHtml = fs.readFileSync(path.join(__dirname, "../public/screen.html"), "utf8");
const screenCss = fs.readFileSync(path.join(__dirname, "../public/screen.css"), "utf8");
const serverSource = fs.readFileSync(path.join(__dirname, "../server.cjs"), "utf8");
const voiceBridgeSource = fs.readFileSync(path.join(__dirname, "../voice/bridge.mjs"), "utf8");
const speakingCharacterPath = path.join(__dirname, "../public/assets/safety-assistant-woman-speaking-hd.png");
const thinkingCharacterPath = path.join(__dirname, "../public/assets/safety-assistant-woman-thinking-hd.png");
const speakingLoopPath = path.join(__dirname, "../public/assets/safety-assistant-woman-speaking-loop.webm");

function loadScreen(fetchImpl, createVoice) {
  let options;
  const context = {
    URL,
    URLSearchParams,
    Vue: {
      createApp(value) {
        options = value;
        return { mount() {} };
      },
    },
    fetch: fetchImpl,
    localStorage: {
      getItem() { return null; },
      setItem() {},
    },
    location: { search: "", origin: "http://127.0.0.1:4173" },
    window: {
      FenghaoApi: { apiBase: "" },
      createVoice,
    },
  };
  vm.createContext(context);
  vm.runInContext(screenSource, context, { filename: "public/screen.js" });

  const instance = Object.assign(options.data(), options.methods, {
    $refs: {},
    $nextTick(callback) { callback(); },
  });
  for (const [name, getter] of Object.entries(options.computed)) {
    Object.defineProperty(instance, name, { get: () => getter.call(instance) });
  }
  return instance;
}

test("问答默认展示，进入和重新进入均需用户点击才开启聆听", async () => {
  let listening = false;
  let startCalls = 0;
  let stopCalls = 0;
  const voice = {
    isAvailable: () => true,
    isListening: () => listening,
    async startListening() {
      startCalls += 1;
      listening = true;
      return true;
    },
    stopListening() {
      stopCalls += 1;
      listening = false;
    },
  };
  const screen = loadScreen(
    async () => ({ ok: true, async json() { return { configured: true, speech: true }; } }),
    () => voice,
  );

  assert.equal(screen.assistantOpen, true);
  await screen.openAssistant();
  assert.equal(screen.assistantOpen, true);
  assert.equal(screen.assistantViewMode, "voice");
  assert.equal(screen.assistantVoiceListening, false);
  assert.equal(startCalls, 0);
  await screen.toggleAssistantVoice();
  assert.equal(screen.assistantVoiceListening, true);
  assert.equal(startCalls, 1);

  screen.closeAssistant();
  assert.equal(stopCalls, 1);
  await screen.openAssistant();
  assert.equal(screen.assistantVoiceListening, false);
  assert.equal(startCalls, 1);
});

test("语音播报默认使用成熟姐姐音色", () => {
  const speaker = "ICL_uranus_zh_female_chengshujiejie_tob";
  assert.match(serverSource, new RegExp(speaker));
  assert.equal(voiceBridgeSource.match(new RegExp(speaker, "g"))?.length, 2);
  assert.doesNotMatch(`${serverSource}\n${voiceBridgeSource}`, /zh_male_m191_uranus_bigtts/);
});

test("语音模式使用戴安全帽的真人安全员，并用思考和讲解动作区分状态", () => {
  const speakingCharacter = fs.readFileSync(speakingCharacterPath);
  const thinkingCharacter = fs.readFileSync(thinkingCharacterPath);
  const speakingLoop = fs.readFileSync(speakingLoopPath);
  assert.match(screenHtml, /assets\/safety-assistant-woman-speaking-hd\.png/);
  assert.match(screenHtml, /assets\/safety-assistant-woman-thinking-hd\.png/);
  assert.match(screenHtml, /width="1644" height="1800"/);
  assert.match(screenHtml, /ref="assistantSpeakingVideo"[^>]*muted[^>]*loop[^>]*playsinline/);
  assert.match(screenHtml, /assets\/safety-assistant-woman-speaking-loop\.webm/);
  assert.match(screenHtml, /assistant-mascot-figure/);
  assert.match(screenHtml, /assistant-mascot-pose-speaking/);
  assert.match(screenHtml, /assistant-mascot-pose-thinking/);
  assert.doesNotMatch(screenHtml, /assistant-mascot-mouth-layer/);
  assert.match(screenCss, /data-state="listening"[^}]*assistant-mascot-figure/);
  assert.match(screenCss, /data-state="listening"[^}]*assistant-mascot-pose-speaking[^}]*opacity:\s*0/);
  assert.match(screenCss, /data-state="listening"[^}]*assistant-mascot-pose-thinking[^}]*opacity:\s*1/);
  assert.match(screenCss, /data-state="thinking"[^}]*assistant-mascot-figure/);
  assert.match(screenCss, /data-state="speaking"[^}]*assistant-mascot-figure/);
  assert.match(screenCss, /data-state="speaking"[^}]*assistant-mascot-figure[^}]*animation:\s*none/);
  assert.match(screenCss, /data-state="speaking"[^}]*assistant-mascot-figure[^}]*transform:\s*none/);
  assert.doesNotMatch(screenCss, /assistant-mascot-speak/);
  assert.match(screenCss, /data-state="speaking"[^}]*assistant-mascot-video[^}]*opacity:\s*1/);
  assert.match(screenSource, /voicePresentationState\(state\)/);
  assert.match(screenSource, /assistantSpeakingVideo/);
  assert.match(screenSource, /video\.currentTime\s*=\s*0/);
  assert.match(screenSource, /video\.play\(\)/);
  assert.match(screenSource, /video\.pause\(\)/);
  assert.doesNotMatch(screenCss, /assistant-mascot-mouth-layer|@keyframes assistant-mascot-mouth/);
  assert.doesNotMatch(screenCss, /assistant-mascot-figure::after/);
  assert.match(screenCss, /\.assistant-signal-stage\s*\{[^}]*align-items:\s*center/);
  assert.match(screenCss, /\.assistant-signal-surface\s*\{[^}]*justify-content:\s*center/);
  assert.match(screenCss, /\.assistant-signal-copy\s*\{[^}]*text-align:\s*center/);
  assert.match(screenCss, /\.assistant-voice-actions\s*\{[^}]*justify-content:\s*center/);
  assert.doesNotMatch(screenCss, /assistant-signal-surface[^}]*translateX\(-5%\)/);
  assert.match(screenHtml, /screen\.css\?v=18/);
  assert.match(screenHtml, /screen\.js\?v=13/);
  assert.doesNotMatch(screenHtml, /assistant-voice-orb|assistant-signal-aura|assistant-signal-orbit|assistant-signal-points/);
  assert.doesNotMatch(screenCss, /assistant-orb-breathe|assistant-aura-pulse|assistant-orbit|assistant-point/);
  assert.equal(speakingCharacter.readUInt32BE(0), 0x89504e47);
  assert.equal(speakingCharacter[25], 6);
  assert.equal(thinkingCharacter.readUInt32BE(0), 0x89504e47);
  assert.equal(thinkingCharacter[25], 6);
  assert.notEqual(thinkingCharacter.length, speakingCharacter.length);
  assert.equal(speakingLoop.subarray(0, 4).toString("hex"), "1a45dfa3");
});

test("取消握手中的识别或合成不会提前关闭 WebSocket", async () => {
  const { AsrSession } = await import(pathToFileURL(path.join(voiceDir, "asr.mjs")).href);
  const { TtsSession } = await import(pathToFileURL(path.join(voiceDir, "tts.mjs")).href);
  let closeCalls = 0;
  const connectingSocket = {
    readyState: 0,
    close() { closeCalls += 1; }
  };

  const asr = new AsrSession({});
  asr.socket = connectingSocket;
  asr.close();
  assert.equal(closeCalls, 0);

  const tts = new TtsSession({});
  tts.idle = connectingSocket;
  tts.active = connectingSocket;
  tts.close();
  assert.equal(closeCalls, 0);
});

test("语音合成请求携带所选语速", async () => {
  const { TtsSession } = await import(pathToFileURL(path.join(voiceDir, "tts.mjs")).href);
  const session = new TtsSession({ appId: "app", accessToken: "token", speaker: "speaker", speedRatio: 1.4 });
  const frame = session.buildRequest("请停止作业");
  const size = frame.readUInt32BE(4);
  const payload = JSON.parse(gunzipSync(frame.subarray(8, 8 + size)).toString("utf8"));
  assert.equal(payload.audio.speed_ratio, 1.4);
});

test("播报被打断时会缓存首段语音，待识别就绪后按顺序发送", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../public/screen-voice.js"), "utf8");
  const sockets = [];
  let worklet;

  class MockWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() {
      this.readyState = MockWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }
    send(value) { this.sent.push(value); }
    open() { this.readyState = MockWebSocket.OPEN; this.onopen(); }
    message(data) { this.onmessage({ data }); }
  }

  class MockAudioContext {
    constructor() {
      this.state = "running";
      this.currentTime = 0;
      this.destination = {};
      this.audioWorklet = { addModule: async () => {} };
    }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createBuffer(_channels, length, rate) {
      return { duration: length / rate, getChannelData() { return new Float32Array(length); } };
    }
    createBufferSource() { return { connect() {}, start() {}, stop() {}, onended: null }; }
  }

  class MockAudioWorkletNode {
    constructor() {
      this.port = { onmessage: null, postMessage() {} };
      worklet = this;
    }
    connect() {}
    disconnect() {}
  }

  const sandbox = {
    setTimeout, clearTimeout,
    ArrayBuffer,
    AudioWorkletNode: MockAudioWorkletNode,
    Float32Array,
    Int16Array,
    WebSocket: MockWebSocket,
    location: { protocol: "http:", host: "localhost:4173" },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    window: { AudioContext: MockAudioContext, AudioWorklet: function AudioWorklet() {} }
  };
  vm.runInNewContext(source, sandbox);
  const voice = sandbox.window.createVoice({
    deviceId: "D1", deviceToken: "synthetic-token",
    onError() {}, onFinalTranscript() {}, onPartialTranscript() {}, onStateChange() {}
  });
  const starting = voice.startListening();
  const socket = sockets[0];
  socket.open();
  socket.message(JSON.stringify({ type: "authenticated" }));
  await starting;
  socket.message(JSON.stringify({ type: "asr_ready" }));

  // 模拟上一轮问题已经完成识别，真实播报开始时不会仍向旧识别会话送音频。
  for (let index = 0; index < 4; index += 1) {
    worklet.port.onmessage({ data: { type: "audio", level: 0.2, pcm: new Int16Array([3, 4]).buffer } });
  }
  for (let index = 0; index < 6; index += 1) {
    worklet.port.onmessage({ data: { type: "audio", level: 0, pcm: new Int16Array([0, 0]).buffer } });
  }
  socket.message(JSON.stringify({ type: "asr_final", text: "上一轮问题" }));
  socket.sent.length = 0;

  await voice.beginSpeech();
  const ttsStart = socket.sent.filter((item) => typeof item === "string").map((item) => JSON.parse(item)).find((item) => item.type === "tts_start");
  socket.message(JSON.stringify({ type: "tts_begin", requestId: ttsStart.requestId, sampleRate: 24000 }));
  socket.message(new Int16Array([1, 2]).buffer);
  const firstUtterance = [0, 1, 2, 3].map(() => new Int16Array([17, 18]).buffer);
  firstUtterance.forEach((pcm) => worklet.port.onmessage({ data: { type: "audio", level: 0.2, pcm } }));

  const audioBeforeReady = socket.sent.filter((item) => item instanceof ArrayBuffer);
  assert.equal(audioBeforeReady.length, 0);
  socket.message(JSON.stringify({ type: "asr_ready" }));
  const replayedAudio = socket.sent.filter((item) => item instanceof ArrayBuffer);
  assert.deepEqual(replayedAudio, firstUtterance);
});
