// 火山引擎「大模型流式语音识别」客户端。
// 文档：https://www.volcengine.com/docs/6561/1354869
// 要点：payload 必须 gzip；首包为配置帧 sequence=1；音频包序列号递增；
// 最后一包用负序列号标记流结束，否则服务端不会吐出最终结果。

import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { COMPRESSION, FLAG, MESSAGE_TYPE, SERIALIZATION, decodeFrame, encodeFrame } from "./frame.mjs";

const ASR_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";

export class AsrSession {
  constructor(options) {
    this.options = options;
    this.socket = null;
    this.sequence = 1;
    this.finished = false;
    this.closed = false;
    this.text = "";
    this.onPartial = options.onPartial || (() => {});
    this.onFinal = options.onFinal || (() => {});
    this.onError = options.onError || (() => {});
  }

  open() {
    return new Promise((resolve, reject) => {
      const endpoint = this.options.endpoint || ASR_ENDPOINT;
      let settled = false;
      const socket = new WebSocket(endpoint, {
        headers: {
          "X-Api-App-Key": this.options.appId,
          "X-Api-Access-Key": this.options.accessToken,
          "X-Api-Resource-Id": this.options.resourceId,
          "X-Api-Connect-Id": randomUUID()
        },
        handshakeTimeout: 8000
      });
      this.socket = socket;

      socket.on("open", () => {
        // 用户可能在握手期间已经打断。此时不能提前 close()：ws 会把
        // “WebSocket was closed before the connection was established”当成错误抛出。
        if (this.closed) {
          settled = true;
          try { socket.close(); } catch { /* 连接已可安全关闭 */ }
          reject(new Error("语音识别请求已取消。"));
          return;
        }
        try {
          socket.send(this.buildConfigFrame());
          settled = true;
          resolve();
        } catch (error) {
          settled = true;
          reject(error);
        }
      });

      socket.on("message", (data) => this.handleMessage(data));

      socket.on("error", (error) => {
        if (this.closed) {
          if (!settled) {
            settled = true;
            reject(new Error("语音识别请求已取消。"));
          }
          return;
        }
        const failure = new Error("语音识别连接失败：" + (error && error.message || "未知错误"));
        if (!settled) {
          settled = true;
          reject(failure);
          return;
        }
        this.onError(failure);
      });

      socket.on("close", () => {
        const cancelled = this.closed;
        this.closed = true;
        if (!settled) {
          settled = true;
          reject(new Error(cancelled ? "语音识别请求已取消。" : "语音识别连接被服务端关闭。"));
        }
      });
    });
  }

  buildConfigFrame() {
    const payload = {
      user: { uid: this.options.userId || "fenghao-local-admin" },
      audio: {
        format: "pcm",
        codec: "raw",
        rate: this.options.sampleRate || 16000,
        bits: 16,
        channel: 1
      },
      request: {
        model_name: "bigmodel",
        enable_punc: true,
        enable_itn: true,
        show_utterances: true
      }
    };
    return encodeFrame({
      messageType: MESSAGE_TYPE.FULL_CLIENT_REQUEST,
      flags: FLAG.POSITIVE_SEQUENCE,
      serialization: SERIALIZATION.JSON,
      compression: COMPRESSION.GZIP,
      sequence: this.sequence,
      payload: Buffer.from(JSON.stringify(payload), "utf8")
    });
  }

  ready() {
    return Boolean(this.socket) && this.socket.readyState === WebSocket.OPEN && !this.finished;
  }

  sendAudio(chunk) {
    if (!this.ready()) {
      return;
    }
    this.sequence += 1;
    this.socket.send(encodeFrame({
      messageType: MESSAGE_TYPE.AUDIO_ONLY_REQUEST,
      flags: FLAG.POSITIVE_SEQUENCE,
      serialization: SERIALIZATION.NONE,
      compression: COMPRESSION.GZIP,
      sequence: this.sequence,
      payload: chunk
    }));
  }

  // 结束本段语音：负序列号包是拿到最终结果的唯一触发条件。
  finish() {
    if (!this.ready()) {
      return;
    }
    this.finished = true;
    this.sequence += 1;
    this.socket.send(encodeFrame({
      messageType: MESSAGE_TYPE.AUDIO_ONLY_REQUEST,
      flags: FLAG.NEGATIVE_SEQUENCE,
      serialization: SERIALIZATION.NONE,
      compression: COMPRESSION.GZIP,
      sequence: -this.sequence,
      payload: Buffer.alloc(0)
    }));
  }

  handleMessage(data) {
    let frame;
    try {
      frame = decodeFrame(data);
    } catch (error) {
      this.onError(new Error("语音识别返回帧解析失败：" + error.message));
      return;
    }

    if (frame.messageType === MESSAGE_TYPE.ERROR_INFORMATION) {
      const detail = frame.payload.toString("utf8").slice(0, 200);
      this.onError(new Error("语音识别服务报错（" + frame.errorCode + "）：" + detail));
      this.close();
      return;
    }

    const result = frame.json && frame.json.result;
    if (result && typeof result.text === "string" && result.text !== this.text) {
      this.text = result.text;
      this.onPartial(this.text);
    }

    // 负序列号的响应即最后一帧，此时 text 为完整结果。
    if (frame.isLast || (typeof frame.sequence === "number" && frame.sequence < 0)) {
      this.onFinal(this.text);
      this.close();
    }
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // CONNECTING 状态不能直接 close；等 open 回调后再关闭，避免把用户打断
    // 误报成 WebSocket 建连失败。
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.close();
      } catch {
        // 关闭失败不影响主流程。
      }
    }
  }
}
