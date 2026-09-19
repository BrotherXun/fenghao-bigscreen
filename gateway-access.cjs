// Paid assistant access requires a live token session in the Java device registry.
class GatewayError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : fallback;
}

function createGatewayAccess(apiBase, env = process.env) {
  const active = new Map();
  const starts = new Map();
  const configuredOrigin = env.FENGHAO_PUBLIC_ORIGIN ? new URL(env.FENGHAO_PUBLIC_ORIGIN).origin : null;
  let totalActive = 0;

  function checkOrigin(request, required = false) {
    const supplied = request.headers.origin;
    if (!supplied && !required) return;
    const expected = configuredOrigin || `${request.socket.encrypted ? 'https' : 'http'}://${request.headers.host}`;
    if (!supplied || supplied === 'null' || supplied !== expected) {
      throw new GatewayError(403, 'origin_forbidden', '请从已配置的大屏地址访问语音问答。');
    }
  }

  async function authenticate(deviceId, deviceToken) {
    if (typeof deviceId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(deviceId)
      || typeof deviceToken !== 'string' || !deviceToken || deviceToken.length > 512 || /\s/.test(deviceToken)) {
      throw new GatewayError(401, 'ERR_SCREEN_ACCESS_INVALID', '请使用新的大屏访问 token 链接。');
    }
    let response;
    let payload;
    try {
      response = await fetch(new URL(`/api/v1/screen-devices/${encodeURIComponent(deviceId)}/config`, apiBase), {
        headers: { 'X-Screen-Device-Token': deviceToken, Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      payload = await response.json().catch(() => null);
    } catch {
      throw new GatewayError(503, 'device_auth_unavailable', '设备认证服务暂不可用，请稍后重试。');
    }
    if (response.status >= 500) throw new GatewayError(503, 'device_auth_unavailable', '设备认证服务暂不可用，请稍后重试。');
    if (response.status === 410 || payload?.code === 'ERR_SCREEN_ACCESS_EXPIRED') {
      throw new GatewayError(410, 'ERR_SCREEN_ACCESS_EXPIRED', '本次大屏会话已到期，请重新开始。');
    }
    if (!response.ok || payload?.success !== true || payload.data?.deviceId !== deviceId) {
      throw new GatewayError(401, 'ERR_SCREEN_ACCESS_INVALID', '大屏授权已失效，请使用新的大屏访问 token 链接。');
    }
    const expiresAt = Date.parse(payload.data.accessExpiresAt);
    if (typeof payload.data.accessSessionId !== 'string' || !payload.data.accessSessionId || !Number.isFinite(expiresAt)) {
      throw new GatewayError(401, 'ERR_SCREEN_ACCESS_INVALID', '请使用新的大屏访问 token 链接。');
    }
    if (expiresAt <= Date.now()) throw new GatewayError(410, 'ERR_SCREEN_ACCESS_EXPIRED', '本次大屏会话已到期，请重新开始。');
    return { deviceId, deviceToken, accessSessionId: payload.data.accessSessionId, expiresAt };
  }

  async function authenticateRequest(request) {
    checkOrigin(request);
    return authenticate(request.headers['x-screen-device-id'], request.headers['x-screen-device-token']);
  }

  function acquire(kind, deviceId, perDevice = 1) {
    const key = `${kind}:${deviceId}`;
    if ((active.get(key) || 0) >= perDevice || totalActive >= 128) {
      throw new GatewayError(429, 'assistant_busy', '当前设备已有进行中的请求，请结束后重试。');
    }
    active.set(key, (active.get(key) || 0) + 1); totalActive++;
    let released = false;
    return () => {
      if (released) return;
      released = true; totalActive--;
      const remaining = active.get(key) - 1;
      if (remaining) active.set(key, remaining); else active.delete(key);
    };
  }

  function checkStartRate(kind, deviceId, maximum = 30) {
    const now = Date.now();
    for (const [key, row] of starts) if (row.expires <= now) starts.delete(key);
    const key = `${kind}:${deviceId}`;
    const row = starts.get(key) || { count: 0, expires: now + 60000 };
    if (row.count >= maximum || (!starts.has(key) && starts.size >= 2048)) {
      throw new GatewayError(429, 'assistant_rate_limited', '请求过于频繁，请稍后再试。');
    }
    row.count++; starts.set(key, row);
  }

  return { authenticate, authenticateRequest, checkOrigin, acquire, checkStartRate };
}

module.exports = { createGatewayAccess, GatewayError, boundedNumber };
