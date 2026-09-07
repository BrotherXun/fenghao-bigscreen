// 火山引擎语音合成客户端（v1 ws_binary 协议）。
// 文档：https://www.volcengine.com/docs/6561/79820
//
// 为什么不用 v3 双向流式：v3 需要 volc.service_type.* 资源授权，实测该账号未开通（403
// requested resource not granted）；而 v1 的 cluster=volcano_tts 通道可用且支持同一批大模型音色。
//
// v1 是「一次连接一次合成」：发一次请求，音频流式回来，收到负序列号包即结束。
// 因此这里维护一个句子队列，并在当前句合成期间预开下一条连接，
// 让握手时间藏在上一句的播放里——否则每句都要多等一次握手。

import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { WebSocket } from "ws";

const TTS_ENDPOINT = "wss://openspeech.bytedance.com/api/v1/tts/ws_binary";
const MESSAGE_TYPE_AUDIO = 0xb;
const MESSAGE_TYPE_ERROR = 0xf;

function decodeTtsFrame(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buffer.length < 4) throw new Error("帧头长度不足。");
  const headerSize = (buffer[0] & 0x0f) * 4;
  if (headerSize < 4 || headerSize > buffer.length) throw new Error("帧头长度无效。");
  const messageType = buffer[1] >> 4;
  const flags = buffer[1] & 0x0f;
  const compression = buffer[2] & 0x0f;
  if (messageType !== MESSAGE_TYPE_ERROR && (messageType !== MESSAGE_TYPE_AUDIO || flags === 0)) {
    return null; // 无序列号的确认帧，无音频负载。
  }
  if (buffer.length - headerSize < 8) throw new Error("序列号或负载长度字段不完整。");
  const value = messageType === MESSAGE_TYPE_ERROR
    ? buffer.readUInt32BE(headerSize)
    : buffer.readInt32BE(headerSize);
  const size = buffer.readUInt32BE(headerSize + 4);
  const offset = headerSize + 8;
  if (size > buffer.length - offset) throw new Error("声明的负载长度超过实际数据。");
  let body = buffer.subarray(offset, offset + size);
  if (messageType === MESSAGE_TYPE_ERROR) {
    if (compression === 1) body = gunzipSync(body);
    return { error: new Error("语音合成服务报错（" + value + "）：" + body.toString("utf8").slice(0, 200)) };
  }
  return { sequence: value, body };
}

