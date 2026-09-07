const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const load = file => import(pathToFileURL(path.join(__dirname, '../voice', file)).href);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, respond) {
  const { AsrSession } = await load('asr.mjs');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', socket => { socket.on('error', () => {}); socket.once('message', () => respond(socket)); });
  const errors = [], finals = [], partials = [];
  const session = new AsrSession({ endpoint: `ws://127.0.0.1:${server.address().port}`,
    appId: 'test-app', accessToken: 'test-key', resourceId: 'test-resource',
    onError: error => errors.push(error.message), onFinal: text => finals.push(text), onPartial: text => partials.push(text) });
  t.after(async () => { session.close(); for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
  await session.open();
  return { session, errors, finals, partials };
}
async function until(predicate) {
  for (let count = 0; count < 100 && !predicate(); count++) await delay(5);
  assert.ok(predicate());
}

test('ASR unexpected established connection close reports one failure and no final result', async t => {
  const f = await fixture(t, socket => socket.close());
  await until(() => f.session.closed);
  assert.equal(f.errors.length, 1);
  assert.equal(f.finals.length, 0);
});

test('ASR malformed message closes the source and ignores any subsequent final frame', async t => {
  const { encodeFrame, MESSAGE_TYPE, FLAG } = await load('frame.mjs');
  const f = await fixture(t, socket => {
    socket.send(Buffer.from([0x11, 0x91, 0, 0]));
    socket.send(encodeFrame({ messageType: MESSAGE_TYPE.FULL_SERVER_RESPONSE, flags: FLAG.NEGATIVE_SEQUENCE,
      sequence: -1, payload: Buffer.from(JSON.stringify({ result: { text: '不应采用' } })) }));
  });
  await until(() => f.errors.length > 0);
  await delay(30);
  assert.equal(f.session.closed, true);
  assert.equal(f.errors.length, 1);
  assert.equal(f.finals.length, 0);
});

test('ASR partial and final responses retain text and close without reporting failure', async t => {
  const { encodeFrame, MESSAGE_TYPE, FLAG } = await load('frame.mjs');
  const f = await fixture(t, socket => {
    for (const sequence of [1, -2]) socket.send(encodeFrame({ messageType: MESSAGE_TYPE.FULL_SERVER_RESPONSE,
      flags: sequence < 0 ? FLAG.NEGATIVE_SEQUENCE : FLAG.POSITIVE_SEQUENCE, sequence,
      payload: Buffer.from(JSON.stringify({ result: { text: sequence > 0 ? '脚手架' : '脚手架如何验收' } })) }));
  });
  await until(() => f.session.closed);
  assert.deepEqual(f.finals, ['脚手架如何验收']);
  assert.deepEqual(f.partials, ['脚手架', '脚手架如何验收']);
  assert.deepEqual(f.errors, []);
});

test('ASR decoder rejects truncated payload size, payload and invalid JSON', async () => {
  const { decodeFrame } = await load('frame.mjs');
  for (const buffer of [Buffer.from([0x11, 0x92, 0x10, 0]),
    Buffer.from([0x11, 0x92, 0x10, 0, 0, 0, 0, 9, 123, 125]),
    Buffer.from([0x11, 0x92, 0x10, 0, 0, 0, 0, 1, 123])]) assert.throws(() => decodeFrame(buffer));
});
