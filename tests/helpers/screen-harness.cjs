const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function loadScreen(handleRequest = async () => ({}), config = {}) {
  let options;
  const calls = [], intervals = new Map(), storage = new Map(config.storage || []), sessionStorage = config.sessionStorage || new Map(), historyCalls = [];
  const origin = "http://test.invalid";
  const sandbox = {
    URL, URLSearchParams, AbortController, TextDecoder, Uint8Array, Date,
    crypto: config.crypto || require("node:crypto").webcrypto,
    location: { origin, pathname: "/screen.html", search: config.search || "", href: origin + "/screen.html" + (config.search || ""), hash: config.hash || "" },
    history: { replaceState(_state, _unused, url) { historyCalls.push(url); } },
    localStorage: { getItem(key) { return storage.get(key) || null; }, setItem(key, value) { storage.set(key, String(value)); }, removeItem(key) { storage.delete(key); } },
    sessionStorage: { getItem(key) { return sessionStorage.get(key) || null; }, setItem(key, value) { if (config.storageBlocked) throw new Error("Storage blocked"); sessionStorage.set(key, String(value)); }, removeItem(key) { sessionStorage.delete(key); } },
    setInterval(fn, delay) { const id = intervals.size + 1; intervals.set(id, { fn, delay }); return id; },
    clearInterval(id) { intervals.delete(id); }, setTimeout, clearTimeout,
    window: { createVoice: config.createVoice },
    Vue: { createApp(value) { options = value; return { mount() {} }; } },
    async fetch(url, init = {}) {
      const call = { url, ...init, body: init.body ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const data = await handleRequest(call);
      if (data?.rawResponse) return data.rawResponse;
      return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ success: true, data }) };
    },
  };
  vm.createContext(sandbox);
  const publicDir = path.join(__dirname, "../../public");
  vm.runInContext(fs.readFileSync(path.join(publicDir, "api.js"), "utf8"), sandbox);
  sandbox.FenghaoApi = sandbox.window.FenghaoApi;
  vm.runInContext(fs.readFileSync(path.join(publicDir, "screen.js"), "utf8"), sandbox);
  const screen = Object.assign(options.data(), { $refs: {}, $nextTick(fn) { return Promise.resolve().then(fn); } });
  for (const [name, method] of Object.entries(options.methods)) screen[name] = method.bind(screen);
  for (const [name, getter] of Object.entries(options.computed)) Object.defineProperty(screen, name, { get: () => getter.call(screen) });
  return { screen, calls, intervals, storage, sessionStorage, historyCalls, options, api: sandbox.FenghaoApi };
}

module.exports = { deferred, loadScreen };
