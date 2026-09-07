// 大屏专用 API；同源 Node 服务统一转发到 Java 后端。
(function () {
  async function request(path, deviceToken, method = "GET", body) {
    const headers = { Accept: "application/json" };
    if (deviceToken) headers["X-Screen-Device-Token"] = deviceToken;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success === false) {
      const error = new Error(payload?.message || "后端请求失败，请检查设备配置和服务连接。");
      error.status = response.status;
      throw error;
    }
    return payload && Object.prototype.hasOwnProperty.call(payload, "success") ? payload.data : payload;
  }
  const sessionPath = (id) => "/api/v1/screen-sessions/" + encodeURIComponent(id);
  window.FenghaoApi = {
    apiBase: "",
    screenConfig: (id, token) => request("/api/v1/screen-devices/" + encodeURIComponent(id) + "/config", token),
    screenDeviceCommands: (id, token) => request("/api/v1/screen-devices/" + encodeURIComponent(id) + "/commands", token),
    ackScreenDeviceCommand: (id, commandId, token, body) => request("/api/v1/screen-devices/" + encodeURIComponent(id) + "/commands/" + encodeURIComponent(commandId) + "/ack", token, "POST", body),
    createScreenSession: (deviceId, token) => request("/api/v1/screen-sessions", token, "POST", { deviceId }),
    screenSession: (id, token) => request(sessionPath(id), token),
    screenCheckin: (id, token) => request(sessionPath(id) + "/checkin", token, "POST"),
    screenVideos: (id, token) => request(sessionPath(id) + "/videos", token),
    startScreenPlayback: (id, unitId, token) => request(sessionPath(id) + "/units/" + encodeURIComponent(unitId) + "/playback-sessions", token, "POST"),
    screenPlaybackEvent: (id, unitId, token, body) => request(sessionPath(id) + "/units/" + encodeURIComponent(unitId) + "/playback-events", token, "POST", body),
    screenProgress: (id, token, payload) => request(sessionPath(id) + "/progress", token, "POST", payload),
    screenComplete: (id, token) => request(sessionPath(id) + "/complete", token, "POST"),
    screenClear: (id, token) => request(sessionPath(id) + "/clear", token, "POST", { reason: "screen_page" }),
  };
})();
