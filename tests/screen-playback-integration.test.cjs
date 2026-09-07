const assert = require("node:assert/strict");
const test = require("node:test");
const { loadScreen, deferred } = require("./helpers/screen-harness.cjs");
const session = { playbackSessionId: "P1", assignmentId: "A1", unitId: "U1", resourceId: "V1", durationMs: 6000, lastSequence: 0, acceptedPositionMs: 0, maxWatchedPositionMs: 0, watchedMs: 0, coveragePercent: 0, completionStatus: "ACTIVE", gateStatus: "LEARNING_REQUIRED" };
const result = (position = 0, overrides = {}) => ({ acceptedPositionMs: position, maxWatchedPositionMs: position, watchedMs: position, coveragePercent: Math.floor(position / 60), completionStatus: "ACTIVE", gateStatus: "LEARNING_REQUIRED", blockedReasonCode: "VIDEO_NOT_COMPLETED", ...overrides });
function screenFor(events = ({ body }) => result(body.toPositionMs), config = {}) {
  const h = loadScreen(async call => {
    if (call.url.endsWith("/playback-sessions")) return config.playbackSession || session;
    if (call.url.endsWith("/complete")) return { sessionId: "S1", status: "learning_completed", allCompleted: true, examUnlocked: true, assignmentId: "A1", gate: { status: "EXAM_READY" } };
    return events(call);
  }, config);
  h.screen.deviceId = "D1"; h.screen.deviceToken = "device-token";
  h.screen.session = { sessionId: "S1", assignmentId: "A1", snapshotId: "SN1", status: "playing" };
  h.screen.stage = "playing";
  h.screen.videos = [{ videoId: "V1", unitId: "U1", assignmentId: "A1", durationSec: 6, videoUrl: "/files/video.mp4", progress: 0, status: "pending", mustComplete: true }];
  const player = { dataset: { videoId: "V1" }, currentTime: 0, duration: 6, playbackRate: 1, paused: false, ended: false, pause() { this.paused = true; }, async play() { this.paused = false; } };
  h.screen.$refs.learningVideo = player;
  return { ...h, player, event: { currentTarget: player } };
}

test("真实播放建立新版会话，START与心跳使用毫秒位置和递增序号", async () => {
  const h = screenFor();
  await h.screen.onLearningPlay(h.event);
  h.player.currentTime = 3;
  await h.screen.reportProgress(50);
  assert.equal(h.calls[0].url, "/api/v1/screen-sessions/S1/units/U1/playback-sessions");
  const events = h.calls.filter(x => x.url.endsWith("/playback-events"));
  assert.equal(events[0].body.type, "START");
  assert.equal(events[0].body.sequence, 1);
  assert.equal(events[1].body.type, "HEARTBEAT");
  assert.equal(events[1].body.fromPositionMs, 0);
  assert.equal(events[1].body.toPositionMs, 3000);
  assert.equal(events[1].body.sequence, 2);
  assert.equal(events[1].body.progress, undefined);
  assert.equal(h.screen.videos[0].progress, 50);
});

test("缺少视频不能模拟完成或请求旧百分比接口", async () => {
  const h = screenFor(); h.screen.videos[0].videoUrl = "";
  await h.screen.finishCurrentVideo();
  assert.equal(h.calls.length, 0);
  assert.match(h.screen.error, /视频/);
  assert.equal(h.screen.stage, "playing");
});

test("完成按钮不能在实际结束前发送ENDED或100%", async () => {
  const h = screenFor(); await h.screen.onLearningPlay(h.event);
  h.player.currentTime = 1;
  await h.screen.finishCurrentVideo();
  assert.ok(h.calls.every(x => x.body?.type !== "ENDED" && x.body?.progress === undefined));
  assert.equal(h.screen.stage, "playing");
  assert.match(h.screen.error, /完整播放/);
});

test("失败事件重试复用eventId和sequence，不跳过不确定提交", async () => {
  let fail = true;
  const h = screenFor(({ body }) => {
    if (body.type === "HEARTBEAT" && fail) { fail = false; throw new Error("响应丢失"); }
    return result(body.toPositionMs);
  });
  await h.screen.onLearningPlay(h.event); h.player.currentTime = 3;
  await h.screen.reportProgress();
  assert.equal(h.player.paused, true);
  assert.match(h.screen.error, /响应丢失/);
  await h.screen.reportProgress();
  const attempts = h.calls.filter(x => x.body?.type === "HEARTBEAT");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].body.eventId, attempts[1].body.eventId);
  assert.equal(attempts[0].body.sequence, attempts[1].body.sequence);
  assert.equal(h.screen.error, "");
});

test("拖动后只重设真实位置，不把跳过区间计作播放", async () => {
  const h = screenFor(); await h.screen.onLearningPlay(h.event);
  h.player.currentTime = 5;
  await h.screen.onLearningSeeked(h.event);
  const event = h.calls.at(-1).body;
  assert.equal(event.type, "START");
  assert.equal(event.fromPositionMs, 5000);
  assert.equal(event.toPositionMs, 5000);
});

