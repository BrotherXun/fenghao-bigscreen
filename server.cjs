const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { Readable } = require("node:stream");

const publicRoot = path.resolve(__dirname, "public");
const assistantEnvFiles = [
  process.env.FENGHAO_ASSISTANT_ENV,
  path.resolve(__dirname, ".env"),
].filter(Boolean);
const assistantMaxBodyBytes = 1024 * 1024;
const assistantSystemPrompt = "你是丰浩安全培训助手，只回答施工和工程安全相关问题。主要通过语音播报服务现场工人：回答口语化、短句、先说最关键且可执行的动作。除非用户明确要求展开，默认只用1至3句、80字以内；不用Markdown、表格、链接、长清单或客套话。涉及立即风险时，先说停止作业、撤离危险区域、报告现场负责人；只有在适用时才提示断电。信息不足时，只追问一个最必要的问题。超出范围时，用一句话说明只能解答施工和工程安全问题。";

loadAssistantEnvironment();

const port = Number.parseInt(process.env.FENGHAO_MANAGEMENT_PORT || "4173", 10);
const listenHost = process.env.FENGHAO_MANAGEMENT_HOST || "127.0.0.1";
const apiBase = new URL(process.env.FENGHAO_API_BASE || "http://127.0.0.1:8080");
if (!["http:", "https:"].includes(apiBase.protocol)) throw new Error("FENGHAO_API_BASE must use HTTP or HTTPS");
const proxyClient = apiBase.protocol === "https:" ? https : http;

const assistantEndpoint = process.env.VOLC_AGENT_ENDPOINT || "https://open.feedcoopapi.com/agent_api/agent/chat/completion";
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".webp", "image/webp"],
  [".webm", "video/webm"],
  [".mp4", "video/mp4"],
]);

function send(response, statusCode, contentType, body) {
  const value = Buffer.isBuffer(body) ? body : Buffer.from(body);
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": value.length,
  });
  response.end(value);
}

function sendAssistantJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function loadAssistantEnvironment() {
  for (const envFile of assistantEnvFiles) {
    try {
      const source = fs.readFileSync(envFile, "utf8");
      source.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return;
        const separator = trimmed.indexOf("=");
        if (separator < 1) return;
        const key = trimmed.slice(0, separator).trim();
        let value = trimmed.slice(separator + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (key && !process.env[key]) process.env[key] = value;
      });
    } catch (error) {
      if (error.code !== "ENOENT") console.warn("无法读取安全问答配置文件，将仅使用当前环境变量。");
    }
  }
}

function assistantConfigured() {
  return Boolean(process.env.VOLC_BOT_ID && process.env.VOLC_API_KEY);
}

function speechConfigured() {
  return Boolean(process.env.VOLC_SPEECH_APP_ID && process.env.VOLC_SPEECH_ACCESS_TOKEN);
}

function readAssistantJson(request) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      received += chunk.length;
      if (received > assistantMaxBodyBytes) {
        reject(new Error("请求内容过大。"));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (_) {
        reject(new Error("请求必须是有效的 JSON。"));
      }
    });
    request.on("error", reject);
  });
}

function normaliseAssistantMessages(input) {
  if (!Array.isArray(input) || input.length === 0) throw new Error("messages 为必填字段，且不能为空。");
  const messages = input
    .filter((message) => message && ["user", "assistant"].includes(message.role) && typeof message.content === "string")
    .map((message) => ({ role: message.role, content: message.content.trim() }))
    .filter((message) => message.content);
  if (!messages.length) throw new Error("messages 中缺少可用内容。");
  return [{ role: "system", content: assistantSystemPrompt }, ...messages.slice(-9)];
}

