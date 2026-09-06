// 火山引擎语音服务 V3 二进制帧协议。
// 大模型流式语音识别与语音合成大模型共用同一套帧头，差别只在可选字段的组合：
// 识别用「序列号」，合成用「事件号 + 会话 ID」。所有整数均为大端。
//
// 帧结构：
//   byte0  高4位 protocol version(0b0001) | 低4位 header size(0b0001，单位 4 字节)
//   byte1  高4位 message type            | 低4位 message type specific flags
//   byte2  高4位 serialization method     | 低4位 compression type
//   byte3  保留
//   ...    可选字段（event / session id / sequence，按下方顺序）
//   ...    payload size (uint32) + payload

import { gzipSync, gunzipSync } from "node:zlib";

export const MESSAGE_TYPE = {
  FULL_CLIENT_REQUEST: 0x1,
  AUDIO_ONLY_REQUEST: 0x2,
  FULL_SERVER_RESPONSE: 0x9,
  AUDIO_ONLY_RESPONSE: 0xb,
  ERROR_INFORMATION: 0xf
};

export const FLAG = {
  NONE: 0x0,
  POSITIVE_SEQUENCE: 0x1,
  LAST_NO_SEQUENCE: 0x2,
  NEGATIVE_SEQUENCE: 0x3,
  WITH_EVENT: 0x4
};

export const SERIALIZATION = { NONE: 0x0, JSON: 0x1 };
export const COMPRESSION = { NONE: 0x0, GZIP: 0x1 };

export const EVENT = {
  START_CONNECTION: 1,
  FINISH_CONNECTION: 2,
  CONNECTION_STARTED: 50,
  CONNECTION_FAILED: 51,
  CONNECTION_FINISHED: 52,
  START_SESSION: 100,
  FINISH_SESSION: 102,
  SESSION_STARTED: 150,
  SESSION_FINISHED: 152,
  SESSION_FAILED: 153,
  TASK_REQUEST: 200,
  TTS_SENTENCE_START: 350,
  TTS_SENTENCE_END: 351,
  TTS_RESPONSE: 352
};

// 连接级事件不携带会话 ID，其余事件都携带。
const CONNECTION_SCOPE_EVENTS = new Set([
  EVENT.START_CONNECTION,
  EVENT.FINISH_CONNECTION,
  EVENT.CONNECTION_STARTED,
  EVENT.CONNECTION_FAILED,
  EVENT.CONNECTION_FINISHED
]);

const PROTOCOL_HEADER_BYTE = 0x11; // version 1 + header size 1

function hasSequenceField(flags) {
  return (flags & 0x01) !== 0 || (flags & 0x03) === FLAG.NEGATIVE_SEQUENCE;
}

export function encodeFrame(options) {
  const {
    messageType,
    flags = FLAG.NONE,
    serialization = SERIALIZATION.JSON,
    compression = COMPRESSION.NONE,
    sequence = null,
    event = null,
    sessionId = null,
    payload = Buffer.alloc(0)
  } = options;

  const body = compression === COMPRESSION.GZIP ? gzipSync(payload) : Buffer.from(payload);
  const parts = [Buffer.from([PROTOCOL_HEADER_BYTE, (messageType << 4) | flags, (serialization << 4) | compression, 0x00])];

  if ((flags & FLAG.WITH_EVENT) !== 0 && event !== null) {
    const eventBuffer = Buffer.alloc(4);
    eventBuffer.writeInt32BE(event, 0);
    parts.push(eventBuffer);
    if (!CONNECTION_SCOPE_EVENTS.has(event)) {
      const idBuffer = Buffer.from(String(sessionId || ""), "utf8");
      const idSize = Buffer.alloc(4);
      idSize.writeUInt32BE(idBuffer.length, 0);
      parts.push(idSize, idBuffer);
    }
  } else if (sequence !== null) {
    const sequenceBuffer = Buffer.alloc(4);
    sequenceBuffer.writeInt32BE(sequence, 0);
    parts.push(sequenceBuffer);
  }

  const sizeBuffer = Buffer.alloc(4);
  sizeBuffer.writeUInt32BE(body.length, 0);
  parts.push(sizeBuffer, body);
  return Buffer.concat(parts);
}

export function decodeFrame(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length < 4) {
    throw new Error("语音服务返回的帧长度不足。");
  }

  const headerSize = (buffer[0] & 0x0f) * 4;
  const messageType = buffer[1] >> 4;
  const flags = buffer[1] & 0x0f;
  const serialization = buffer[2] >> 4;
  const compression = buffer[2] & 0x0f;

  const result = {
    messageType,
    flags,
    serialization,
    compression,
    event: null,
    sessionId: null,
    sequence: null,
    errorCode: null,
    payload: Buffer.alloc(0),
    json: null,
    isLast: (flags & 0x03) === FLAG.NEGATIVE_SEQUENCE || (flags & 0x03) === FLAG.LAST_NO_SEQUENCE
  };

  let offset = headerSize;
  const readUInt32 = () => {
    const value = buffer.readUInt32BE(offset);
    offset += 4;
    return value;
  };
  const readInt32 = () => {
    const value = buffer.readInt32BE(offset);
    offset += 4;
    return value;
  };

  if (messageType === MESSAGE_TYPE.ERROR_INFORMATION) {
    result.errorCode = readUInt32();
  } else if ((flags & FLAG.WITH_EVENT) !== 0) {
    result.event = readInt32();
    if (!CONNECTION_SCOPE_EVENTS.has(result.event)) {
      const idLength = readUInt32();
      result.sessionId = buffer.subarray(offset, offset + idLength).toString("utf8");
      offset += idLength;
    }
  } else if (hasSequenceField(flags)) {
    result.sequence = readInt32();
  }

  if (offset + 4 <= buffer.length) {
    const payloadSize = readUInt32();
    const raw = buffer.subarray(offset, offset + payloadSize);
    result.payload = compression === COMPRESSION.GZIP && raw.length ? gunzipSync(raw) : Buffer.from(raw);
  }

  if (result.payload.length && serialization === SERIALIZATION.JSON) {
    try {
      result.json = JSON.parse(result.payload.toString("utf8"));
    } catch {
      result.json = null;
    }
  }

  return result;
}
