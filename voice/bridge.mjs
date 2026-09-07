// 浏览器语音通道的桥接层。
// 浏览器只连一条 WebSocket；服务端在其上分别开火山的识别会话与合成会话。
// API Key 只存在于服务端，浏览器永远拿不到。
//
// 上行：二进制帧 = PCM16/16k 音频；JSON 帧 = 控制指令。
// 下行：二进制帧 = PCM16/24k 合成音频；JSON 帧 = 识别结果与状态。

import { WebSocketServer } from "ws";
import { AsrSession } from "./asr.mjs";
import { TtsSession } from "./tts.mjs";
import gatewayModule from "../gateway-access.cjs";

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
  constructor(socket, env, access) {
    this.socket = socket;
    this.env = env;
    this.asr = null;
    this.tts = null;
    this.ttsGeneration = 0;
    this.closed = false;
    this.access = access;
    this.principal = null;
    this.authenticating = false;
    this.releaseAccess = null;
    this.asrRequest = 0;
    this.ttsRequest = 0;
    this.ttsRequestId = undefined;
    this.ttsCharacters = 0;
    this.audioBytes = 0;
    this.lastActivity = Date.now();
    const authTimeout = gatewayModule.boundedNumber(env.FENGHAO_VOICE_AUTH_TIMEOUT_MS, 5000, 100, 30000);
    this.authTimer = setTimeout(() => this.rejectAccess(new Error('设备认证超时，请重新连接。')), authTimeout);
    this.authTimer.unref();
    this.idleTimer = setInterval(() => {
      if (Date.now() - this.lastActivity > 90000) this.rejectAccess(new Error('语音连接已空闲，请重新开始聆听。'));
    }, 30000);
    this.idleTimer.unref();
  }

  sendJson(payload) {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  sendBinary(chunk) {
    if (this.socket.readyState === this.socket.OPEN) {
      if (this.socket.bufferedAmount > 1024 * 1024) {
        this.rejectAccess(new Error('语音接收速度过慢，请重新连接。'));
        return;
      }
      this.socket.send(chunk, { binary: true });
    }
  }

  fail(scope, error, requestId) {
    this.sendJson({
      type: "error",
      scope,
      message: error && error.message || "语音服务出现未知错误。",
      retryable: scope === 'asr' || scope === 'tts',
      requestId,
    });
  }

  async startAsr() {
    this.stopAsr();
    this.audioBytes = 0;
    const session = new AsrSession({
      ...credentials(this.env),
      resourceId: this.env.VOLC_ASR_RESOURCE_ID || "volc.bigasr.sauc.duration",
      endpoint: this.env.VOLC_ASR_ENDPOINT,
      sampleRate: ASR_SAMPLE_RATE,
      onPartial: (text) => { if (this.asr === session && !this.closed) this.sendJson({ type: "asr_partial", text }); },
      onFinal: (text) => {
        if (this.asr === session && !this.closed) {
          this.sendJson({ type: "asr_final", text });
          this.asr = null;
        }
      },
      onError: (error) => {
        if (this.asr === session && !this.closed) {
          this.fail("asr", error);
          session.close();
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
      if (!this.closed && this.asr === session) {
        this.fail("asr", error);
        session.close();
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

  async startTts(speedRatio, requestId) {
    this.cancelTts();
    this.ttsGeneration += 1;
    const generation = this.ttsGeneration;
    this.ttsCharacters = 0;
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
          this.sendJson({ type: "tts_end", requestId });
        }
      },
      onError: (error) => {
        if (generation === this.ttsGeneration) {
          this.fail("tts", error, requestId);
          if (this.tts === session) this.tts = null;
        }
      }
    });
    this.tts = session;
    try {
      await session.open();
      if (generation === this.ttsGeneration && !session.closed) {
        this.sendJson({ type: "tts_begin", sampleRate: TTS_SAMPLE_RATE, requestId });
      }
    } catch (error) {
      if (generation === this.ttsGeneration && !session.closed) {
        this.fail("tts", error, requestId);
        session.close();
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

  rejectAccess(error) {
    if (this.closed) return;
    this.sendJson({ type: 'error', scope: 'auth', code: error.code || 'voice_access_denied',
      message: error.message || '语音访问不可用。', retryable: false });
    this.dispose();
    this.socket.close(1008, 'voice access denied');
  }

  async authenticate(message) {
    if (this.principal || this.authenticating) throw new Error('设备认证状态无效。');
    this.authenticating = true;
    const principal = await this.access.authenticate(message.deviceId, message.deviceToken);
    if (this.closed) return;
    this.releaseAccess = this.access.acquire('voice', principal.deviceId, 2);
    this.principal = principal;
    clearTimeout(this.authTimer);
    this.sendJson({ type: 'authenticated', asrSampleRate: ASR_SAMPLE_RATE, ttsSampleRate: TTS_SAMPLE_RATE });
  }

  async handleControl(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      throw new Error('语音控制消息必须是有效 JSON。');
    }
    if (!message || typeof message.type !== 'string') throw new Error('语音控制消息无效。');
    this.lastActivity = Date.now();
    if (message.type === 'authenticate') { await this.authenticate(message); return; }
    if (!this.principal) throw new Error('请先认证设备，再使用语音服务。');
    if (message.type === 'asr_start' || message.type === 'tts_start') {
      if (message.type === 'tts_start') {
        if (message.requestId !== undefined && (typeof message.requestId !== 'string' || message.requestId.length > 80)) {
          throw new Error('语音合成请求标识无效。');
        }
        this.ttsRequestId = message.requestId;
      }
      const counter = message.type === 'asr_start' ? 'asrRequest' : 'ttsRequest';
      const generation = ++this[counter];
      await this.access.authenticate(this.principal.deviceId, this.principal.deviceToken);
      if (this.closed || this[counter] !== generation) return;
      this.access.checkStartRate(message.type, this.principal.deviceId, 60);
      if (message.type === 'asr_start') await this.startAsr();
      else await this.startTts(message.speedRatio, message.requestId);
      return;
    }
    switch (message.type) {
      case "asr_stop":
        if (this.asr) {
          this.asr.finish();
        }
        break;
      case "asr_abort":
        this.asrRequest++;
        this.stopAsr();
        break;
      case "tts_text":
        if (typeof message.text !== 'string' || message.text.length > 2000
          || (this.ttsCharacters += message.text.length) > 12000) throw new Error('语音文本过长，请缩短问题。');
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
        this.ttsRequest++;
        this.cancelTts();
        this.sendJson({ type: "tts_end", requestId: this.ttsRequestId });
        break;
      default:
        break;
    }
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.authTimer);
    clearInterval(this.idleTimer);
    if (this.releaseAccess) this.releaseAccess();
    this.principal = null;
    this.stopAsr();
    this.cancelTts();
  }
}

export function attachVoiceBridge(server, env, access) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });

  wss.on("connection", (socket) => {
    const connection = new VoiceConnection(socket, env, access);
    connection.sendJson({
      type: "hello",
      asrSampleRate: ASR_SAMPLE_RATE,
      ttsSampleRate: TTS_SAMPLE_RATE,
      speaker: env.VOLC_TTS_SPEAKER || "ICL_uranus_zh_female_chengshujiejie_tob"
    });

    socket.on("message", (data, isBinary) => {
      if (connection.closed) return;
      if (isBinary) {
        if (!connection.principal) { connection.rejectAccess(new Error('请先认证设备。')); return; }
        connection.lastActivity = Date.now();
        connection.audioBytes += data.length;
        if (connection.audioBytes > ASR_SAMPLE_RATE * 2 * 120) {
          connection.rejectAccess(new Error('单次语音过长，请分段提问。')); return;
        }
        if (connection.asr) {
          try { connection.asr.sendAudio(data); }
          catch (error) { connection.fail('asr', error); connection.stopAsr(); }
        }
        return;
      }
      connection.handleControl(data.toString("utf8")).catch(error => connection.rejectAccess(error));
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
    try { access.checkOrigin(request, true); }
    catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    if (wss.clients.size >= 128) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
    if (!speechConfigured(env)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit("connection", client, request);
    });
  });

  server.on('close', () => { for (const client of wss.clients) client.terminate(); wss.close(); });

  return wss;
}