async function proxyAssistantChat(request, response) {
  if (!assistantConfigured()) {
    sendAssistantJson(response, 503, {
      error: {
        code: "local_config_missing",
        message: "本地问答服务尚未配置 VOLC_BOT_ID 与 VOLC_API_KEY。",
      },
    });
    return;
  }

  let body;
  let messages;
  try {
    body = await readAssistantJson(request);
    messages = normaliseAssistantMessages(body.messages);
  } catch (error) {
    sendAssistantJson(response, 400, { error: { code: "invalid_parameter", message: error.message } });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  let upstream;
  try {
    const extensionOptions = {
      enable_processing_state: true,
      enable_followup_in_response: true,
      card_position: "meta_frame",
    };
    const browsingMode = Number(process.env.VOLC_BROWSING_MODE);
    if (Number.isFinite(browsingMode)) extensionOptions.browsing_mode = browsingMode;
    upstream = await fetch(assistantEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.VOLC_API_KEY}`,
        "Content-Type": "application/json",
        ServiceName: "ask_echo",
      },
      body: JSON.stringify({
        bot_id: process.env.VOLC_BOT_ID,
        messages,
        stream: true,
        user_id: process.env.VOLC_USER_ID || "fenghao-screen-terminal",
        extension_options: extensionOptions,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const message = error.name === "AbortError" ? "智能体服务响应超时。" : "无法连接智能体服务。";
    sendAssistantJson(response, 502, { error: { code: "agent_unavailable", message } });
    return;
  } finally {
    clearTimeout(timeout);
  }

  if (!upstream.ok) {
    sendAssistantJson(response, 502, {
      error: {
        code: "agent_upstream_error",
        message: "智能体服务返回异常，请检查本地 BOT_ID、API Key 与权限配置。",
        upstream_status: upstream.status,
      },
    });
    return;
  }

  response.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") || "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (!upstream.body) {
    response.end();
    return;
  }
  Readable.fromWeb(upstream.body).on("error", () => response.end()).pipe(response);
}

function proxy(request, response) {
  const target = new URL(`${apiBase.origin}${request.url}`);
  const headers = { ...request.headers, host: apiBase.host };
  delete headers.connection;

  const upstream = proxyClient.request({
    protocol: apiBase.protocol,
    hostname: apiBase.hostname,
    port: apiBase.port || undefined,
    method: request.method,
    path: `${target.pathname}${target.search}`,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", (error) => {
    if (!response.headersSent) {
      send(response, 502, "application/json; charset=utf-8", JSON.stringify({
        success: false,
        code: "PROXY_ERROR",
        message: `后端接口连接失败：${error.message}`,
      }));
    } else {
      response.destroy(error);
    }
  });
  request.pipe(upstream);
}

function staticFile(request, response) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch (_) {
    send(response, 400, "text/plain; charset=utf-8", "Bad request");
    return;
  }
  if (pathname === "/") pathname = "/screen.html";
  if (pathname.split("/").some((part) => part.startsWith("."))) {
    send(response, 404, "text/plain; charset=utf-8", "Not found");
    return;
  }

  let file = path.resolve(publicRoot, `.${pathname}`);
  if (file !== publicRoot && !file.startsWith(`${publicRoot}${path.sep}`)) {
    send(response, 404, "text/plain; charset=utf-8", "Not found");
    return;
  }
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  } catch (_) {
    send(response, 404, "text/plain; charset=utf-8", "Not found");
    return;
  }

  const contentType = contentTypes.get(path.extname(file).toLowerCase())
    || "application/octet-stream";
  response.writeHead(200, { "Content-Type": contentType });
  const stream = fs.createReadStream(file);
  stream.on("error", () => {
    if (!response.headersSent) send(response, 500, "text/plain; charset=utf-8", "Read failed");
    else response.destroy();
  });
  stream.pipe(response);
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, "http://localhost");
  const pathname = requestUrl.pathname;
  if (request.method === "GET" && pathname === "/api/v1/assistant/status") {
    sendAssistantJson(response, 200, {
      configured: assistantConfigured(),
      mode: assistantConfigured() ? "volcengine" : "demo",
      agent: "networked-qa",
      speech: speechConfigured(),
      speaker: process.env.VOLC_TTS_SPEAKER || "ICL_uranus_zh_female_chengshujiejie_tob",
    });
    return;
  }
  if (request.method === "POST" && pathname === "/api/v1/assistant/chat") {
    await proxyAssistantChat(request, response);
    return;
  }
  if (pathname.startsWith("/api/v1/") || pathname.startsWith("/files/")) {
    proxy(request, response);
    return;
  }
  staticFile(request, response);
});

async function startServer() {
  try {
    const { attachVoiceBridge } = await import("./voice/bridge.mjs");
    attachVoiceBridge(server, process.env);
  } catch (error) {
    console.error(`安全问答语音模块加载失败：${error.message}`);
    process.exitCode = 1;
    return;
  }

  server.listen(port, listenHost, () => {
    console.log(`Fenghao bigscreen: http://${listenHost}:${server.address().port}/screen.html`);
    console.log(`Backend proxy: ${apiBase.origin}`);
    console.log(speechConfigured() ? "安全问答语音已启用。" : "安全问答语音未配置。");
  });
}

startServer();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
