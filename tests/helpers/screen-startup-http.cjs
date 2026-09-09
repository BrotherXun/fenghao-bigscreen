// Local browser fixture only. No backend/cloud proxy, credentials or persisted business data.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "../..");
const baseline = "2c46e33f04421291f2b253018c5bb9ceaac294e3";
const files = ["screen.html", "screen.css", "screen.js", "api.js", "screen-voice.js", "pcm-worklet.js",
  "vendor/vue.global.prod.js", "assets/safety-assistant-woman-speaking-hd.png",
  "assets/safety-assistant-woman-thinking-hd.png", "assets/safety-assistant-woman-speaking-loop.webm"];
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8", ".png": "image/png", ".webm": "video/webm" };

function createStartupFixture({ delayMs = 35000, log = () => {} } = {}) {
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60000) throw new Error("fixture delay out of range");
  const started = Date.now();
  const snapshots = { old: new Map(), new: new Map() };
  for (const file of files) {
    const current = fs.readFileSync(path.join(root, "public", file));
    snapshots.new.set(file, current);
    snapshots.old.set(file, ["screen.html", "screen.js"].includes(file)
      ? execFileSync("git", ["show", `${baseline}:public/${file}`], { cwd: root, windowsHide: true, maxBuffer: 1024 * 1024 })
      : current);
  }
  const server = http.createServer((req, res) => {
    let safePath = "rejected";
    const send = (status, body, type = "text/plain; charset=utf-8") => {
      if (res.destroyed) return;
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
      res.writeHead(status, { "Content-Type": type, "Content-Length": bytes.length, "Cache-Control": "no-store" });
      res.end(bytes);
      log({ timeMs: Date.now() - started, event: "response", path: safePath, status, bytes: bytes.length });
    };
    if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== `127.0.0.1:${server.address().port}`) {
      return send(403, "loopback fixture only");
    }
    let url;
    try { url = new URL(req.url, `http://${req.headers.host}`); }
    catch (_) { return send(400, "invalid fixture URL"); }
    if (url.pathname.startsWith("/api/")) {
      safePath = "/api/*";
      log({ timeMs: Date.now() - started, event: "request", path: safePath, method: req.method });
      req.resume();
      return send(url.pathname === "/api/v1/assistant/status" ? 401 : 503,
        JSON.stringify({ success: false, message: "启动测试不连接后端或云服务。" }), "application/json");
    }
    const match = url.pathname.match(/^\/(old|new)\/(normal|delay|fail)\/(.+)$/);
    if (!match || !files.includes(match[3]) || req.method !== "GET") return send(404, "fixture path not found");
    const [, version, mode, file] = match;
    safePath = `/${version}/${mode}/${file}`;
    log({ timeMs: Date.now() - started, event: "request", path: safePath, method: req.method });
    if (file === "vendor/vue.global.prod.js" && mode === "fail") return send(503, "deliberate local Vue load failure");
    const respond = () => send(200, snapshots[version].get(file), types[path.extname(file)]);
    if (file === "vendor/vue.global.prod.js" && mode === "delay") {
      const timer = setTimeout(respond, delayMs);
      res.once("close", () => clearTimeout(timer));
    } else respond();
  });
  server.on("upgrade", (_req, socket) => socket.destroy());
  return server;
}

if (require.main === module) {
  const server = createStartupFixture({ log: (event) => process.stdout.write(JSON.stringify(event) + "\n") });
  server.listen(4192, "127.0.0.1", () => {
    process.stdout.write("Startup fixture: http://127.0.0.1:4192/new/normal/screen.html\n");
    process.stdout.write("Variants: old/new; modes: normal/delay (35s Vue)/fail (503 Vue). No backend/cloud.\n");
  });
  const close = () => { server.closeAllConnections(); server.close(); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

module.exports = { createStartupFixture };
