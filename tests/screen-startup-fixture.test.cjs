const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");

test("startup fixture serves original and current real runtime on loopback without backend access", async (t) => {
  const fixturePath = path.join(__dirname, "helpers/screen-startup-http.cjs");
  assert.equal(fs.existsSync(fixturePath), true, "local startup fixture must exist");
  const { createStartupFixture } = require(fixturePath);
  const events = [];
  const server = createStartupFixture({ delayMs: 80, log: (event) => events.push(event) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal(server.address().address, "127.0.0.1");
  const request = (url, options) => fetch(origin + url, { ...options, signal: AbortSignal.timeout(5000) });
  const oldPage = await (await request("/old/normal/screen.html")).text();
  const newPage = await (await request("/new/normal/screen.html")).text();
  assert.match(oldPage, /<main id="screenApp" class="term">/);
  assert.doesNotMatch(oldPage, /screen-startup-guard/);
  assert.match(newPage, /screen-startup-guard/);
  const normalVue = await request("/new/normal/vendor/vue.global.prod.js");
  const normalBytes = Buffer.from(await normalVue.arrayBuffer());
  assert.deepEqual(normalBytes, fs.readFileSync(path.join(__dirname, "../public/vendor/vue.global.prod.js")));
  const start = Date.now();
  const delayed = await request("/new/delay/vendor/vue.global.prod.js");
  assert.ok(Date.now() - start >= 65, "delay fixture actually holds the runtime response");
  assert.deepEqual(Buffer.from(await delayed.arrayBuffer()), normalBytes);
  const slowAbort = new AbortController();
  const abortTimer = setTimeout(() => slowAbort.abort(), 60);
  try {
    await assert.rejects(fetch(origin + "/new/slow/vendor/vue.global.prod.js", { signal: slowAbort.signal }), { name: "AbortError" });
  } finally { clearTimeout(abortTimer); }
  assert.ok(events.some((entry) => entry.event === "request" && entry.path === "/new/slow/vendor/vue.global.prod.js"));
  assert.equal(events.some((entry) => entry.event === "response" && entry.path === "/new/slow/vendor/vue.global.prod.js"), false);
  assert.equal((await request("/new/fail/vendor/vue.global.prod.js")).status, 503);
  assert.equal((await request("/new/normal/.env")).status, 404);
  assert.equal((await request("/api/v1/assistant/status")).status, 401);
  assert.equal((await request("/api/v1/screen-sessions", { method: "POST", body: "must-not-be-logged" })).status, 503);
  assert.ok(events.some((entry) => entry.path === "/api/*"));
  assert.doesNotMatch(JSON.stringify(events), /must-not-be-logged/);
  const wrongHost = await new Promise((resolve, reject) => {
    const req = http.get(origin + "/new/normal/screen.js", { headers: { Host: "external.invalid" } }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode));
    });
    req.once("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("fixture request timeout")));
  });
  assert.equal(wrongHost, 403);
});
