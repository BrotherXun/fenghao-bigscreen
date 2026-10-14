const assert = require('node:assert/strict');
const test = require('node:test');
const { loadVoice } = require('./helpers/voice-harness.cjs');
const { loadScreen, deferred } = require('./helpers/screen-harness.cjs');
const answer = text => ({ rawResponse: { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ choices: [{ delta: { content: text } }] }) } });

test('播报中持续背景人声不打断、不开始识别且不缓存到下一轮', async () => {
  const h = loadVoice(); await h.start(); h.finishQuestion();
  const requestId = await h.speak();
  h.sockets[0].sent.length = 0;
  for (let i = 0; i < 30; i++) h.frame(0.8);
  assert.equal(h.interrupts(), 0);
  assert.equal(h.sources[0].stops, 0);
  assert.equal(h.commands('asr_start').length, 0);
  assert.equal(h.commands('tts_cancel').length, 0);
  assert.equal(h.audioSent().length, 0);
  h.voice.endSpeech(); h.sockets[0].message({ type: 'tts_end', requestId });
  assert.equal(h.commands('asr_start').length, 0);
  h.sources[0].end();
  assert.equal(h.commands('asr_start').length, 1);
  h.sockets[0].message({ type: 'asr_ready' });
  assert.equal(h.audioSent().length, 0);
});

test('文字提问开始播报时暂停现有ASR并忽略迟到识别结果', async () => {
  const h = loadVoice(); await h.start();
  h.sockets[0].sent.length = 0;
  await h.speak();
  for (let i = 0; i < 30; i++) h.frame(0.8);
  h.sockets[0].message({ type: 'asr_partial', text: '背景声音' });
  h.sockets[0].message({ type: 'asr_final', text: '背景声音' });
  assert.equal(h.audioSent().length, 0);
  assert.deepEqual(h.transcripts, []);
  assert.deepEqual(h.partials, []);
  assert.equal(h.commands('asr_abort').length, 1);
});

test('TTS结束通知先到仍等待最后一块真实音频结束才恢复聆听', async () => {
  const h = loadVoice(); await h.start(); h.finishQuestion();
  const requestId = await h.speak();
  h.sockets[0].audio(new Int16Array([3, 4]).buffer);
  h.sockets[0].sent.length = 0;
  h.voice.endSpeech(); h.sockets[0].message({ type: 'tts_end', requestId });
  h.sources[0].end();
  assert.equal(h.commands('asr_start').length, 0);
  h.sources[1].end();
  assert.equal(h.commands('asr_start').length, 1);
  assert.equal(h.states.at(-1), 'listening');
});

test('手动停止播报后迟到旧TTS结束不得重启正在识别的新一轮', async () => {
  const h = loadVoice(); await h.start(); h.finishQuestion();
  const requestId = await h.speak(); h.sockets[0].sent.length = 0;
  h.voice.cancelSpeech();
  assert.equal(h.sources[0].stops, 1);
  assert.equal(h.commands('asr_start').length, 1);
  h.sockets[0].message({ type: 'tts_end', requestId });
  assert.equal(h.commands('asr_start').length, 1);
});

test('关闭播报时也等待本轮文字结束才识别下一句', async () => {
  const h = loadVoice(); await h.start();
  const pending = deferred();
  const { screen } = loadScreen(() => pending.promise);
  screen.assistantVoice = h.voice; screen.assistantSpeakReplies = false;
  screen.assistantInput = '文字回答';
  h.sockets[0].sent.length = 0;
  const request = screen.sendAssistantQuestion();
  for (let i = 0; i < 30; i++) h.frame(0.8);
  assert.equal(h.audioSent().length, 0);
  pending.resolve(answer('回答完毕')); await request;
  assert.equal(h.commands('asr_start').length, 1);
});

test('TTS预热超时不会在文字请求仍输出时提前恢复ASR', async () => {
  const h = loadVoice(); await h.start(); h.finishQuestion();
  const pending = deferred();
  const { screen, calls } = loadScreen(() => pending.promise);
  screen.assistantVoice = h.voice; screen.assistantSpeechEnabled = true;
  screen.assistantInput = '一个问题';
  const request = screen.sendAssistantQuestion();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(calls.length, 1);
  h.sockets[0].sent.length = 0;
  h.runTimer(20000);
  assert.equal(h.commands('asr_start').length, 0);
  pending.resolve(answer('文字完成')); await request;
  assert.equal(h.commands('asr_start').length, 1);
});

test('停止播报按钮同时中断旧SSE且迟到回答不覆盖或恢复新轮次', async () => {
  const pending = deferred();
  const { screen, calls } = loadScreen(({ body }) => body.messages.at(-1).content === '旧问题' ? pending.promise : answer('新回答'));
  let cancelled = 0;
  screen.assistantVoice = { cancelSpeech() { cancelled++; }, isListening: () => true };
  screen.assistantInput = '旧问题'; const first = screen.sendAssistantQuestion();
  screen.cancelAssistantSpeech();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(screen.assistantBusy, false);
  assert.equal(cancelled, 1);
  screen.assistantInput = '新问题'; await screen.sendAssistantQuestion();
  pending.resolve(answer('旧回答迟到')); await first;
  assert.equal(screen.assistantLiveAnswer, '新回答');
});