export class TtsSession {
  constructor(options) {
    this.options = options;
    this.queue = [];
    this.idle = null;          // 已建好、等待派活的连接
    this.active = null;        // 正在合成的连接
    this.connecting = new Set(); // 正在握手，不能在 CONNECTING 时直接关闭
    this.closed = false;
    this.finishRequested = false;
    const requestedSpeed = Number(options.speedRatio);
    this.speedRatio = Number.isFinite(requestedSpeed) ? requestedSpeed : 1.2;
    this.onAudio = options.onAudio || (() => {});
    this.onError = options.onError || (() => {});
    this.onFinish = options.onFinish || (() => {});
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(this.options.endpoint || TTS_ENDPOINT, {
        headers: { Authorization: "Bearer; " + this.options.accessToken },
        handshakeTimeout: 8000
      });
      socket.binaryType = "nodebuffer";
      this.connecting.add(socket);
      socket.on("open", () => {
        this.connecting.delete(socket);
        if (this.closed) {
          settled = true;
          try { socket.close(); } catch { /* 连接已可安全关闭 */ }
          reject(new Error("语音合成请求已取消。"));
          return;
        }
        settled = true;
        resolve(socket);
      });
      socket.on("error", (error) => {
        this.connecting.delete(socket);
        if (this.closed) {
          if (!settled) {
            settled = true;
            reject(new Error("语音合成请求已取消。"));
          }
          return;
        }
        if (!settled) {
          settled = true;
          reject(new Error("语音合成连接失败：" + (error && error.message || "未知错误")));
        }
      });
      socket.on("close", () => {
        this.connecting.delete(socket);
        if (!settled) {
          settled = true;
          reject(new Error(this.closed ? "语音合成请求已取消。" : "语音合成连接被服务端关闭。"));
        }
      });
    });
  }

  async open() {
    const socket = await this.connect();
    if (this.closed) {
      try { socket.close(); } catch { /* 连接已可安全关闭 */ }
      return false;
    }
    this.idle = socket;
    return true;
  }

  // 预开下一条连接，把握手藏在当前句的合成与播放里。
  prefetch() {
    if (this.closed || this.idle) {
      return;
    }
    this.connect().then(
      (socket) => {
        if (this.closed) {
          try { socket.close(); } catch { /* 忽略 */ }
          return;
        }
        this.idle = socket;
        this.pump();
      },
      () => { /* 预开失败不报错，真正派活时会重试 */ }
    );
  }

  buildRequest(text) {
    const payload = gzipSync(Buffer.from(JSON.stringify({
      app: {
        appid: this.options.appId,
        token: this.options.accessToken,
        cluster: this.options.cluster || "volcano_tts"
      },
      user: { uid: this.options.userId || "fenghao-local-admin" },
      audio: {
        voice_type: this.options.speaker,
        encoding: this.options.format || "pcm",
        rate: this.options.sampleRate || 24000,
        speed_ratio: this.speedRatio
      },
      request: {
        reqid: randomUUID(),
        text,
        operation: "submit"
      }
    }), "utf8"));
    const size = Buffer.alloc(4);
    size.writeUInt32BE(payload.length, 0);
    // header: 版本1/头长1 | 消息类型 full client request、无标志 | JSON + gzip | 保留
    return Buffer.concat([Buffer.from([0x11, 0x10, 0x11, 0x00]), size, payload]);
  }

  speak(text) {
    const content = String(text || "").trim();
    if (!content || this.closed) {
      return;
    }
    this.queue.push(content);
    this.pump();
  }

  pump() {
    if (this.closed || this.active || !this.queue.length) {
      return;
    }
    if (!this.idle) {
      this.prefetch();
      return;
    }
    const socket = this.idle;
    this.idle = null;
    this.active = socket;
    const text = this.queue.shift();

    socket.on("message", (data) => this.handleAudio(socket, data));
    socket.on("error", (error) => {
      this.fail(socket, new Error("语音合成传输失败：" + (error && error.message || "未知错误")));
    });
    socket.on("close", () => {
      this.fail(socket, new Error("语音合成连接已关闭，未收到完整音频。"));
    });

    try {
      socket.send(this.buildRequest(text));
    } catch (error) {
      this.fail(socket, new Error("语音合成请求发送失败：" + error.message));
      return;
    }
    this.prefetch();
  }

  handleAudio(socket, data) {
    if (this.closed || this.active !== socket) return;
    let frame;
    try {
      frame = decodeTtsFrame(data);
    } catch (error) {
      this.fail(socket, new Error("语音合成返回帧解析失败：" + error.message));
      return;
    }
    if (!frame) return;
    if (frame.error) {
      this.fail(socket, frame.error);
      return;
    }
    if (frame.body.length) {
      this.onAudio(frame.body);
    }
    // 负序列号 = 本句最后一包
    if (frame.sequence < 0) {
      this.release(socket);
    }
  }

  fail(socket, error) {
    if (this.closed || this.active !== socket) return;
    // 失败终止整次合成；release 仅用于负序列号正常结束，避免错误后仍通知成功。
    this.close();
    this.onError(error);
  }

  release(socket) {
    if (this.active !== socket) {
      return;
    }
    this.active = null;
    if (socket.readyState === WebSocket.OPEN) {
      try { socket.close(); } catch { /* 忽略 */ }
    }
    if (this.queue.length) {
      this.pump();
      return;
    }
    if (this.finishRequested && !this.closed) {
      this.closed = true;
      this.dropIdle();
      this.onFinish();
    }
  }

  dropIdle() {
    if (this.idle) {
      if (this.idle.readyState === WebSocket.OPEN) {
        try { this.idle.close(); } catch { /* 忽略 */ }
      }
      this.idle = null;
    }
  }

  finish() {
    if (this.closed) {
      return;
    }
    this.finishRequested = true;
    // 队列已排空且没有在合成的句子，直接收口。
    if (!this.active && !this.queue.length) {
      this.closed = true;
      this.dropIdle();
      this.onFinish();
    }
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.queue.length = 0;
    this.dropIdle();
    if (this.active) {
      if (this.active.readyState === WebSocket.OPEN) {
        try { this.active.close(); } catch { /* 忽略 */ }
      }
      this.active = null;
    }
  }
}
