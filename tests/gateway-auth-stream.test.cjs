const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');

const deviceHeaders = { 'X-Screen-Device-ID': 'D1', 'X-Screen-Device-Token': 'test-device-token' };
const question = { messages: [{ role: 'user', content: '如何安全使用脚手架？' }] };
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, settings = {}) {
  const stats = { agent: 0, voice: 0, closed: 0, authorized: 0, voiceAttempts: 0 };
  let revoked = false;
  const backend = http.createServer((req, res) => {
    if (req.url === '/agent') {
      stats.agent++;
      res.on('close', () => stats.closed++);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"text":"先检查护栏"}\n\n');
      if (!settings.hang) res.end('data: [DONE]\n\n');
      return;
    }
    const authorized = !revoked && req.url === '/api/v1/screen-devices/D1/config'
      && req.headers['x-screen-device-token'] === 'test-device-token';
    if (authorized) stats.authorized++;
    const respond = () => {
      res.writeHead(authorized ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(authorized
        ? { success: true, data: { deviceId: 'D1', status: 'ONLINE', projectId: 'P1' } }
        : { success: false, message: '设备令牌无效' }));
    };
    if (settings.delayStart && stats.authorized > 1) setTimeout(respond, 100); else respond();
  });
  const voice = new WebSocketServer({ server: backend, path: '/speech',
    verifyClient: (_info, done) => {
      stats.voiceAttempts++;
      const respond = () => done(!settings.rejectHandshake, 401, 'Synthetic unauthorized');
      if (settings.delayHandshake) setTimeout(respond, 100); else respond();
    } });
  voice.on('connection', socket => {
    stats.voice++; socket.on('error', () => {});
    if (settings.ttsReply) socket.on('message', () => {
      const frame = Buffer.alloc(14);
      frame.set([0x11, 0xb1, 0, 0]); frame.writeInt32BE(-1, 4); frame.writeUInt32BE(2, 8);
      frame.writeInt16LE(1234, 12); socket.send(frame);
    });
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const upstream = `http://127.0.0.1:${backend.address().port}`;
  let speechEndpoint = upstream.replace('http:', 'ws:') + '/speech';
  if (settings.refuseConnection) {
    const unused = http.createServer();
    unused.listen(0, '127.0.0.1'); await once(unused, 'listening');
    speechEndpoint = `ws://127.0.0.1:${unused.address().port}/speech`;
    await new Promise(resolve => unused.close(resolve));
  }
  const child = spawn(process.execPath, ['server.cjs'], {
    cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FENGHAO_MANAGEMENT_HOST: '127.0.0.1', FENGHAO_MANAGEMENT_PORT: '0',
      FENGHAO_API_BASE: upstream, FENGHAO_ASSISTANT_ENV: '', FENGHAO_PUBLIC_ORIGIN: settings.publicOrigin || '',
      FENGHAO_ASSISTANT_TIMEOUT_MS: String(settings.timeout || 2000), FENGHAO_VOICE_AUTH_TIMEOUT_MS: '150',
      VOLC_BOT_ID: 'test-bot', VOLC_API_KEY: 'test-server-key', VOLC_AGENT_ENDPOINT: upstream + '/agent',
      VOLC_SPEECH_APP_ID: 'test-speech-app', VOLC_SPEECH_ACCESS_TOKEN: 'test-server-speech-key',
      VOLC_ASR_ENDPOINT: speechEndpoint,
      VOLC_TTS_ENDPOINT: speechEndpoint },
  });
  t.after(async () => {
    if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    for (const socket of voice.clients) socket.terminate();
    voice.close(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve));
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const origin = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('gateway startup timeout: ' + errors)), 5000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`gateway exited ${code}: ${errors}`)); });
    child.stdout.on('data', chunk => {
      text += chunk;
      const match = text.match(/Fenghao bigscreen: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  return { origin, stats, revoke: () => { revoked = true; }, chat(headers = deviceHeaders) {
    return fetch(origin + '/api/v1/assistant/chat', { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(question) });
  }, async connect(originHeader = origin) {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws/voice', { origin: originHeader });
    socket.on('error', () => {});
    const messages = [];
    socket.on('message', (data, binary) => { if (!binary) messages.push(JSON.parse(data.toString())); });
    t.after(() => socket.terminate());
    await once(socket, 'open');
    return { socket, messages };
  } };
}

async function until(predicate, message, timeout = 1200) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), message);
}

