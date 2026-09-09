const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const publicDir = path.join(__dirname, "../public");
const html = fs.readFileSync(path.join(publicDir, "screen.html"), "utf8");
const runtimePaths = ["vendor/vue.global.prod.js", "api.js", "screen-voice.js", "screen.js"];

// This small DOM model exercises the real inline guard, not Vue rendering.
// The companion local HTTP fixture lets a browser execute the unmodified Vue runtime.
function startup() {
  const listeners = new Map(), timers = new Map(), elements = new Map();
  let reloads = 0;
  for (const match of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const [, tagName, attributes, id] = match;
    const handlers = new Map();
    elements.set(id, {
      tagName: tagName.toUpperCase(), hidden: /(?:^|\s)hidden(?:\s|=|$)/.test(attributes),
      textContent: "", addEventListener(name, handler) { handlers.set(name, handler); },
      click() { handlers.get("click")?.(); },
    });
  }
  const window = {
    location: { href: "http://127.0.0.1:4192/screen.html", reload() { reloads++; } },
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name, handler) { if (listeners.get(name) === handler) listeners.delete(name); },
  };
  const inline = html.match(/<script\b[^>]*\bid="screen-startup-guard"[^>]*>([\s\S]*?)<\/script>/);
  if (inline) vm.runInNewContext(inline[1], {
    window, document: { getElementById(id) { return elements.get(id) || null; } }, URL,
    setTimeout(fn, delay) { const id = timers.size + 1; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  return {
    window, elements, timers, listeners,
    guard: window.FenghaoScreenStartup,
    get reloads() { return reloads; },
    error(event) { listeners.get("error")?.(event); },
    el(id) { const value = elements.get(id); assert.ok(value, `missing startup element ${id}`); return value; },
  };
}

test("uncompiled Vue content is hidden even when author CSS sets display", () => {
  const state = startup();
  assert.equal(state.el("screenApp").hidden, true);
  assert.match(html, /#screenApp\[hidden\][^{]*\{\s*display:\s*none\s*!important\s*;/);
  assert.equal(state.el("screenStartup").hidden, false);
  assert.match(html, /<noscript>[\s\S]*JavaScript[\s\S]*刷新[\s\S]*<\/noscript>/);
});

test("mascot image, poster and video URLs are only bound after Vue mounts", () => {
  const media = [...html.matchAll(/<(?:img|video|source)\b[^>]*assistant-(?:woman|mascot)[^>]*>/g)].map((m) => m[0]);
  assert.equal(media.length, 4);
  for (const tag of media) assert.doesNotMatch(tag, /\s(?:src|poster)\s*=/);
  assert.match(media[0], /:src="'\.\/assets\/safety-assistant-woman-speaking-hd\.png'"/);
  assert.match(media[1], /:src="'\.\/assets\/safety-assistant-woman-thinking-hd\.png'"/);
  assert.match(media[2], /:poster="'\.\/assets\/safety-assistant-woman-speaking-hd\.png'"/);
  assert.match(media[2], /muted loop playsinline preload="metadata"/);
  assert.match(media[3], /:src="'\.\/assets\/safety-assistant-woman-speaking-loop\.webm'"/);
  for (const tag of media.slice(0, 2)) assert.match(tag, /width="1644" height="1800"/);
});

test("startup guard precedes the four original scripts in their dependency order", () => {
  const guardIndex = html.indexOf('id="screen-startup-guard"');
  assert.ok(guardIndex >= 0, "an inline guard must run before network-dependent scripts");
  const scripts = [...html.matchAll(/<script\b([^>]*)\bsrc="([^"]+)"[^>]*>/g)];
  assert.deepEqual(scripts.map((m) => m[2].split("?")[0].replace(/^\.\//, "")), runtimePaths);
  for (const script of scripts) {
    assert.ok(guardIndex < script.index);
    assert.match(script[0], /\bdata-screen-runtime\b/);
  }
});

for (const script of runtimePaths) {
  test(`failed ${script} is explicit and blocks first mount`, () => {
    const state = startup();
    state.error({ target: { tagName: "SCRIPT", src: new URL(script, state.window.location.href).href,
      hasAttribute(name) { return name === "data-screen-runtime"; } } });
    assert.equal(state.el("screenStartupRetry").hidden, false);
    assert.match(state.el("screenStartupMessage").textContent, /失败/);
    assert.equal(state.guard.canMount(), false);
    state.guard.ready();
    assert.equal(state.el("screenApp").hidden, true);
  });
}

test("an exception in a startup script cannot reveal a partly mounted app", () => {
  const state = startup();
  state.error({ target: state.window, filename: "http://127.0.0.1:4192/screen.js?v=13" });
  assert.equal(state.el("screenStartupRetry").hidden, false);
  assert.equal(state.guard.canMount(), false);
  assert.equal(state.el("screenApp").hidden, true);
});

test("only startup scripts affect startup failure", () => {
  const state = startup();
  state.error({ target: { tagName: "IMG", hasAttribute() { return false; } } });
  state.error({ target: state.window, filename: "http://127.0.0.1:4192/other.js" });
  assert.ok(state.guard, "startup guard is installed");
  assert.equal(state.guard.canMount(), true);
  assert.equal(state.el("screenStartupRetry").hidden, true);
});

test("timeout offers manual recovery but a late successful mount still becomes ready once", () => {
  const state = startup();
  const timeout = [...state.timers.values()].find((entry) => entry.delay === 30000);
  assert.ok(timeout, "startup needs a bounded 30 second deadline");
  timeout.fn();
  assert.match(state.el("screenStartupMessage").textContent, /超时/);
  assert.equal(state.el("screenStartupSpinner").hidden, true);
  assert.equal(state.el("screenStartupRetry").hidden, false);
  assert.equal(state.guard.canMount(), true);
  state.guard.ready();
  assert.equal(state.el("screenApp").hidden, false);
  assert.equal(state.el("screenStartup").hidden, true);
  assert.equal(state.el("screenStartupMessage").textContent, "");
  assert.equal(state.timers.size, 0);
  assert.equal(state.listeners.has("error"), false);
  assert.equal(state.guard.canMount(), false, "ready app must not mount again");
  state.guard.ready();
  timeout.fn();
  state.error({ target: state.window, filename: "http://127.0.0.1:4192/screen.js" });
  assert.equal(state.el("screenStartup").hidden, true);
});

test("manual recovery only reloads the current document and does not replay requests", () => {
  const state = startup();
  state.error({ target: state.window, filename: "http://127.0.0.1:4192/api.js" });
  state.el("screenStartupRetry").click();
  assert.equal(state.reloads, 1);
  assert.equal(state.guard.canMount(), false);
  assert.equal(state.el("screenApp").hidden, true);
});

test("screen.js notifies ready only after successful mount and obeys a fatal startup failure", () => {
  const source = fs.readFileSync(path.join(publicDir, "screen.js"), "utf8");
  for (const mode of ["normal", "blocked", "throw"]) {
    const calls = [];
    const context = {
      Vue: { createApp() { return { mount() { calls.push("mount"); if (mode === "throw") throw new Error("mount failed"); } }; } },
      window: { FenghaoScreenStartup: { canMount: () => mode !== "blocked", ready() { calls.push("ready"); } } },
    };
    if (mode === "throw") assert.throws(() => vm.runInNewContext(source, context), /mount failed/);
    else vm.runInNewContext(source, context);
    assert.deepEqual(calls, mode === "normal" ? ["mount", "ready"] : mode === "blocked" ? [] : ["mount"]);
  }
});
