const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadVoice() {
  const sockets = [], sources = [], states = [], transcripts = [], partials = [], errors = [], timers = new Map();
  let worklet, timerId = 0, interrupts = 0;
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.onopen(); }
    send(value) { this.sent.push(value); }
    message(value) { this.onmessage({ data: JSON.stringify(value) }); }
    audio(pcm) { this.onmessage({ data: pcm }); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  class AudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createBuffer(_channels, length, rate) { return { duration: length / rate, getChannelData: () => new Float32Array(length) }; }
    createBufferSource() {
      const source = { connect() {}, start() {}, stops: 0, stop() { this.stops++; }, onended: null, end() { this.onended?.(); } };
      sources.push(source);
      return source;
    }
  }
  class Worklet {
    constructor() { this.port = { onmessage: null, postMessage() {} }; worklet = this; }
    connect() {}
    disconnect() {}
  }
  const sandbox = {
    ArrayBuffer, Float32Array, Int16Array, WebSocket: Socket, AudioWorkletNode: Worklet,
    location: { protocol: 'http:', host: 'localhost:4173' },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
    window: { AudioContext, AudioWorklet: function () {} },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/screen-voice.js'), 'utf8'), sandbox);
  const voice = sandbox.window.createVoice({
    deviceId: 'D1', deviceToken: 'synthetic-token',
    onStateChange: state => states.push(state), onFinalTranscript: value => transcripts.push(value),
    onPartialTranscript: value => partials.push(value), onError: (...args) => errors.push(args),
    onInterrupt: () => { interrupts++; },
  });
  const h = {
    voice, sockets, sources, states, transcripts, partials, errors, timers,
    interrupts: () => interrupts,
    commands: type => sockets[0].sent.filter(value => typeof value === 'string').map(value => JSON.parse(value)).filter(value => !type || value.type === type),
    audioSent: () => sockets[0].sent.filter(value => value instanceof ArrayBuffer),
    frame(level = 0.2, pcm = new Int16Array([17, 18]).buffer) { worklet.port.onmessage({ data: { type: 'audio', level, pcm } }); return pcm; },
    runTimer(delay) { const item = [...timers].find(([, value]) => value.delay === delay); if (!item) throw new Error('Missing timer: ' + delay); timers.delete(item[0]); item[1].fn(); },
    async start() { const pending = voice.startListening(); sockets[0].open(); sockets[0].message({ type: 'authenticated' }); await pending; sockets[0].message({ type: 'asr_ready' }); },
    finishQuestion() { for (let i = 0; i < 4; i++) h.frame(); for (let i = 0; i < 6; i++) h.frame(0); sockets[0].message({ type: 'asr_final', text: '上一轮问题' }); },
    async speak() { await voice.beginSpeech(); const requestId = h.commands('tts_start').at(-1).requestId; sockets[0].message({ type: 'tts_begin', requestId }); sockets[0].audio(new Int16Array([1, 2]).buffer); return requestId; },
  };
  return h;
}

module.exports = { loadVoice };