test('anonymous, wrong token and cross-origin requests cannot consume paid QA', async t => {
  const f = await fixture(t);
  assert.equal((await f.chat({})).status, 401);
  assert.equal((await f.chat({ ...deviceHeaders, 'X-Screen-Device-Token': 'wrong' })).status, 401);
  assert.equal((await f.chat({ ...deviceHeaders, Origin: 'https://foreign.invalid' })).status, 403);
  assert.equal(f.stats.agent, 0);
});

test('registered device streams real SSE bytes and revocation blocks the next request', async t => {
  const f = await fixture(t);
  const response = await f.chat({ ...deviceHeaders, Origin: f.origin });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  assert.match(await response.text(), /先检查护栏/);
  assert.equal(f.stats.agent, 1);
  f.revoke();
  assert.equal((await f.chat()).status, 401);
  assert.equal(f.stats.agent, 1);
});

test('SSE disconnect cancels upstream and releases the per-device active request', async t => {
  const f = await fixture(t, { hang: true });
  const first = await f.chat();
  const reader = first.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /先检查护栏/);
  assert.equal((await f.chat()).status, 429);
  await reader.cancel();
  await until(() => f.stats.closed === 1, 'browser disconnect must abort upstream');
  const next = await f.chat();
  assert.equal(next.status, 200);
  await next.body.cancel();
});

test('SSE lifetime timeout applies after response headers and first chunk', async t => {
  const f = await fixture(t, { hang: true, timeout: 150 });
  const response = await f.chat();
  const reader = response.body.getReader();
  await reader.read();
  await until(() => f.stats.closed === 1, 'stream must not run forever after headers');
  await reader.cancel().catch(() => {});
});

test('WS refuses audio/control before device authentication without opening cloud connections', async t => {
  const f = await fixture(t);
  const { socket, messages } = await f.connect();
  socket.send(JSON.stringify({ type: 'asr_start' }));
  await until(() => socket.readyState === WebSocket.CLOSED, 'unauthenticated socket must close');
  assert.equal(f.stats.voice, 0);
  assert.ok(messages.some(message => message.type === 'error' && message.scope === 'auth'));
});

test('WS authenticates before ASR and checks device revocation for later synthesis', async t => {
  const f = await fixture(t);
  const { socket, messages } = await f.connect();
  socket.send(JSON.stringify({ type: 'authenticate', deviceId: 'D1', deviceToken: 'test-device-token' }));
  await until(() => messages.some(message => message.type === 'authenticated'), 'auth acknowledgement');
  socket.send(JSON.stringify({ type: 'asr_start' }));
  await until(() => f.stats.voice === 1, 'ASR only after authentication');
  f.revoke();
  socket.send(JSON.stringify({ type: 'tts_start' }));
  await until(() => socket.readyState === WebSocket.CLOSED, 'revoked device must close');
  assert.equal(f.stats.voice, 1);
});

test('WS idle handshake expires and foreign browser origins are rejected', async t => {
  const f = await fixture(t);
  const { socket } = await f.connect();
  await until(() => socket.readyState === WebSocket.CLOSED, 'idle authentication timeout');
  await assert.rejects(f.connect('https://foreign.invalid'));
  assert.equal(f.stats.voice, 0);
});

test('cancelling while cloud-start authorization is pending does not reopen ASR or TTS', async t => {
  const f = await fixture(t, { delayStart: true });
  const { socket, messages } = await f.connect();
  socket.send(JSON.stringify({ type: 'authenticate', deviceId: 'D1', deviceToken: 'test-device-token' }));
  await until(() => messages.some(message => message.type === 'authenticated'), 'auth acknowledgement');
  socket.send(JSON.stringify({ type: 'asr_start' }));
  socket.send(JSON.stringify({ type: 'asr_abort' }));
  socket.send(JSON.stringify({ type: 'tts_start' }));
  socket.send(JSON.stringify({ type: 'tts_cancel' }));
  await delay(200);
  assert.equal(f.stats.voice, 0);
  assert.equal(socket.readyState, WebSocket.OPEN);
});

