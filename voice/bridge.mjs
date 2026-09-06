// 浏览器语音通道的桥接层。
// 浏览器只连一条 WebSocket；服务端在其上分别开火山的识别会话与合成会话。
// API Key 只存在于服务端，浏览器永远拿不到。
//
// 上行：二进制帧 = PCM16/16k 音频；JSON 帧 = 控制指令。
// 下行：二进制帧 = PCM16/24k 合成音频；JSON 帧 = 识别结果与状态。

import { WebSocketServer } from "ws";
import { AsrSession } from "./asr.mjs";
import { TtsSession } from "./tts.mjs";

const ASR_SAMPLE_RATE = 16000;
const TTS_SAMPLE_RATE = 24000;

function normaliseSpeedRatio(value, fallback) {
  const requested = Number(value);
  const configured = Number(fallback);
  const ratio = Number.isFinite(requested) ? requested : (Number.isFinite(configured) ? configured : 1.2);
  return Math.round(Math.min(1.6, Math.max(0.8, ratio)) * 10) / 10;
}

export function speechConfigured(env) {
  return Boolean(env.VOLC_SPEECH_APP_ID && env.VOLC_SPEECH_ACCESS_TOKEN);
}

function credentials(env) {
  return {
    appId: env.VOLC_SPEECH_APP_ID,
    accessToken: env.VOLC_SPEECH_ACCESS_TOKEN,
    userId: env.VOLC_USER_ID || "fenghao-local-admin"
  };
}

class VoiceConnection {
  constructor(socket, env) {
    this.socket = socket;
    this.env = env;
    this.asr = null;
    this.tts = null;
    this.ttsGeneration = 0;
    this.closed = false;
  }

  sendJson(payload) {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  sendBinary(chunk) {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(chunk, { binary: true });
    }
  }

  fail(scope, error) {
    this.sendJson({
      type: "error",
      scope,
      message: error && error.message || "语音服务出现未知错误。"
    });
  }

  async startAsr() {
    this.stopAsr();
    const session = new AsrSession({
      ...credentials(this.env),
      resourceId: this.env.VOLC_ASR_RESOURCE_ID || "volc.bigasr.sauc.duration",
      endpoint: this.env.VOLC_ASR_ENDPOINT,
      sampleRate: ASR_SAMPLE_RATE,
      onPartial: (text) => this.sendJson({ type: "asr_partial", text }),
      onFinal: (text) => {
        this.sendJson({ type: "asr_final", text });
        if (this.asr === session) {
          this.asr = null;
        }
      },
      onError: (error) => {
        this.fail("asr", error);
        if (this.asr === session) {
          this.asr = null;
        }
      }
    });
    this.asr = session;
    try {
      await session.open();
      if (!session.closed && this.asr === session) {
        this.sendJson({ type: "asr_ready" });
      }
    } catch (error) {
      if (!session.closed && this.asr === session) {
        this.fail("asr", error);
      }
      if (this.asr === session) {
        this.asr = null;
      }
    }
  }

  stopAsr() {
    if (this.asr) {
      this.asr.close();
      this.asr = null;
    }
  }

  async startTts(speedRatio) {
    this.cancelTts();
    this.ttsGeneration += 1;
    const generation = this.ttsGeneration;
    const session = new TtsSession({
      ...credentials(this.env),
      cluster: this.env.VOLC_TTS_CLUSTER || "volcano_tts",
      endpoint: this.env.VOLC_TTS_ENDPOINT,
      speaker: this.env.VOLC_TTS_SPEAKER || "ICL_uranus_zh_female_chengshujiejie_tob",
      format: "pcm",
      sampleRate: TTS_SAMPLE_RATE,
      speedRatio: normaliseSpeedRatio(speedRatio, this.env.VOLC_TTS_SPEED_RATIO),
      // 打断后仍可能有在途音频，用代次号丢弃过期会话的数据。
      onAudio: (chunk) => {
        if (generation === this.ttsGeneration) {
          this.sendBinary(chunk);
        }
      },
      onFinish: () => {
        if (generation === this.ttsGeneration) {
          this.sendJson({ type: "tts_end" });
        }
      },
      onError: (error) => {
        if (generation === this.ttsGeneration) {
          this.fail("tts", error);
          this.sendJson({ type: "tts_end" });
        }
      }
    });
    this.tts = session;
    try {
      await session.open();
      if (generation === this.ttsGeneration && !session.closed) {
        this.sendJson({ type: "tts_begin", sampleRate: TTS_SAMPLE_RATE });
      }
    } catch (error) {
      if (generation === this.ttsGeneration && !session.closed) {
        this.fail("tts", error);
        this.sendJson({ type: "tts_end" });
      }
      if (this.tts === session) {
        this.tts = null;
      }
    }
  }

  cancelTts() {
    this.ttsGeneration += 1;
    if (this.tts) {
      this.tts.close();
      this.tts = null;
    }
  }

  handleControl(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    switch (message.type) {
      case "asr_start":
        this.startAsr();
        break;
      case "asr_stop":
        if (this.asr) {
          this.asr.finish();
        }
        break;
      case "asr_abort":
        this.stopAsr();
        break;
      case "tts_start":
        this.startTts(message.speedRatio);
        break;
      case "tts_text":
        if (this.tts) {
          this.tts.speak(message.text);
        }
        break;
      case "tts_end":
        if (this.tts) {
          this.tts.finish();
        }
        break;
      case "tts_cancel":
        this.cancelTts();
        this.sendJson({ type: "tts_end" });
        break;
      default:
        break;
    }
  }

  dispose() {
    this.closed = true;
    this.stopAsr();
    this.cancelTts();
  }
}

export function attachVoiceBridge(server, env) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (socket) => {
    const connection = new VoiceConnection(socket, env);
    connection.sendJson({
      type: "hello",
      asrSampleRate: ASR_SAMPLE_RATE,
      ttsSampleRate: TTS_SAMPLE_RATE,
      speaker: env.VOLC_TTS_SPEAKER || "ICL_uranus_zh_female_chengshujiejie_tob"
    });

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        if (connection.asr) {
          connection.asr.sendAudio(data);
        }
        return;
      }
      connection.handleControl(data.toString("utf8"));
    });

    socket.on("close", () => connection.dispose());
    socket.on("error", () => connection.dispose());
  });

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url || "/", "http://localhost");
    if (pathname !== "/ws/voice") {
      socket.destroy();
      return;
    }
    if (!speechConfigured(env)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit("connection", client, request);
    });
  });

  return wss;
}
