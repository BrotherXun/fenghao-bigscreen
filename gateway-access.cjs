// Paid assistant access uses the Java device registry; credentials stay server-side.
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
      throw new GatewayError(401, 'device_auth_required', '请先配置有效的大屏设备和设备令牌。');
    }
    let response;
    let payload;
    try {
      response = await fetch(new URL(`/api/v1/screen-devices/${encodeURIComponent(deviceId)}/config`, apiBase), {
        headers: { 'X-Screen-Device-Token': deviceToken, Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) payload = await response.json();
      else await response.body?.cancel();
    } catch {
      throw new GatewayError(503, 'device_auth_unavailable', '设备认证服务暂不可用，请稍后重试。');
    }
    if (response.status >= 500) throw new GatewayError(503, 'device_auth_unavailable', '设备认证服务暂不可用，请稍后重试。');
    if (!response.ok || payload?.success !== true || payload.data?.deviceId !== deviceId) {
      throw new GatewayError(401, 'device_auth_failed', '设备令牌已失效或设备不可用，请联系管理员。');
    }
    return { deviceId, deviceToken };
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