test("服务端未确认覆盖率时结束事件不能解锁或跳段", async () => {
  const h = screenFor(({ body }) => result(body.toPositionMs, { coveragePercent: 10 }));
  await h.screen.onLearningPlay(h.event);
  h.player.currentTime = 6; h.player.ended = true;
  await h.screen.onLearningEnded(h.event);
  assert.equal(h.screen.currentIndex, 0);
  assert.equal(h.screen.stage, "playing");
  assert.match(h.screen.error, /完整播放/);
  assert.ok(h.calls.every(x => !x.url.endsWith("/complete")));
});

test("实际结束和服务端覆盖率完成后再确认现代考试gate", async () => {
  const h = screenFor(({ body }) => result(body.toPositionMs, body.type === "ENDED" ? { completionStatus: "COMPLETED", coveragePercent: 100, gateStatus: "EXAM_READY", blockedReasonCode: null } : {}));
  await h.screen.onLearningPlay(h.event);
  h.player.currentTime = 6; h.player.ended = true;
  await h.screen.onLearningEnded(h.event);
  assert.equal(h.screen.stage, "completed");
  assert.equal(h.screen.videos[0].progress, 100);
  assert.equal(h.calls.at(-1).url, "/api/v1/screen-sessions/S1/complete");
});

test("新版进度迟到不写入新会话也不触发完成", async () => {
  const late = deferred();
  const h = screenFor(({ body }) => body.type === "START" ? result() : late.promise);
  await h.screen.onLearningPlay(h.event);
  h.player.currentTime = 3;
  const pending = h.screen.reportProgress();
  h.screen.session = { sessionId: "S2", assignmentId: "A2" };
  h.screen.videos = [{ videoId: "V1", progress: 0 }];
  late.resolve(result(3000)); await pending;
  assert.equal(h.screen.videos[0].progress, 0);
  assert.equal(h.screen.session.sessionId, "S2");
});

test("现代完成响应的gate未就绪时不依据矛盾布尔值解锁", async () => {
  const { screen } = loadScreen(async () => ({ sessionId: "S1", assignmentId: "A1", status: "learning_completed", allCompleted: true, examUnlocked: true, gate: { status: "LEARNING_REQUIRED" } }));
  screen.session = { sessionId: "S1", assignmentId: "A1" }; screen.stage = "playing";
  await screen.finishAll();
  assert.equal(screen.stage, "playing");
  assert.match(screen.error, /尚未解锁/);
});

test("暂停后恢复先等待START确认，期间播放器保持暂停", async () => {
  const ready = deferred(); let starts = 0;
  const h = screenFor(({ body }) => body.type === "START" && ++starts > 1 ? ready.promise : result(body.toPositionMs));
  await h.screen.onLearningPlay(h.event);
  h.player.paused = true; h.player.currentTime = 2;
  await h.screen.onLearningPause(h.event);
  h.player.paused = false;
  const pending = h.screen.onLearningPlay(h.event);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.player.paused, true);
  ready.resolve(result(2000)); await pending;
  assert.equal(h.player.paused, false);
  assert.equal(h.calls.at(-1).body.type, "START");
});

test("无randomUUID的HTTP浏览器仍生成独立幂等事件ID", async () => {
  let seed = 0;
  const h = screenFor(undefined, { crypto: { getRandomValues(bytes) { bytes.fill(++seed); return bytes; } } });
  await h.screen.onLearningPlay(h.event);
  h.player.currentTime = 2;
  await h.screen.reportProgress();
  const ids = h.calls.filter(x => x.body?.eventId).map(x => x.body.eventId);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.ok(ids.every(id => /^[0-9a-f-]{36}$/.test(id)));
});

test("初始位置相同不重新赋值currentTime触发伪seek", async () => {
  const h = screenFor(); let writes = 0;
  Object.defineProperty(h.player, "currentTime", { get: () => 0, set() { writes++; } });
  await h.screen.onLearningPlay(h.event);
  assert.equal(writes, 0);
});

test("恢复服务端位置的迟到seek不发送PAUSE或清除播放状态", async () => {
  const h = screenFor(undefined, { playbackSession: { ...session, acceptedPositionMs: 2000 } });
  await h.screen.onLearningPlay(h.event);
  assert.equal(h.player.currentTime, 2);
  await h.screen.onLearningSeeking(h.event);
  await h.screen.onLearningSeeked(h.event);
  assert.deepEqual(h.calls.filter(x => x.body?.type).map(x => x.body.type), ["START"]);
  assert.equal(h.screen.learningPlaybackState().playing, true);
});

test("native ended前的pause不先关闭服务端播放状态", async () => {
  const h = screenFor(); await h.screen.onLearningPlay(h.event);
  h.player.currentTime = 6; h.player.paused = true; h.player.ended = true;
  await h.screen.onLearningPause(h.event);
  await h.screen.onLearningEnded(h.event);
  assert.deepEqual(h.calls.filter(x => x.body?.type).map(x => x.body.type), ["START", "ENDED"]);
});