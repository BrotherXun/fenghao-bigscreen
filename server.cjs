const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { createGatewayAccess, boundedNumber, GatewayError } = require("./gateway-access.cjs");

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
const gatewayAccess = createGatewayAccess(apiBase);

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
    let rejected = false;
    request.on("data", (chunk) => {
      if (rejected) return;
      received += chunk.length;
      if (received > assistantMaxBodyBytes) {
        rejected = true;
        reject(new Error("请求内容过大。"));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (_) {
        reject(new Error("请求必须是有效的 JSON。"));
      }
    });
    request.on("error", reject);
    request.on("aborted", () => reject(new Error("请求已取消。")));
  });
}

function normaliseAssistantMessages(input) {
  if (!Array.isArray(input) || input.length === 0) throw new Error("messages 为必填字段，且不能为空。");
  const messages = input
    .filter((message) => message && ["user", "assistant"].includes(message.role) && typeof message.content === "string")
    .map((message) => ({ role: message.role, content: message.content.trim() }))
    .filter((message) => message.content);
  if (!messages.length) throw new Error("messages 中缺少可用内容。");
  if (messages.some(message => message.content.length > 8000)) throw new Error("单条问题或历史回答过长。");
  return [{ role: "system", content: assistantSystemPrompt }, ...messages.slice(-9)];
}

async function proxyAssistantChat(request, response, principal) {
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
    if (!/^application\/json(?:;|$)/i.test(String(request.headers['content-type'] || ''))) {
      throw new Error("请求必须使用 application/json。");
    }
    body = await readAssistantJson(request);
    messages = normaliseAssistantMessages(body.messages);
  } catch (error) {
    sendAssistantJson(response, 400, { error: { code: "invalid_parameter", message: error.message } });
    return;
  }

  if (request.aborted || response.destroyed) return;
  if (principal.expiresAt <= Date.now()) {
    throw new GatewayError(410, 'ERR_SCREEN_ACCESS_EXPIRED', '本次大屏会话已到期，请重新开始。');
  }
  const release = gatewayAccess.acquire('chat', principal.deviceId);
  try { gatewayAccess.checkStartRate('chat', principal.deviceId); }
  catch (error) { release(); throw error; }
  const controller = new AbortController();
  const lifetime = Math.max(1, Math.min(boundedNumber(process.env.FENGHAO_ASSISTANT_TIMEOUT_MS, 120000, 100, 300000), principal.expiresAt - Date.now()));
  const timeout = setTimeout(() => controller.abort(), lifetime);
  const cancel = () => controller.abort();
  response.on('close', cancel);
  request.on('aborted', cancel);
  try {
    const extensionOptions = {
      enable_processing_state: true,
      enable_followup_in_response: true,
      card_position: "meta_frame",
    };
    const browsingMode = Number(process.env.VOLC_BROWSING_MODE);
    if (Number.isFinite(browsingMode)) extensionOptions.browsing_mode = browsingMode;
    const upstreamBody = JSON.stringify({
      bot_id: process.env.VOLC_BOT_ID,
      messages,
      stream: true,
      user_id: process.env.VOLC_USER_ID || "fenghao-screen-terminal",
      extension_options: extensionOptions,
    });
    if (principal.expiresAt <= Date.now()) {
      throw new GatewayError(410, 'ERR_SCREEN_ACCESS_EXPIRED', '本次大屏会话已到期，请重新开始。');
    }
    const upstream = await fetch(assistantEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.VOLC_API_KEY}`,
        "Content-Type": "application/json",
        ServiceName: "ask_echo",
      },
      body: upstreamBody,
      signal: controller.signal,
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      sendAssistantJson(response, 502, { error: {
        code: "agent_upstream_error", message: "智能体服务返回异常，请检查服务端配置与权限。", upstream_status: upstream.status,
      } });
      return;
    }
    response.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    if (upstream.body) for await (const chunk of upstream.body) {
      if (controller.signal.aborted || response.destroyed) break;
      if (!response.write(chunk)) {
        await new Promise(resolve => {
          const ready = () => {
            response.off('drain', ready); response.off('close', ready);
            controller.signal.removeEventListener('abort', ready); resolve();
          };
          response.once('drain', ready); response.once('close', ready);
          controller.signal.addEventListener('abort', ready, { once: true });
          if (controller.signal.aborted) ready();
        });
      }
    }
    response.end();
  } catch (error) {
    if (response.destroyed) return;
    if (error instanceof GatewayError) throw error;
    const message = controller.signal.aborted ? "智能体服务响应超时，请重试。" : "无法连接智能体服务。";
    if (!response.headersSent) sendAssistantJson(response, 502, { error: { code: "agent_unavailable", message } });
    else response.destroy();
  } finally {
    clearTimeout(timeout); response.off('close', cancel); request.off('aborted', cancel); release();
  }
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
  try {
  const requestUrl = new URL(request.url, "http://localhost");
  const pathname = requestUrl.pathname;
  if (request.method === "GET" && pathname === "/api/v1/assistant/status") {
    await gatewayAccess.authenticateRequest(request);
    sendAssistantJson(response, 200, {
      configured: assistantConfigured(),
      mode: assistantConfigured() ? "volcengine" : "unconfigured",
      agent: "networked-qa",
      speech: speechConfigured(),
      speaker: process.env.VOLC_TTS_SPEAKER || "ICL_uranus_zh_female_chengshujiejie_tob",
    });
    return;
  }
  if (request.method === "POST" && pathname === "/api/v1/assistant/chat") {
    const principal = await gatewayAccess.authenticateRequest(request);
    if (request.aborted || response.destroyed) return;
    await proxyAssistantChat(request, response, principal);
    return;
  }
  if (pathname.startsWith("/api/v1/") || pathname.startsWith("/files/")) {
    proxy(request, response);
    return;
  }
  staticFile(request, response);
  } catch (error) {
    if (response.destroyed) return;
    if (response.headersSent) { response.destroy(); return; }
    sendAssistantJson(response, error.status || 500, { error: {
      code: error.code || 'gateway_error', message: error.status ? error.message : '大屏服务暂不可用，请稍后重试。', retryable: false,
    } });
  }
});
server.requestTimeout = 30000;

async function startServer() {
  try {
    const { attachVoiceBridge } = await import("./voice/bridge.mjs");
    attachVoiceBridge(server, process.env, gatewayAccess);
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
