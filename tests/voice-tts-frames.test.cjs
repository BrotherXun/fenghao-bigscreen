const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { gzipSync } = require("node:zlib");
const test = require("node:test");
const { WebSocketServer } = require("ws");

const ttsModule = import(pathToFileURL(path.join(__dirname, "../voice/tts.mjs")).href);

function audioFrame(sequence, payload = Buffer.alloc(0), headerSize = 4) {
  const header = Buffer.alloc(headerSize);
  header[0] = 0x10 | (headerSize / 4);
  header[1] = sequence < 0 ? 0xb3 : 0xb1;
  const fields = Buffer.alloc(8);
  fields.writeInt32BE(sequence, 0);
  fields.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, fields, payload]);
}

function errorFrame(code, detail, compressed = false) {
  const body = compressed ? gzipSync(Buffer.from(detail)) : Buffer.from(detail);
  const fields = Buffer.alloc(8);
  fields.writeUInt32BE(code, 0);
  fields.writeUInt32BE(body.length, 4);
  return Buffer.concat([Buffer.from([0x11, 0xf0, compressed ? 1 : 0, 0]), fields, body]);
}

class MemorySocket extends EventEmitter {
  readyState = 1;
  closeCalls = 0;
  send() {}
  close() {
    this.closeCalls += 1;
    this.readyState = 3;
    this.emit("close");
  }
}

async function activeSession() {
  const { TtsSession } = await ttsModule;
  const audio = [];
  const errors = [];
  let finishes = 0;
  const session = new TtsSession({
    onAudio: (chunk) => audio.push(Buffer.from(chunk)),
    onError: (error) => errors.push(error),
    onFinish: () => { finishes += 1; },
  });
  // Only the transport is replaced; pump installs the actual message/error/close callbacks.
  session.prefetch = () => {};
  const socket = new MemorySocket();
  session.idle = socket;
  session.speak("安全提示");
  const idle = new MemorySocket();
  session.idle = idle;
  session.finish();
  return { session, socket, idle, audio, errors, finishes: () => finishes };
}

function assertFailedAndClosed(state) {
  assert.equal(state.errors.length, 1, "one actionable error must reach the owner");
  assert.equal(state.errors[0] instanceof RangeError, false);
  assert.equal(state.audio.length, 0, "incomplete audio must not be delivered");
  assert.equal(state.finishes(), 0, "failure must not report successful synthesis");
  assert.equal(state.session.closed, true);
  assert.equal(state.session.active, null);
  assert.equal(state.session.idle, null);
  assert.equal(state.socket.closeCalls, 1);
  assert.equal(state.idle.closeCalls, 1);
}

test("TTS positive audio, header extensions and negative final sequence preserve PCM bytes", async () => {
  const state = await activeSession();
  const first = Buffer.from([0, 1, 2, 3]);
  const last = Buffer.from([4, 5]);
  state.socket.emit("message", audioFrame(1, first, 8));
  assert.equal(state.session.active, state.socket);
  assert.equal(state.finishes(), 0);
  state.socket.emit("message", audioFrame(-2, last));
  assert.deepEqual(state.audio, [first, last]);
  assert.equal(state.errors.length, 0);
  assert.equal(state.finishes(), 1);
  assert.equal(state.socket.closeCalls, 1);
  assert.equal(state.idle.closeCalls, 1);
});

test("TTS no-sequence acknowledgement and empty final frame remain supported", async () => {
  const state = await activeSession();
  state.socket.emit("message", Buffer.from([0x11, 0xb0, 0, 0]));
  assert.equal(state.session.active, state.socket);
  assert.equal(state.audio.length, 0);
  assert.equal(state.errors.length, 0);
  state.socket.emit("message", audioFrame(-1));
  assert.equal(state.finishes(), 1);
});

