const { createApp } = Vue;

createApp({
  data() {
    const params = new URLSearchParams(location.search);
    return {
      deviceId: params.get("deviceId") || "SCR-001",
      deviceToken: params.get("deviceToken") || localStorage.getItem("fenghao-screen-device-token") || "SCR-DEMO-TOKEN",
      device: {},
      session: {},
      videos: [],
      currentIndex: 0,
      stage: "boot",
      busy: false,
      error: "",
      message: "",
      pollTimer: null,
      assistantOpen: true,
      assistantViewMode: "voice",
      assistantBusy: false,
      assistantInput: "",
      assistantConnection: "正在检查问答服务…",
      assistantConnectionMode: "checking",
      assistantSpeechConfigured: false,
      assistantSpeechEnabled: false,
      assistantSpeakReplies: true,
      assistantSpeechRate: 1.2,
      assistantVoice: null,
      assistantVoiceState: "idle",
      assistantVoiceStatus: "语音待命",
      assistantVoiceHint: "正在检查语音服务…",
      assistantVoiceListening: false,
      assistantVoiceStarting: false,
      assistantSpeakingThisTurn: false,
      assistantLiveAnswer: "",
      assistantLiveStatus: "",
      assistantSuggestions: [
        "高处作业前需要检查什么？",
        "临时用电如何进行日常巡检？",
        "防水施工有哪些常见风险？",
      ],
      assistantMessages: [],
      adminLoginOpen: false,
      adminLoginBusy: false,
      adminLoginError: "",
      adminLoginForm: {
        username: "",
        password: "",
      },
      adminSession: null,
      adminVideoOpen: false,
      adminVideosBusy: false,
      adminVideosLoaded: false,
      adminVideosError: "",
      adminVideos: [],
      adminVideoSearch: "",
      adminSelectedVideoId: "",
      adminVideoPlaybackError: "",
      adminVideoFullscreen: false,
      adminVideoFullscreenListener: null,
    };
  },
  computed: {
    title() {
      if (this.stage === "waiting") return "扫码开始个人学习";
      if (this.stage === "identified") return "工人身份已识别";
      if (this.stage === "playing") return "正在播放安全教育视频";
      if (this.stage === "completed") return "本次学习完成";
      return "大屏机初始化";
    },
    subtitle() {
      if (this.stage === "waiting") return "请使用工人端扫描二维码，开始个人安全教育学习。";
      if (this.stage === "identified") return "请核对学习人员信息后确认签到。";
      if (this.stage === "playing") return "请按课程顺序完成学习，进度将自动同步。";
      if (this.stage === "completed") return "学习记录已同步，请在手机端继续完成后续答题。";
      return "正在连接学习服务并准备本次会话。";
    },
    sessionStatusLabel() {
      const labels = {
        waiting_scan: "等待扫码",
        worker_identified: "待确认签到",
        checked_in: "学习进行中",
        playing: "学习进行中",
        learning_completed: "本次完成",
        expired: "二维码已过期",
        error: "会话异常",
      };
      return labels[this.session.status] || "正在准备";
    },
    displayExpireAt() {
      if (!this.session.expireAt) return "正在生成";
      const date = new Date(this.session.expireAt);
      if (Number.isNaN(date.getTime())) return "请重新生成二维码";
      return new Intl.DateTimeFormat("zh-CN", {
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(date);
    },
    overallProgress() {
      if (!this.videos.length) return 0;
      return Math.round(this.videos.reduce((total, video) => total + Number(video.progress || 0), 0) / this.videos.length);
    },
    workerInitial() {
      return (this.session.worker && this.session.worker.name ? this.session.worker.name.slice(0, 1) : "工");
    },
    currentVideo() {
      return this.videos[this.currentIndex] || null;
    },
    voicePresentationState() {
      if (this.assistantVoiceState === "playing") return "speaking";
      if (this.assistantVoiceState === "thinking" || this.assistantBusy) return "thinking";
      if (this.assistantVoiceStarting || this.assistantVoiceListening || this.assistantVoiceState === "listening" || this.assistantVoiceState === "recording") return "listening";
      return "ready";
    },
    voiceStateTitle() {
      if (this.assistantVoiceStarting) return "正在开启聆听";
      const labels = {
        ready: "语音模式已就绪",
        listening: "正在聆听",
        thinking: "正在分析问题",
        speaking: "正在语音播报",
      };
      return labels[this.voicePresentationState];
    },
    voiceTranscript() {
      if (this.assistantVoiceStarting) return "正在连接语音服务并请求麦克风权限。";
      const lastUserMessage = [...this.assistantMessages].reverse().find((item) => item.role === "user" && item.content);
      if (this.voicePresentationState === "ready") return "开始聆听后，识别内容会显示在这里。";
      if (this.voicePresentationState === "thinking") return lastUserMessage ? `“${lastUserMessage.content}”` : "正在等待语音问题。";
      if (this.voicePresentationState === "speaking") return this.voiceLatestAnswer || "正在播报关键安全动作。";
      if (this.assistantVoiceState === "recording" && this.assistantVoiceStatus) return this.assistantVoiceStatus;
      return lastUserMessage ? `“${lastUserMessage.content}”` : "请直接说出施工或工程安全问题。";
    },
    voiceLatestAnswer() {
      if (this.assistantLiveAnswer) return this.assistantLiveAnswer;
      const latest = [...this.assistantMessages].reverse().find((item) => item.role === "assistant" && item.content && !item.localOnly);
      return latest?.content || "";
    },
    voiceLiveStatus() {
      if (this.assistantLiveStatus) return this.assistantLiveStatus;
      return "正在接收现场安全建议…";
    },
    filteredAdminVideos() {
      const keyword = this.adminVideoSearch.trim().toLocaleLowerCase();
      const rows = Array.isArray(this.adminVideos) ? this.adminVideos : [];
      return rows.filter((video) => {
        if (String(video?.type || "").toUpperCase() !== "VIDEO") return false;
        if (!keyword) return true;
        const searchable = [video.title, video.theme, video.category, video.fileName]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase();
        return searchable.includes(keyword);
      });
    },
    adminSelectedVideo() {
      const videos = this.filteredAdminVideos;
      return videos.find((video) => video.resourceId === this.adminSelectedVideoId) || videos[0] || null;
    },
    adminSessionLabel() {
      if (!this.adminSession) return "";
      const name = this.adminSession.name || this.adminSession.username || "项目管理员";
      const scope = [this.adminSession.tenantName, this.adminSession.projectId]
        .filter(Boolean)
        .join(" / ");
      return scope ? `${name}，${scope}` : `${name}，项目管理员已登录`;
    },
  },
  watch: {
    voicePresentationState(state) {
      this.$nextTick(() => {
        const video = this.$refs.assistantSpeakingVideo;
        if (!video) return;
        if (state === "speaking") {
          video.currentTime = 0;
          const playback = video.play();
          if (playback && typeof playback.catch === "function") playback.catch(() => {});
          return;
        }
        video.pause();
        video.currentTime = 0;
      });
    },
  },
  async mounted() {
    this.bindAdminVideoFullscreenEvents();
    await Promise.all([this.init(), this.openAssistant()]);
  },
  beforeUnmount() {
    this.stopPolling();
    this.stopAssistantVoice();
    this.exitAdminVideoFullscreen();
    this.unbindAdminVideoFullscreenEvents();
    this.pauseAdminVideo();
  },
  methods: {
    async init() {
      this.stage = "boot";
      this.error = "";
      try {
        localStorage.setItem("fenghao-screen-device-token", this.deviceToken);
        this.device = await FenghaoApi.screenConfig(this.deviceId, this.deviceToken);
        await this.createSession();
      } catch (error) {
        this.error = error.message || "大屏机初始化失败";
      }
    },
    async createSession() {
      this.busy = true;
      try {
        this.session = await FenghaoApi.createScreenSession(this.deviceId, this.deviceToken);
        this.videos = [];
        this.currentIndex = 0;
        this.stage = "waiting";
        this.message = "请使用手机扫描二维码。";
        this.startPolling();
      } finally {
        this.busy = false;
      }
    },
    startPolling() {
      this.stopPolling();
      this.pollTimer = setInterval(this.pollSession, 2000);
      this.pollSession();
    },
    stopPolling() {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
    },
    async pollSession() {
      if (!this.session.sessionId || this.stage === "playing" || this.stage === "completed") return;
      try {
        const data = await FenghaoApi.screenSession(this.session.sessionId, this.deviceToken);
        this.session = Object.assign({}, this.session, data);
        if (data.status === "worker_identified") {
          this.stage = "identified";
          this.message = "工人已扫码，请确认开始学习。";
        } else if (data.status === "checked_in" || data.status === "playing") {
          this.videos = data.videos || [];
          this.stage = "playing";
        } else if (data.status === "learning_completed") {
          this.stage = "completed";
        } else if (data.status === "expired") {
          this.error = "二维码已过期，请重新生成。";
        } else if (data.status === "error") {
          this.error = data.errorMessage || "识别失败";
        }
      } catch (error) {
        this.error = error.message || "会话轮询失败";
      }
    },
    async startLearning() {
      if (!this.session.sessionId) return;
      this.busy = true;
      this.error = "";
      try {
        const data = await FenghaoApi.screenCheckin(this.session.sessionId, this.deviceToken);
        this.session = Object.assign({}, this.session, data, { status: data.status });
        this.videos = data.videos || [];
        this.stage = "playing";
        this.message = "已签到，开始播放个人学习内容。";
      } catch (error) {
        this.error = error.message || "开始学习失败";
      } finally {
        this.busy = false;
      }
    },
    async reportProgress(progress) {
      if (!this.currentVideo) return;
      this.busy = true;
      try {
        const data = await FenghaoApi.screenProgress(this.session.sessionId, this.deviceToken, {
          videoId: this.currentVideo.videoId,
          progress,
          currentTime: Math.round((this.currentVideo.durationSec || 0) * progress / 100),
          duration: this.currentVideo.durationSec || 0,
          status: progress >= 100 ? "finished" : "playing",
        });
        this.videos[this.currentIndex] = Object.assign({}, this.currentVideo, {
          progress: data.progress,
          status: data.status,
        });
        if (data.allCompleted) {
          await this.finishAll();
        }
      } catch (error) {
        this.error = error.message || "进度上报失败";
      } finally {
        this.busy = false;
      }
    },
    async finishCurrentVideo() {
      await this.reportProgress(100);
      if (this.stage !== "completed") this.nextVideo();
    },
    nextVideo() {
      if (this.currentIndex < this.videos.length - 1) {
        this.currentIndex += 1;
      }
    },
    async finishAll() {
      try {
        await FenghaoApi.screenComplete(this.session.sessionId, this.deviceToken);
      } catch (_) {
        // 如果后端已在进度上报时标记完成,这里失败不影响完成页展示。
      }
      this.stage = "completed";
      this.message = "学习完成，手机端答题入口已解锁。";
      this.stopPolling();
    },
    async clearAndRestart() {
      if (!this.session.sessionId) return this.createSession();
      this.busy = true;
      try {
        await FenghaoApi.screenClear(this.session.sessionId, this.deviceToken);
        await this.createSession();
      } catch (error) {
        this.error = error.message || "清空会话失败";
      } finally {
        this.busy = false;
      }
    },
    async resetSession() {
      if (this.session.sessionId) {
        try { await FenghaoApi.screenClear(this.session.sessionId, this.deviceToken); } catch (_) {}
      }
      await this.createSession();
    },
    getScreenAdminApiBase() {
      const value = String(window.FenghaoApi?.apiBase || "").trim();
      if (!value) return "";
      try {
        const parsed = new URL(value);
        return ["http:", "https:"].includes(parsed.protocol) ? value.replace(/\/+$/, "") : "";
      } catch (_) {
        return "";
      }
    },
    screenAdminApiUrl(path) {
      const base = this.getScreenAdminApiBase();
      return base ? `${base}${path}` : path;
    },
    async requestScreenAdminApi(path, options) {
      const config = Object.assign({ method: "GET", requiresAuth: true }, options || {});
      const requiresAuth = config.requiresAuth;
      delete config.requiresAuth;
      const headers = Object.assign({ Accept: "application/json" }, config.headers || {});
      if (requiresAuth && this.adminSession?.token) {
        headers.Authorization = `Bearer ${this.adminSession.token}`;
      }
      if (config.body && !headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
      const response = await fetch(this.screenAdminApiUrl(path), Object.assign({}, config, { headers }));
      const contentType = response.headers.get("content-type") || "";
      const payload = contentType.includes("application/json")
        ? await response.json().catch(() => null)
        : null;
      if (!response.ok || (payload && payload.success === false)) {
        const error = new Error(payload?.message || `请求失败，请稍后重试。`);
        error.status = response.status;
        throw error;
      }
      return payload && Object.prototype.hasOwnProperty.call(payload, "success") ? payload.data : payload;
    },
    isProjectAdminRole(role) {
      return ["PROJECT_ADMIN", "TENANT_ADMIN", "ADMIN", "SAFETY"].includes(String(role || "").trim().toUpperCase());
    },
    openAdminLogin() {
      if (this.adminSession) {
        this.openAdminVideoCenter();
        return;
      }
      this.closeAssistant();
      this.adminLoginError = "";
      this.adminLoginOpen = true;
      this.$nextTick(() => this.$refs.adminLoginUsername?.focus());
    },
    closeAdminLogin() {
      if (this.adminLoginBusy) return;
      this.adminLoginOpen = false;
      this.adminLoginError = "";
      this.adminLoginForm.password = "";
    },
    async submitAdminLogin() {
      const username = this.adminLoginForm.username.trim();
      const password = this.adminLoginForm.password;
      if (!username || !password || this.adminLoginBusy) return;
      this.adminLoginBusy = true;
      this.adminLoginError = "";
      try {
        const data = await this.requestScreenAdminApi("/api/v1/admin/auth/login", {
          method: "POST",
          requiresAuth: false,
          body: JSON.stringify({ username, password }),
        });
        if (!data?.token || !this.isProjectAdminRole(data.role)) {
          throw new Error("该账号不是项目管理员，不能使用大屏视频查看。");
        }
        this.adminSession = {
          token: data.token,
          username: data.username || username,
          name: data.name || data.username || username,
          role: data.role,
          tenantName: data.tenantName || "",
          projectId: data.projectId || "",
        };
        this.adminLoginForm.password = "";
        this.adminLoginOpen = false;
        this.adminVideoOpen = true;
        this.adminVideoSearch = "";
        this.$nextTick(() => this.$refs.adminVideoOverlay?.focus());
        await this.loadAdminVideos();
      } catch (error) {
        this.adminLoginError = error?.message || "登录失败，请检查账号和密码。";
      } finally {
        this.adminLoginBusy = false;
      }
    },
    openAdminVideoCenter() {
      if (!this.adminSession) {
        this.openAdminLogin();
        return;
      }
      this.closeAssistant();
      this.adminVideoOpen = true;
      this.$nextTick(() => this.$refs.adminVideoOverlay?.focus());
      if (!this.adminVideosLoaded) this.loadAdminVideos();
    },
    closeAdminVideoCenter() {
      this.exitAdminVideoFullscreen();
      this.pauseAdminVideo();
      this.adminVideoOpen = false;
      this.adminVideoPlaybackError = "";
    },
    bindAdminVideoFullscreenEvents() {
      if (typeof document === "undefined" || this.adminVideoFullscreenListener) return;
      this.adminVideoFullscreenListener = () => this.handleAdminVideoFullscreenChange();
      document.addEventListener("fullscreenchange", this.adminVideoFullscreenListener);
      document.addEventListener("webkitfullscreenchange", this.adminVideoFullscreenListener);
    },
    unbindAdminVideoFullscreenEvents() {
      if (typeof document === "undefined" || !this.adminVideoFullscreenListener) return;
      document.removeEventListener("fullscreenchange", this.adminVideoFullscreenListener);
      document.removeEventListener("webkitfullscreenchange", this.adminVideoFullscreenListener);
      this.adminVideoFullscreenListener = null;
    },
    getAdminVideoFullscreenElement() {
      if (typeof document === "undefined") return null;
      return document.fullscreenElement || document.webkitFullscreenElement || null;
    },
    isAdminVideoInFullscreen() {
      const fullscreenElement = this.getAdminVideoFullscreenElement();
      const frame = this.$refs.adminVideoFrame;
      const player = this.$refs.adminVideoPlayer;
      return Boolean(fullscreenElement && (
        fullscreenElement === frame
        || fullscreenElement === player
        || (frame && typeof frame.contains === "function" && frame.contains(fullscreenElement))
      ));
    },
    handleAdminVideoFullscreenStart() {
      this.adminVideoFullscreen = true;
    },
    handleAdminVideoFullscreenChange() {
      this.adminVideoFullscreen = this.isAdminVideoInFullscreen();
    },
    async toggleAdminVideoFullscreen() {
      if (!this.isAdminVideoPlayable(this.adminSelectedVideo)) return;
      if (this.adminVideoFullscreen || this.isAdminVideoInFullscreen()) {
        await this.exitAdminVideoFullscreen();
        return;
      }
      const frame = this.$refs.adminVideoFrame;
      const player = this.$refs.adminVideoPlayer;
      try {
        const requestFullscreen = frame?.requestFullscreen || frame?.webkitRequestFullscreen;
        if (typeof requestFullscreen === "function") {
          const result = requestFullscreen.call(frame);
          if (result && typeof result.then === "function") await result;
          this.handleAdminVideoFullscreenChange();
          return;
        }
        if (typeof player?.webkitEnterFullscreen === "function") {
          player.webkitEnterFullscreen();
          this.adminVideoFullscreen = true;
          return;
        }
        this.adminVideoPlaybackError = "当前浏览器不支持全屏播放。";
      } catch (_) {
        this.adminVideoFullscreen = false;
        this.adminVideoPlaybackError = "无法进入全屏播放，请检查浏览器权限后重试。";
      }
    },
    async exitAdminVideoFullscreen() {
      const player = this.$refs?.adminVideoPlayer;
      try {
        const fullscreenElement = this.getAdminVideoFullscreenElement();
        const exitFullscreen = typeof document === "undefined"
          ? null
          : document.exitFullscreen || document.webkitExitFullscreen;
        if (fullscreenElement && typeof exitFullscreen === "function") {
          const result = exitFullscreen.call(document);
          if (result && typeof result.then === "function") await result;
        } else if (typeof player?.webkitExitFullscreen === "function") {
          player.webkitExitFullscreen();
        }
      } catch (_) {
        // 关闭面板时退出全屏失败不应阻塞当前大屏操作。
      }
      this.adminVideoFullscreen = false;
    },
    logoutProjectAdmin() {
      this.closeAdminVideoCenter();
      this.adminSession = null;
      this.adminVideos = [];
      this.adminVideosLoaded = false;
      this.adminVideosError = "";
      this.adminVideoSearch = "";
      this.adminSelectedVideoId = "";
      this.adminLoginForm.password = "";
    },
    expireProjectAdminSession() {
      this.logoutProjectAdmin();
      this.adminLoginError = "登录已失效，请重新登录后查看视频。";
      this.adminLoginOpen = true;
      this.$nextTick(() => this.$refs.adminLoginUsername?.focus());
    },
    async loadAdminVideos() {
      if (!this.adminSession?.token || this.adminVideosBusy) return;
      const activeToken = this.adminSession.token;
      this.adminVideosBusy = true;
      this.adminVideosError = "";
      try {
        const data = await this.requestScreenAdminApi("/api/v1/admin/training-resources?type=VIDEO");
        if (this.adminSession?.token !== activeToken) return;
        this.adminVideos = Array.isArray(data)
          ? data.filter((video) => String(video?.type || "").toUpperCase() === "VIDEO")
          : [];
        this.adminVideosLoaded = true;
        if (!this.adminVideos.some((video) => video.resourceId === this.adminSelectedVideoId)) {
          this.adminSelectedVideoId = this.adminVideos[0]?.resourceId || "";
        }
        this.adminVideoPlaybackError = "";
      } catch (error) {
        if (error?.status === 401) {
          this.expireProjectAdminSession();
          return;
        }
        this.adminVideosError = error?.message || "无法获取项目培训视频。";
      } finally {
        this.adminVideosBusy = false;
      }
    },
    selectAdminVideo(video) {
      if (!video?.resourceId) return;
      this.pauseAdminVideo();
      this.adminSelectedVideoId = video.resourceId;
      this.adminVideoPlaybackError = "";
    },
    adminVideoIndex(video) {
      const index = this.filteredAdminVideos.findIndex((item) => item.resourceId === video?.resourceId);
      return index >= 0 ? index + 1 : "";
    },
    adminVideoDescriptor(video) {
      const value = [video?.theme, video?.category, this.formatAdminVideoDuration(video)]
        .filter((item) => item && item !== "未设置")
        .join(" / ");
      return value || "未设置主题和分类";
    },
    adminVideoStateTone(video) {
      const state = String(video?.processingStatus || "").trim().toUpperCase();
      if (["READY", "COMPLETED", "SUCCESS"].includes(state)) return "ready";
      if (["PROCESSING", "PENDING", "UPLOADING"].includes(state)) return "processing";
      if (["FAILED", "ERROR"].includes(state)) return "failed";
      return video?.url ? "ready" : "neutral";
    },
    adminVideoStateLabel(video) {
      const state = String(video?.processingStatus || "").trim().toUpperCase();
      const labels = {
        READY: "可播放",
        COMPLETED: "可播放",
        SUCCESS: "可播放",
        PROCESSING: "处理中",
        PENDING: "待处理",
        UPLOADING: "上传中",
        FAILED: "处理失败",
        ERROR: "处理失败",
      };
      return labels[state] || (this.safeAdminVideoUrl(video?.url) ? "已配置" : "未配置");
    },
    safeAdminVideoUrl(value) {
      if (typeof value !== "string" || !value.trim() || value.length > 4096) return "";
      try {
        const base = this.getScreenAdminApiBase() || location.origin;
        const url = new URL(value.trim(), base);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
        return url.href;
      } catch (_) {
        return "";
      }
    },
    isAdminVideoPlayable(video) {
      const state = String(video?.processingStatus || "").trim().toUpperCase();
      return Boolean(this.safeAdminVideoUrl(video?.url))
        && !["PROCESSING", "PENDING", "UPLOADING", "FAILED", "ERROR"].includes(state);
    },
    adminVideoUnavailableReason(video) {
      const state = String(video?.processingStatus || "").trim().toUpperCase();
      if (!this.safeAdminVideoUrl(video?.url)) return "资源尚未配置可播放的视频地址。";
      if (["PROCESSING", "PENDING", "UPLOADING"].includes(state)) return "视频正在处理，请稍后刷新列表。";
      if (["FAILED", "ERROR"].includes(state)) return "视频处理失败，请在项目管理后台重新检查资源。";
      return "当前视频暂不支持在此设备播放。";
    },
    formatAdminVideoDuration(video) {
      const seconds = Number(video?.durationSec || (Number(video?.durationMs || 0) / 1000));
      if (!Number.isFinite(seconds) || seconds <= 0) return "未设置";
      const total = Math.round(seconds);
      const minutes = Math.floor(total / 60);
      const remain = total % 60;
      return minutes ? `${minutes} 分 ${String(remain).padStart(2, "0")} 秒` : `${remain} 秒`;
    },
    handleAdminVideoPlaybackError() {
      this.adminVideoPlaybackError = "视频加载失败，请检查资源文件、网络连接或浏览器格式支持。";
    },
    clearAdminVideoPlaybackError() {
      this.adminVideoPlaybackError = "";
    },
    pauseAdminVideo() {
      const player = this.$refs.adminVideoPlayer;
      if (player && typeof player.pause === "function") player.pause();
    },
    async openAssistant() {
      this.closeAdminVideoCenter();
      if (this.adminLoginOpen) this.closeAdminLogin();
      this.assistantOpen = true;
      this.assistantViewMode = "voice";
      if (!this.assistantMessages.length) this.resetAssistant();
      this.assistantVoiceStatus = "点击开始聆听后即可提问";
      await this.checkAssistantStatus();
    },
    toggleAssistantView() {
      this.assistantViewMode = this.assistantViewMode === "voice" ? "chat" : "voice";
      if (this.assistantViewMode === "chat") {
        this.$nextTick(() => this.$refs.assistantInput?.focus());
      }
    },
    closeAssistant() {
      this.assistantOpen = false;
      this.stopAssistantVoice();
    },
    resetAssistant() {
      this.assistantInput = "";
      this.assistantLiveAnswer = "";
      this.assistantLiveStatus = "";
      this.assistantMessages = [{
        role: "assistant",
        content: "你好，我是**丰浩安全培训助手**。我只回答施工和工程安全相关问题，可以协助梳理作业风险和安全培训要点。",
        localOnly: true,
        references: [],
        followUps: [],
      }];
      this.scrollAssistantToLatest();
    },
    async checkAssistantStatus() {
      try {
        const response = await fetch("/api/v1/assistant/status", { cache: "no-store" });
        if (!response.ok) throw new Error("问答服务不可用");
        const status = await response.json();
        if (status.configured) {
          this.assistantConnection = "联网问答已连接 · 流式回答";
          this.assistantConnectionMode = "online";
        } else {
          this.assistantConnection = "本地演示 · 未配置联网密钥";
          this.assistantConnectionMode = "demo";
        }
        this.assistantSpeechConfigured = Boolean(status.speech);
        this.setupAssistantVoice();
      } catch (_) {
        this.assistantConnection = "服务暂不可用";
        this.assistantConnectionMode = "error";
        this.assistantSpeechConfigured = false;
        this.setupAssistantVoice();
      }
    },
    setupAssistantVoice() {
      if (!this.assistantVoice && typeof window.createVoice === "function") {
        const screen = this;
        this.assistantVoice = window.createVoice({
          onStateChange(state) {
            screen.setAssistantVoiceState(state);
          },
          onPartialTranscript(text) {
            screen.assistantVoiceStatus = text ? `识别中：${text}` : "正在聆听，请开始提问";
          },
          onFinalTranscript(text) {
            screen.assistantInput = text;
            screen.sendAssistantQuestion();
          },
          onError(scope, message) {
            screen.assistantVoiceStatus = message || "语音服务暂不可用。";
            if (scope === "mic" || scope === "connection") {
              screen.assistantVoiceListening = false;
              screen.assistantVoiceState = "idle";
            }
          },
        });
      }
      const browserSupported = Boolean(this.assistantVoice?.isAvailable?.());
      this.assistantSpeechEnabled = this.assistantSpeechConfigured && browserSupported;
      if (!browserSupported) {
        this.assistantVoiceHint = "当前浏览器不支持录音，请使用 Chrome 或 Edge";
      } else if (!this.assistantSpeechConfigured) {
        this.assistantVoiceHint = "语音未启用：服务端缺少语音识别与合成配置";
      } else {
        this.assistantVoiceHint = "可连续语音提问；播报时直接开口即可打断";
      }
    },
    setAssistantVoiceState(state) {
      const labels = {
        idle: "语音已关闭",
        listening: "正在聆听，请开始提问",
        recording: "正在识别你的语音…",
        thinking: "正在生成回答…",
        playing: "正在播报，可直接开口打断",
      };
      this.assistantVoiceState = state || "idle";
      this.assistantVoiceStatus = labels[this.assistantVoiceState] || "语音待命";
      this.assistantVoiceListening = Boolean(this.assistantVoice?.isListening?.());
    },
    async toggleAssistantVoice() {
      if (!this.assistantSpeechEnabled || !this.assistantVoice || this.assistantVoiceStarting) return;
      if (this.assistantVoice.isListening()) {
        this.stopAssistantVoice();
        return;
      }
      await this.startAssistantListening();
    },
    async startAssistantListening() {
      if (!this.assistantOpen || !this.assistantSpeechEnabled || !this.assistantVoice || this.assistantVoiceStarting) return false;
      if (this.assistantVoice.isListening()) {
        this.assistantVoiceListening = true;
        return true;
      }
      this.assistantVoiceStarting = true;
      this.assistantVoiceStatus = "正在打开麦克风…";
      try {
        const started = await this.assistantVoice.startListening();
        if (!this.assistantOpen) {
          if (started && this.assistantVoice.isListening()) this.assistantVoice.stopListening();
          return false;
        }
        this.assistantVoiceListening = Boolean(started && this.assistantVoice.isListening());
        if (!started) this.assistantVoiceState = "idle";
        return this.assistantVoiceListening;
      } catch (_) {
        this.assistantVoiceListening = false;
        this.assistantVoiceState = "idle";
        this.assistantVoiceStatus = "无法开启麦克风，请检查权限后重试。";
        return false;
      } finally {
        this.assistantVoiceStarting = false;
      }
    },
    stopAssistantVoice() {
      if (this.assistantVoice?.isListening?.()) this.assistantVoice.stopListening();
      this.assistantVoiceListening = false;
      this.assistantVoiceState = "idle";
      this.assistantVoiceStatus = "语音已关闭";
    },
    cancelAssistantSpeech() {
      if (!this.assistantVoice) return;
      this.assistantSpeakingThisTurn = false;
      this.assistantVoice.cancelSpeech();
      this.assistantVoiceStatus = this.assistantVoice.isListening() ? "已停止播报，请继续提问" : "已停止播报";
    },
    async askFollowUp(question) {
      this.assistantInput = String(question || "");
      await this.sendAssistantQuestion();
    },
    async sendAssistantQuestion() {
      const question = this.assistantInput.trim();
      if (!question || this.assistantBusy) return;
      const userMessage = { role: "user", content: question, references: [], followUps: [] };
      const assistantMessage = { role: "assistant", content: "", processing: "正在理解问题", references: [], followUps: [] };
      this.assistantMessages.push(userMessage, assistantMessage);
      this.assistantInput = "";
      this.assistantLiveAnswer = "";
      this.assistantLiveStatus = assistantMessage.processing;
      this.assistantBusy = true;
      this.scrollAssistantToLatest();
      this.assistantSpeakingThisTurn = Boolean(this.assistantVoice && this.assistantSpeechEnabled && this.assistantSpeakReplies);
      if (this.assistantSpeakingThisTurn) {
        this.assistantVoice.preparePlayback?.();
        this.assistantVoice.beginSpeech(this.assistantSpeechRate);
      }
      try {
        const messages = this.assistantMessages
          .filter((item) => !item.localOnly && (item.role === "user" || (item.role === "assistant" && item.content)))
          .slice(-10)
          .map((item) => ({ role: item.role, content: item.content }));
        const response = await fetch("/api/v1/assistant/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload?.error?.message || "问答服务暂不可用，请稍后重试。");
        }
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("text/event-stream")) {
          await this.readAssistantStream(response, assistantMessage);
        } else {
          this.consumeAssistantFrame(assistantMessage, await response.json());
        }
        if (!assistantMessage.content) assistantMessage.content = "暂未收到有效回答，请稍后重试。";
        this.assistantLiveAnswer = assistantMessage.content;
        this.assistantLiveStatus = "";
        assistantMessage.processing = "";
        if (this.assistantSpeakingThisTurn) this.assistantVoice.endSpeech();
      } catch (error) {
        if (this.assistantSpeakingThisTurn) this.assistantVoice.cancelSpeech();
        assistantMessage.processing = "";
        assistantMessage.content = `抱歉，本次问答未能完成。**${error?.message || "服务暂不可用，请稍后重试。"}**`;
        this.assistantLiveAnswer = assistantMessage.content;
        this.assistantLiveStatus = "";
        this.assistantConnection = "服务暂不可用";
        this.assistantConnectionMode = "error";
      } finally {
        this.assistantSpeakingThisTurn = false;
        this.assistantBusy = false;
        this.scrollAssistantToLatest();
        this.$nextTick(() => this.$refs.assistantInput?.focus());
      }
    },
    async readAssistantStream(response, message) {
      const reader = response.body?.getReader();
      if (!reader) throw new Error("未收到流式问答内容。");
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let done = false;
      while (!done) {
        const packet = await reader.read();
        done = packet.done;
        buffer += decoder.decode(packet.value || new Uint8Array(), { stream: !done });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";
        blocks.forEach((block) => this.consumeAssistantSseBlock(message, block));
      }
      if (buffer.trim()) this.consumeAssistantSseBlock(message, buffer);
    },
    consumeAssistantSseBlock(message, block) {
      const data = String(block || "").split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") return;
      try {
        this.consumeAssistantFrame(message, JSON.parse(data));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    },
    consumeAssistantFrame(message, frame) {
      if (frame?.error?.message) throw new Error(frame.error.message);
      const choice = frame?.choices?.[0] || {};
      const delta = choice.delta || {};
      if (delta.processing_state?.description) {
        message.processing = delta.processing_state.description;
        this.assistantLiveStatus = message.processing;
      }
      if (delta.content) {
        const content = String(delta.content);
        message.content += content;
        this.assistantLiveAnswer = message.content;
        this.assistantLiveStatus = "";
        message.processing = "";
        if (this.assistantSpeakingThisTurn && this.assistantVoice) this.assistantVoice.pushText(content);
      }
      const references = [...(frame?.references || []), ...(frame?.search_results || [])];
      references.forEach((reference) => {
        const id = reference?.id || reference?.url || reference?.title;
        if (id && !message.references.some((item) => (item?.id || item?.url || item?.title) === id)) message.references.push(reference);
      });
      if (Array.isArray(frame?.follow_ups)) {
        message.followUps = frame.follow_ups
          .map((item) => typeof item === "string" ? item : item?.item || item?.content || item?.text || "")
          .filter(Boolean);
      }
      this.scrollAssistantToLatest();
    },
    formatAssistantMessage(value) {
      return this.escapeAssistantHtml(value)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\n/g, "<br>");
    },
    escapeAssistantHtml(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#039;");
    },
    safeAssistantUrl(value) {
      try {
        const url = new URL(String(value || ""));
        return url.protocol === "https:" ? url.href : "";
      } catch (_) {
        return "";
      }
    },
    scrollAssistantToLatest() {
      this.$nextTick(() => {
        const chat = this.$refs.assistantChat;
        if (chat) chat.scrollTop = chat.scrollHeight;
        const answer = this.$refs.assistantAnswerStream;
        if (answer) answer.scrollTop = answer.scrollHeight;
      });
    },
  },
}).mount("#screenApp");