test('停止语音也终止当前文字请求，重新开启不会与旧回答重叠', async () => {
  const pending = deferred();
  const { screen, calls } = loadScreen(() => pending.promise);
  let stopped = 0;
  screen.assistantVoice = { stopListening() { stopped++; } };
  screen.assistantInput = '一个问题'; const request = screen.sendAssistantQuestion();
  screen.stopAssistantVoice();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(stopped, 1);
  assert.equal(screen.assistantBusy, false);
  pending.resolve(answer('旧回答')); await request;
  assert.equal(screen.assistantLiveAnswer, '');
});

test('合成故障后等待文字输出完成再恢复且只恢复一次', async () => {
  const h = loadVoice(); await h.start(); h.finishQuestion();
  const pending = deferred(); const { screen } = loadScreen(() => pending.promise);
  screen.assistantVoice = h.voice; screen.assistantSpeechEnabled = true;
  screen.assistantInput = '问题'; const request = screen.sendAssistantQuestion();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const requestId = h.commands('tts_start').at(-1).requestId;
  h.sockets[0].message({ type: 'tts_begin', requestId });
  h.sockets[0].audio(new Int16Array([1, 2]).buffer);
  h.sockets[0].sent.length = 0;
  h.sockets[0].message({ type: 'error', scope: 'tts', requestId, message: '合成失败' });
  assert.equal(h.commands('asr_start').length, 0);
  pending.resolve(answer('文字回答')); await request;
  assert.equal(h.commands('asr_start').length, 1);
});

test('结束语音后迟到TTS结束不得重新开启麦克风或ASR', async () => {
  const h = loadVoice(); await h.start(); h.finishQuestion();
  const requestId = await h.speak(); h.sockets[0].sent.length = 0;
  h.voice.stopListening();
  h.sockets[0].message({ type: 'tts_end', requestId });
  assert.equal(h.voice.isListening(), false);
  assert.equal(h.commands('asr_start').length, 0);
  assert.equal(h.states.at(-1), 'idle');
});

test('上一轮音频未播完时发送关闭播报的新文字问题，全部完成后仍恢复识别', async () => {
  const h = loadVoice(); await h.start(); h.finishQuestion();
  const requestId = await h.speak();
  h.voice.endSpeech(); h.sockets[0].message({ type: 'tts_end', requestId });
  const { screen } = loadScreen(() => answer('新的文字回答'));
  screen.assistantVoice = h.voice; screen.assistantSpeakReplies = false;
  screen.assistantInput = '文字追问'; h.sockets[0].sent.length = 0;
  await screen.sendAssistantQuestion();
  assert.equal(h.commands('asr_start').length, 0);
  h.sources[0].end();
  assert.equal(h.commands('asr_start').length, 1);
  assert.equal(h.states.at(-1), 'listening');
});

test('语音断线后重新开启，仍等待旧文字请求结束才开始ASR', async () => {
  const h = loadVoice(); await h.start();
  const pending = deferred(); const { screen } = loadScreen(() => pending.promise);
  screen.assistantVoice = h.voice; screen.assistantSpeakReplies = false;
  screen.assistantSpeechEnabled = true; screen.assistantInput = '文字问题';
  const request = screen.sendAssistantQuestion(); h.sockets[0].close();
  const reconnect = screen.startAssistantListening();
  const socket = h.sockets[1]; socket.open(); socket.message({ type: 'authenticated' });
  assert.equal(await reconnect, true);
  const commands = () => socket.sent.filter(value => typeof value === 'string').map(value => JSON.parse(value));
  assert.equal(screen.assistantBusy, true);
  assert.equal(commands().filter(value => value.type === 'asr_start').length, 0);
  pending.resolve(answer('完成文字回答')); await request;
  assert.equal(commands().filter(value => value.type === 'asr_start').length, 1);
});

test('手动中断后旧ASR最终结果不能吞掉新一轮握手期间的首句', async () => {
  const h = loadVoice(); await h.start();
  await h.speak(); h.voice.cancelSpeech();
  const frames = [];
  for (let i = 0; i < 4; i++) frames.push(h.frame());
  for (let i = 0; i < 6; i++) frames.push(h.frame(0));
  h.sockets[0].message({ type: 'asr_final', text: '旧识别结果' });
  h.sockets[0].message({ type: 'asr_ready' });
  assert.deepEqual(h.transcripts, []);
  assert.deepEqual(h.audioSent(), frames.slice(0, -1));
  assert.equal(h.commands('asr_stop').length, 1);
});