test('TTS begin and completion carry the same request ID around real binary audio', async t => {
  const f = await fixture(t, { ttsReply: true });
  const { socket, messages } = await f.connect();
  const audio = [];
  socket.on('message', (data, binary) => { if (binary) audio.push(data); });
  socket.send(JSON.stringify({ type: 'authenticate', deviceId: 'D1', deviceToken: 'test-device-token' }));
  await until(() => messages.some(m => m.type === 'authenticated'), 'auth acknowledgement');
  socket.send(JSON.stringify({ type: 'tts_start', requestId: 'question-2' }));
  await until(() => messages.some(m => m.type === 'tts_begin' && m.requestId === 'question-2'), 'matching TTS ready');
  socket.send(JSON.stringify({ type: 'tts_text', requestId: 'question-2', text: '请先戴好安全帽。' }));
  socket.send(JSON.stringify({ type: 'tts_end', requestId: 'question-2' }));
  await until(() => messages.some(m => m.type === 'tts_end' && m.requestId === 'question-2'), 'matching TTS completion');
  assert.equal(Buffer.concat(audio).readInt16LE(), 1234);
  assert.ok(!messages.some(m => m.type === 'error'));
});

test('configured HTTPS IP origin is accepted through an internal HTTP reverse proxy', async t => {
  const publicOrigin = 'https://118.31.223.11:8443';
  const f = await fixture(t, { publicOrigin });
  assert.equal((await f.chat({ ...deviceHeaders, Origin: publicOrigin })).status, 200);
  assert.equal((await f.chat({ ...deviceHeaders, Origin: f.origin })).status, 403);
  const { socket, messages } = await f.connect(publicOrigin);
  socket.send(JSON.stringify({ type: 'authenticate', deviceId: 'D1', deviceToken: 'test-device-token' }));
  await until(() => messages.some(m => m.type === 'authenticated'), 'proxy origin acknowledgement');
});

for (const [name, settings] of [['rejected upgrade', { rejectHandshake: true }], ['refused connection', { refuseConnection: true }]]) {
  test(`ASR ${name} reaches the browser as one scoped error; TTS retains its request ID`, async t => {
    const f = await fixture(t, settings);
    const { socket, messages } = await f.connect();
    socket.send(JSON.stringify({ type: 'authenticate', deviceId: 'D1', deviceToken: 'test-device-token' }));
    await until(() => messages.some(m => m.type === 'authenticated'), 'auth acknowledgement');
    socket.send(JSON.stringify({ type: 'asr_start' }));
    await until(() => messages.some(m => m.type === 'error' && m.scope === 'asr'), 'ASR handshake failure must reach browser');
    assert.equal(messages.filter(m => m.type === 'error' && m.scope === 'asr').length, 1);
    assert.ok(!messages.some(m => m.type === 'asr_ready' || m.type === 'asr_final'));
    socket.send(JSON.stringify({ type: 'tts_start', requestId: 'rejected-question' }));
    await until(() => messages.some(m => m.type === 'error' && m.scope === 'tts'), 'TTS handshake failure must reach browser');
    assert.deepEqual(messages.filter(m => m.type === 'error' && m.scope === 'tts').map(m => m.requestId), ['rejected-question']);
    assert.equal(socket.readyState, WebSocket.OPEN);
    assert.ok(!messages.some(m => m.type === 'tts_begin' || m.type === 'tts_end'));
  });
}

test('aborting ASR during a pending rejected handshake does not report a failure for the cancelled turn', async t => {
  const f = await fixture(t, { rejectHandshake: true, delayHandshake: true });
  const { socket, messages } = await f.connect();
  socket.send(JSON.stringify({ type: 'authenticate', deviceId: 'D1', deviceToken: 'test-device-token' }));
  await until(() => messages.some(m => m.type === 'authenticated'), 'auth acknowledgement');
  socket.send(JSON.stringify({ type: 'asr_start' }));
  await until(() => f.stats.voiceAttempts === 1, 'cloud handshake has begun');
  socket.send(JSON.stringify({ type: 'asr_abort' }));
  await delay(160);
  assert.ok(!messages.some(m => m.type === 'error' || m.type === 'asr_ready' || m.type === 'asr_final'));
  assert.equal(socket.readyState, WebSocket.OPEN);
});