const malformed = [
  ["empty header", Buffer.alloc(0)],
  ["short header", Buffer.from([0x11, 0xb1, 0])],
  ["zero header size", Buffer.from([0x10, 0xb0, 0, 0])],
  ["truncated header extension", Buffer.from([0x12, 0xb1, 0, 0])],
  ["missing sequence", audioFrame(1).subarray(0, 4)],
  ["partial sequence", audioFrame(1).subarray(0, 7)],
  ["missing audio length", audioFrame(1).subarray(0, 8)],
  ["partial audio length", audioFrame(1).subarray(0, 11)],
  ["truncated final audio payload", audioFrame(-1, Buffer.from([1, 2, 3, 4])).subarray(0, 14)],
  ["oversized audio declaration", Buffer.from([0x11, 0xb1, 0, 0, 0, 0, 0, 1, 255, 255, 255, 255])],
  ["missing error code", errorFrame(3001, "denied").subarray(0, 4)],
  ["partial error code", errorFrame(3001, "denied").subarray(0, 7)],
  ["missing error length", errorFrame(3001, "denied").subarray(0, 8)],
  ["partial error length", errorFrame(3001, "denied").subarray(0, 11)],
  ["truncated error payload", errorFrame(3001, "denied").subarray(0, 13)],
];

for (const [name, frame] of malformed) {
  test(`TTS rejects ${name} through the registered message callback`, async () => {
    const state = await activeSession();
    assert.doesNotThrow(() => state.socket.emit("message", frame));
    assertFailedAndClosed(state);
    state.socket.emit("message", audioFrame(-1, Buffer.from([7, 8])));
    assertFailedAndClosed(state);
  });
}

for (const compressed of [false, true]) {
  test(`TTS reports ${compressed ? "gzip" : "plain"} cloud error without a success callback`, async () => {
    const state = await activeSession();
    state.socket.emit("message", errorFrame(3001, "service unavailable", compressed));
    assertFailedAndClosed(state);
    assert.match(state.errors[0].message, /3001.*service unavailable/);
  });
}

test("TTS transport failure closes the synthesis without a success callback", async () => {
  const state = await activeSession();
  state.socket.emit("error", new Error("connection reset"));
  assertFailedAndClosed(state);
  assert.match(state.errors[0].message, /connection reset/);
});

test("TTS premature socket close is a failure, not a completed sentence", async () => {
  const state = await activeSession();
  state.socket.close();
  assertFailedAndClosed(state);
});

test("real local WebSocket messages report a truncated frame and close both synthesis connections", async (t) => {
  const { TtsSession } = await ttsModule;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const clients = new Set();
  server.on("connection", (socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("message", () => socket.send(Buffer.from([0x11, 0xb1, 0, 0])));
  });
  let finishCalls = 0;
  const errors = [];
  const session = new TtsSession({
    endpoint: `ws://127.0.0.1:${server.address().port}`,
    onAudio: () => assert.fail("truncated frame cannot produce audio"),
    onError: (error) => errors.push(error),
    onFinish: () => { finishCalls += 1; },
  });
  t.after(async () => {
    session.close();
    for (const socket of clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  await session.open();
  session.speak("本地协议测试");
  session.finish();
  // Give the actual ws message event and cancellation of any prefetch handshake time to settle.
  for (let tries = 0; tries < 50 && (!errors.length || clients.size); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(errors.length, 1);
  assert.equal(errors[0] instanceof RangeError, false);
  assert.equal(finishCalls, 0);
  assert.equal(session.closed, true);
  assert.equal(session.connecting.size, 0);
  assert.equal(clients.size, 0);
});

test("real local WebSocket synthesis preserves two queued sentences and finishes once", { timeout: 2000 }, async (t) => {
  const { TtsSession } = await ttsModule;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  let requests = 0;
  server.on("connection", (socket) => {
    socket.on("message", () => {
      requests += 1;
      socket.send(audioFrame(1, Buffer.from([1, 2])));
      socket.send(audioFrame(-2, Buffer.from([3, 4])));
    });
  });
  const audio = [];
  const errors = [];
  let finishes = 0;
  let settle;
  const completed = new Promise((resolve) => { settle = resolve; });
  const session = new TtsSession({
    endpoint: `ws://127.0.0.1:${server.address().port}`,
    onAudio: (chunk) => audio.push(Buffer.from(chunk)),
    onError: (error) => { errors.push(error); settle(); },
    onFinish: () => { finishes += 1; settle(); },
  });
  t.after(async () => {
    session.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  await session.open();
  session.speak("第一句");
  session.speak("第二句");
  session.finish();
  await completed;
  assert.equal(requests, 2);
  assert.deepEqual(audio, [Buffer.from([1, 2]), Buffer.from([3, 4]), Buffer.from([1, 2]), Buffer.from([3, 4])]);
  assert.equal(errors.length, 0);
  assert.equal(finishes, 1);
  assert.equal(session.closed, true);
});
