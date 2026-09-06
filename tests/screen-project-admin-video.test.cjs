const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const screenSource = fs.readFileSync(path.join(__dirname, "../public/screen.js"), "utf8");
const screenHtml = fs.readFileSync(path.join(__dirname, "../public/screen.html"), "utf8");
const screenCss = fs.readFileSync(path.join(__dirname, "../public/screen.css"), "utf8");

function jsonResponse(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => "application/json" },
    async json() { return body; },
  };
}

function loadScreen(fetchImpl, config = {}) {
  let options;
  const storage = new Map();
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
    document: config.document,
    localStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, String(value)); },
    },
    location: { search: "", origin: "http://127.0.0.1:4173" },
    window: { FenghaoApi: { apiBase: "" } },
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

test("大屏提供独立的项目管理员登录和视频查看入口", () => {
  assert.match(screenHtml, /项目管理员登录/);
  assert.match(screenHtml, /登录后可查看当前项目的培训视频/);
  assert.match(screenHtml, /培训视频查看/);
  assert.match(screenHtml, /视频查看/);
  assert.match(screenHtml, /toggleAdminVideoFullscreen/);
  assert.match(screenHtml, /admin-video-content-grid/);
  assert.match(screenCss, /100cqh/);
  assert.match(screenHtml, /type="password"/);
});

test("项目管理员登录后只用当前内存令牌读取 VIDEO 资源", async () => {
  const requests = [];
  const screen = loadScreen(async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).includes("/admin/auth/login")) {
      return jsonResponse({
        success: true,
        data: {
          token: "project-token",
          username: "project-admin",
          name: "项目管理员",
          role: "PROJECT_ADMIN",
          tenantName: "丰浩建筑集团",
          projectId: "PRJ-001",
        },
      });
    }
    return jsonResponse({
      success: true,
      data: [{
        resourceId: "RES-VIDEO-1",
        type: "VIDEO",
        title: "高处作业安全教育",
        theme: "高处作业",
        category: "三级教育",
        url: "/files/videos/high-place.mp4",
        durationSec: 125,
        processingStatus: "READY",
      }],
    });
  });

  screen.adminLoginForm.username = "project-admin";
  screen.adminLoginForm.password = "secret";
  await screen.submitAdminLogin();

  assert.equal(screen.adminSession.token, "project-token");
  assert.equal(screen.adminLoginForm.password, "");
  assert.equal(screen.adminVideoOpen, true);
  assert.equal(screen.adminSelectedVideo.resourceId, "RES-VIDEO-1");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "/api/v1/admin/auth/login");
  assert.equal(requests[1].url, "/api/v1/admin/training-resources?type=VIDEO");
  assert.equal(requests[1].init.headers.Authorization, "Bearer project-token");
  assert.equal(screen.safeAdminVideoUrl("/files/videos/high-place.mp4"), "http://127.0.0.1:4173/files/videos/high-place.mp4");
  assert.equal(screen.safeAdminVideoUrl("javascript:alert(1)"), "");
  assert.equal(screen.isAdminVideoPlayable(screen.adminSelectedVideo), true);
});

test("平台管理员和未就绪视频不会被当作大屏可查看项目视频", () => {
  const screen = loadScreen(async () => jsonResponse({ success: true, data: {} }));
  assert.equal(screen.isProjectAdminRole("PLATFORM_ADMIN"), false);
  assert.equal(screen.isProjectAdminRole("PROJECT_ADMIN"), true);
  assert.equal(screen.isAdminVideoPlayable({ url: "/files/a.mp4", processingStatus: "PROCESSING" }), false);
  assert.equal(screen.adminVideoUnavailableReason({ url: "/files/a.mp4", processingStatus: "FAILED" }), "视频处理失败，请在项目管理后台重新检查资源。");
});

test("项目培训视频可进入和退出浏览器全屏", async () => {
  const listeners = new Map();
  const fakeDocument = {
    fullscreenElement: null,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    async exitFullscreen() {
      this.fullscreenElement = null;
      listeners.get("fullscreenchange")?.();
    },
  };
  const screen = loadScreen(async () => jsonResponse({ success: true, data: {} }), { document: fakeDocument });
  screen.adminVideos = [{
    resourceId: "RES-VIDEO-1",
    type: "VIDEO",
    title: "高处作业安全教育",
    url: "/files/videos/high-place.mp4",
    processingStatus: "READY",
  }];
  screen.adminSelectedVideoId = "RES-VIDEO-1";
  const player = { pause() {} };
  const frame = {
    contains(element) { return element === player; },
    async requestFullscreen() {
      fakeDocument.fullscreenElement = frame;
      listeners.get("fullscreenchange")?.();
    },
  };
  screen.$refs = { adminVideoFrame: frame, adminVideoPlayer: player };
  screen.bindAdminVideoFullscreenEvents();

  await screen.toggleAdminVideoFullscreen();
  assert.equal(fakeDocument.fullscreenElement, frame);
  assert.equal(screen.adminVideoFullscreen, true);

  await screen.toggleAdminVideoFullscreen();
  assert.equal(fakeDocument.fullscreenElement, null);
  assert.equal(screen.adminVideoFullscreen, false);
});

test("项目培训视频在 WebKit 视频全屏接口下仍可播放", async () => {
  const screen = loadScreen(async () => jsonResponse({ success: true, data: {} }));
  screen.adminVideos = [{
    resourceId: "RES-VIDEO-1",
    type: "VIDEO",
    title: "高处作业安全教育",
    url: "/files/videos/high-place.mp4",
    processingStatus: "READY",
  }];
  screen.adminSelectedVideoId = "RES-VIDEO-1";
  let enteredFullscreen = false;
  const player = {
    pause() {},
    webkitEnterFullscreen() { enteredFullscreen = true; },
  };
  screen.$refs = { adminVideoFrame: {}, adminVideoPlayer: player };

  await screen.toggleAdminVideoFullscreen();
  assert.equal(enteredFullscreen, true);
  assert.equal(screen.adminVideoFullscreen, true);
});
