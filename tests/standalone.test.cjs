const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

test("独立 API 使用设备令牌和同源请求，并传播后端鉴权错误", async () => {
  const calls = [];
  let rejected = false;
  const context = { window: {}, fetch: async (url, options) => {
    calls.push({ url, options });
    return { ok: !rejected, status: rejected ? 401 : 200,
      json: async () => rejected ? { success: false, message: "设备令牌无效" } : { success: true, data: { sessionId: "S1" } } };
  }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/api.js"), "utf8"), context);
  const api = context.window.FenghaoApi;
  assert.equal((await api.createScreenSession("D1", "test-token")).sessionId, "S1");
  assert.equal(calls[0].url, "/api/v1/screen-sessions");
  assert.equal(calls[0].options.headers["X-Screen-Device-Token"], "test-token");
  assert.equal(calls[0].options.body, '{"deviceId":"D1"}');
  rejected = true;
  await assert.rejects(api.screenSession("S1", "bad-token"), { message: "设备令牌无效", status: 401 });
});

test("独立网关启动、首页、媒体类型、配置隔离和业务代理", async (t) => {
  const backend = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ path: req.url, token: req.headers["x-screen-device-token"],
      success: true, data: { deviceId: "D1" } }));
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  t.after(() => { backend.closeAllConnections(); backend.close(); });
  const env = { ...process.env, FENGHAO_MANAGEMENT_PORT: "0", FENGHAO_MANAGEMENT_HOST: "127.0.0.1",
    FENGHAO_API_BASE: "http://127.0.0.1:" + backend.address().port,
    FENGHAO_ASSISTANT_ENV: "", VOLC_BOT_ID: "", VOLC_API_KEY: "", VOLC_SPEECH_APP_ID: "", VOLC_SPEECH_ACCESS_TOKEN: "" };
  const child = spawn(process.execPath, ["server.cjs"], { cwd: path.join(__dirname, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  });
  const origin = await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("网关启动超时")), 10000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error("启动退出: " + code)); });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/Fenghao bigscreen: (http:\/\/127\.0\.0\.1:\d+)\/screen.html/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  const home = await fetch(origin);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /扫码学习/);
  const video = await fetch(origin + "/assets/safety-assistant-woman-speaking-loop.webm");
  assert.equal(video.headers.get("content-type"), "video/webm");
  assert.ok((await video.arrayBuffer()).byteLength > 1000);
  assert.equal((await fetch(origin + "/.env")).status, 404);
  assert.equal((await fetch(origin + "/admin.html")).status, 404);
  assert.equal((await fetch(origin + "/api/v1/assistant/status")).status, 401);
  const status = await (await fetch(origin + "/api/v1/assistant/status", { headers: {
    "X-Screen-Device-ID": "D1", "X-Screen-Device-Token": "test-token"
  } })).json();
  assert.equal(status.configured, false);
  assert.equal(status.speech, false);
  const proxied = await (await fetch(origin + "/api/v1/screen-devices/D1/config", { headers: { "X-Screen-Device-Token": "test-token" } })).json();
  assert.deepEqual(proxied, { path: "/api/v1/screen-devices/D1/config", token: "test-token",
    success: true, data: { deviceId: "D1" } });
});
