const { createApp } = Vue;

createApp({
  data() {
    const params = new URLSearchParams(location.search);
    let deviceId = params.get("deviceId") || "";
    let deviceToken = params.get("deviceToken") || "";
    try {
      deviceId ||= localStorage.getItem("fenghao-screen-device-id") || "";
      if (deviceId) deviceToken ||= localStorage.getItem("fenghao-screen-device-token:" + deviceId) || "";
      if (deviceId && deviceToken) {
        localStorage.setItem("fenghao-screen-device-id", deviceId);
        localStorage.setItem("fenghao-screen-device-token:" + deviceId, deviceToken);
      }
      localStorage.removeItem?.("fenghao-screen-device-token");
    } catch (_) { /* 禁用持久存储时仍可使用本次内存配置。 */ }
    if (params.has("deviceToken") && typeof history !== "undefined") {
      params.delete("deviceToken");
      history.replaceState(null, "", (location.pathname || "/screen.html") + (params.size ? "?" + params : "") + (location.hash || ""));
    }
    return {
      deviceId,
      deviceToken,
      device: {},
      session: {},
      videos: [],
      currentIndex: 0,
      stage: "boot",
      busy: false,
      error: "",
      message: "",
      pollTimer: null,
      deviceTimer: null,
      commandBusy: false,
      sessionEpoch: 0,
      playbackStates: {},
      assistantOpen: true,
      assistantViewMode: "voice",
      assistantBusy: false,
      assistantRequestId: 0,
      assistantAbort: null,
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
    this.startDevicePolling();
    await Promise.all([this.init(), this.openAssistant()]);
  },
  beforeUnmount() {
    this.sessionEpoch += 1;
    this.stopPolling();
    if (this.deviceTimer) clearInterval(this.deviceTimer);
    this.stopAssistantVoice();
    this.cancelAssistantRequest();
    this.exitAdminVideoFullscreen();
    this.unbindAdminVideoFullscreenEvents();
    this.pauseAdminVideo();
  },
  methods: {
    deviceHeaders() {
      return { "X-Screen-Device-ID": this.deviceId, "X-Screen-Device-Token": this.deviceToken };
    },
    startDevicePolling() {
      if (this.deviceTimer) clearInterval(this.deviceTimer);
      this.deviceTimer = setInterval(this.pollDeviceCommands, 5000);
    },
    applyPlayback() {
      const video = this.$refs.learningVideo;
      if (!video) return;
      const config = this.device.playback || {};
      const volume = Number(config.volume);
      if (config.volume != null && Number.isFinite(volume)) video.volume = Math.max(0, Math.min(1, volume / 100));
      video.autoplay = config.autoPlay !== false;
    },
    async pollDeviceCommands() {
      if (this.commandBusy || !this.deviceId || !this.deviceToken) return;
      this.commandBusy = true;
      try {
        this.device = await FenghaoApi.screenConfig(this.deviceId, this.deviceToken);
        this.applyPlayback();
        if (!this.busy && this.session.sessionId && Object.prototype.hasOwnProperty.call(this.device, "currentSessionId")
          && this.device.currentSessionId === null) {
          this.$refs.learningVideo?.pause();
          await this.createSession();
        }
        const commands = await FenghaoApi.screenDeviceCommands(this.deviceId, this.deviceToken);
        for (const command of commands) {
          let result = { status: "FAILED", detail: "浏览器终端不支持操作系统重启" };
          if (command.action === "RECONNECT") {
            try {
              if (this.busy) throw new Error("当前学习请求尚未结束，请稍后重连。");
              this.sessionEpoch += 1;
              const sessionId = this.device.currentSessionId || this.session.sessionId;
              if (sessionId) {
                const data = await FenghaoApi.screenSession(sessionId, this.deviceToken);
                if (data?.sessionId !== sessionId) throw new Error("会话响应不匹配。");
                this.session = data;
                this.videos = data.videos || [];
                this.currentIndex = 0;
                this.stage = data.status === "worker_identified" ? "identified"
                  : ["checked_in", "playing", "learning_completed"].includes(data.status) ? "playing" : "waiting";
                if (data.status === "learning_completed") await this.finishAll();
                this.startPolling();
              } else await this.createSession();
              result = { status: "SUCCESS", detail: "设备配置和当前会话已重新同步" };
            } catch (error) { result = { status: "FAILED", detail: error.message || "设备重连失败" }; }
          } else if (command.action !== "RESTART") result.detail = "浏览器终端不支持此设备指令";
          await FenghaoApi.ackScreenDeviceCommand(this.deviceId, command.id, this.deviceToken, result);
        }
      } catch (error) {
        this.error = error.message || "设备同步失败，请检查网络或设备配置。";
        if ([401, 403].includes(error.status)) {
          this.$refs.learningVideo?.pause();
          this.stopAssistantVoice();
        }
      } finally { this.commandBusy = false; }
    },
    learningContext() {
      return { epoch: this.sessionEpoch, sessionId: this.session.sessionId, assignmentId: this.session.assignmentId, deviceToken: this.deviceToken };
    },
    isCurrentLearningContext(context) {
      return context.epoch === this.sessionEpoch && context.sessionId === this.session.sessionId
        && context.assignmentId === this.session.assignmentId
        && context.deviceToken === this.deviceToken;
    },
    async init() {
      this.stage = "boot";
      this.error = "";
      try {
        if (!this.deviceId || !this.deviceToken) throw new Error("请由管理员配置设备编号与设备令牌后启动大屏。");
        this.device = await FenghaoApi.screenConfig(this.deviceId, this.deviceToken);
        await this.createSession();
      } catch (error) {
        this.error = error.message || "大屏机初始化失败";
      }
    },
    async createSession() {
      const epoch = ++this.sessionEpoch;
      this.playbackStates = {};
      this.stopPolling();
      this.busy = true;
      try {
        const data = await FenghaoApi.createScreenSession(this.deviceId, this.deviceToken);
        if (epoch !== this.sessionEpoch) return;
        this.session = data;
        this.videos = [];
        this.currentIndex = 0;
        this.stage = "waiting";
        this.error = "";
        this.message = "请使用手机扫描二维码。";
        this.startPolling();
      } catch (error) {
        if (epoch === this.sessionEpoch) {
          this.error = error.message || "创建学习会话失败，请重试。";
          throw error;
        }
      } finally {
        if (epoch === this.sessionEpoch) this.busy = false;
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
      if (!this.session.sessionId || this.busy || this.stage === "playing" || this.stage === "completed") return;
      const context = this.learningContext();
      const stage = this.stage;
      try {
        const data = await FenghaoApi.screenSession(context.sessionId, context.deviceToken);
        if (!this.isCurrentLearningContext(context) || this.busy || this.stage !== stage) return;
        if (data?.sessionId !== context.sessionId) throw new Error("会话响应不匹配，请重试。");
        this.session = Object.assign({}, this.session, data);
        if (data.status === "worker_identified") {
          this.stage = "identified";
          this.message = "工人已扫码，请确认开始学习。";
        } else if (data.status === "checked_in" || data.status === "playing") {
          this.videos = data.videos || [];
          this.stage = "playing";
        } else if (data.status === "learning_completed") {
          this.videos = data.videos || [];
          this.stage = "playing";
          await this.finishAll(context);
        } else if (data.status === "expired") {
          this.error = "二维码已过期，请重新生成。";
        } else if (data.status === "error") {
          this.error = data.errorMessage || "识别失败";
        }
      } catch (error) {
        if (this.isCurrentLearningContext(context) && this.stage === stage) {
          this.error = error.message || "会话轮询失败";
        }
      }
    },
    async startLearning() {
      if (!this.session.sessionId || this.busy) return;
      const context = this.learningContext();
      this.busy = true;
      this.error = "";
      try {
        const data = await FenghaoApi.screenCheckin(context.sessionId, context.deviceToken);
        if (!this.isCurrentLearningContext(context)) return;
        if (data?.sessionId !== context.sessionId) throw new Error("签到响应不匹配，请重试。");
        this.session = Object.assign({}, this.session, data, { status: data.status });
        this.videos = data.videos || [];
        this.stage = "playing";
        this.message = "已签到，开始播放个人学习内容。";
      } catch (error) {
        if (this.isCurrentLearningContext(context)) this.error = error.message || "开始学习失败";
      } finally {
        if (this.isCurrentLearningContext(context)) this.busy = false;
      }
    },
    learningPlaybackState(player = this.$refs.learningVideo) {
      const videoId = player?.dataset?.videoId || this.currentVideo?.videoId;
      const video = this.videos.find((item) => item.videoId === videoId);
      if (!player || !this.safeAdminVideoUrl(video?.videoUrl)) throw new Error("当前课程没有可播放的视频，无法完成学习。");
      if (!video.unitId || !this.session.assignmentId || !this.session.sessionId) throw new Error("当前课程缺少新版培训单元信息，请在管理后台检查培训发布。");
      const context = this.learningContext();
      const key = `${context.epoch}:${context.sessionId}:${video.unitId}`;
      if (!this.playbackStates[key]) this.playbackStates[key] = {
        context, videoId, unitId: video.unitId, player, queue: Promise.resolve(), row: null,
        initializing: null, sequence: 0, position: 0, pending: null, playing: false,
        preparing: false, failed: false, completed: false, seeking: false, restoringPosition: false,
        lastHeartbeatAt: 0, lastObservedPosition: 0,
      };
      return this.playbackStates[key];
    },
    async ensureLearningPlayback(state) {
      if (state.row) return state.row;
      if (state.initializing) return state.initializing;
      state.initializing = (async () => {
        const row = await FenghaoApi.startScreenPlayback(state.context.sessionId, state.unitId, state.context.deviceToken);
        if (!this.isCurrentLearningContext(state.context)) return null;
        if (!row?.playbackSessionId || row.assignmentId !== state.context.assignmentId
          || row.unitId !== state.unitId || row.resourceId !== state.videoId) throw new Error("播放会话与当前培训视频不匹配。");
        state.row = row;
        state.sequence = Number(row.lastSequence) || 0;
        state.position = Number(row.acceptedPositionMs) || 0;
        return row;
      })();
      try { return await state.initializing; } finally { state.initializing = null; }
    },
    async postLearningPlayback(state) {
      const event = state.pending;
      const data = await FenghaoApi.screenPlaybackEvent(state.context.sessionId, state.unitId, state.context.deviceToken, event);
      if (!this.isCurrentLearningContext(state.context)) return null;
      state.sequence = event.sequence;
      state.position = Number(data.acceptedPositionMs) || 0;
      state.pending = null;
      state.failed = false;
      this.error = "";
      const index = this.videos.findIndex((item) => item.videoId === state.videoId && item.unitId === state.unitId);
      if (index < 0) return null;
      state.completed = data.completionStatus === "COMPLETED";
      this.videos[index] = { ...this.videos[index], progress: state.completed ? 100 : Number(data.coveragePercent) || 0, status: state.completed ? "finished" : "playing" };
      this.session.gate = { ...(this.session.gate || {}), status: data.gateStatus, blockedReasonCode: data.blockedReasonCode };
      if (event.type === "ENDED") {
        state.playing = false;
        if (!state.completed) this.error = "服务端尚未确认完整播放，请从未完成的位置继续学习后重试。";
        else if (data.gateStatus === "EXAM_READY" || this.videos.filter((item) => item.mustComplete !== false).every((item) => item.status === "finished")) await this.finishAll(state.context);
        else if (this.currentVideo?.videoId === state.videoId) this.nextVideo();
      }
      return data;
    },
    playbackEventId() {
      if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
    queueLearningPlayback(state, type, position, rate = 1) {
      state.queue = state.queue.catch(() => null).then(async () => {
        if (!this.isCurrentLearningContext(state.context)) return null;
        try {
          if (!await this.ensureLearningPlayback(state)) return null;
          if (!state.pending) {
            const to = Math.max(0, Math.min(Number(state.row.durationMs), Math.round(position)));
            state.pending = {
              eventId: this.playbackEventId(), playbackSessionId: state.row.playbackSessionId,
              sequence: state.sequence + 1, type, fromPositionMs: type === "START" ? to : state.position,
              toPositionMs: to, playbackRate: Number(rate) || 1, occurredAt: new Date().toISOString(),
            };
          }
          return await this.postLearningPlayback(state);
        } catch (error) {
          if (this.isCurrentLearningContext(state.context)) {
            state.failed = true;
            this.error = error.message || "播放记录保存失败，请重试当前记录。";
            state.player.pause();
          }
          return null;
        }
      });
      return state.queue;
    },
    async onLearningPlay(event) {
      const player = event?.currentTarget || this.$refs.learningVideo;
      let state;
      try {
        state = this.learningPlaybackState(player);
        if (state.playing || state.preparing || state.completed) return;
        state.preparing = true;
        player.pause();
        if (!state.row) {
          const row = await this.ensureLearningPlayback(state);
          if (!row || !this.isCurrentLearningContext(state.context)) return;
          if (Math.abs(player.currentTime * 1000 - state.position) > 1) {
            state.restoringPosition = true;
            player.currentTime = state.position / 1000;
          }
        }
        if (state.pending && state.pending.type !== "START") {
          if (!await this.queueLearningPlayback(state, "START", player.currentTime * 1000, player.playbackRate)
            || state.completed || !this.isCurrentLearningContext(state.context)) return;
        }
        const accepted = await this.queueLearningPlayback(state, "START", player.currentTime * 1000, player.playbackRate);
        if (!accepted || !this.isCurrentLearningContext(state.context)) return;
        state.playing = true;
        state.lastHeartbeatAt = Date.now();
        state.lastObservedPosition = player.currentTime * 1000;
        if (state.preparing) await player.play();
      } catch (error) {
        if (!state || this.isCurrentLearningContext(state.context)) this.error = error.message || "视频播放初始化失败，请重试。";
        player?.pause();
      } finally { if (state) state.preparing = false; }
    },
    onLearningMetadata() { this.applyPlayback(); },
    async onLearningPause(event) {
      try {
        const state = this.learningPlaybackState(event?.currentTarget);
        if (!state.row || !state.player.paused || state.player.ended || state.preparing || state.failed || state.completed || state.seeking || state.restoringPosition) return;
        state.playing = false;
        return await this.queueLearningPlayback(state, "PAUSE", state.player.currentTime * 1000, state.player.playbackRate);
      } catch (error) { this.error = error.message; }
    },
    async onLearningTimeUpdate(event) {
      try {
        const state = this.learningPlaybackState(event?.currentTarget);
        if (!state.playing || state.seeking || state.failed || state.completed || state.player.paused) return;
        state.lastObservedPosition = state.player.currentTime * 1000;
        if (Date.now() - state.lastHeartbeatAt < 5000) return;
        state.lastHeartbeatAt = Date.now();
        return await this.queueLearningPlayback(state, "HEARTBEAT", state.lastObservedPosition, state.player.playbackRate);
      } catch (error) { this.error = error.message; }
    },
    async onLearningSeeking(event) {
      try {
        const state = this.learningPlaybackState(event?.currentTarget);
        if (state.restoringPosition) return;
        state.seeking = true;
        if (state.row && !state.failed && !state.completed) await this.queueLearningPlayback(state, "PAUSE", state.lastObservedPosition, state.player.playbackRate);
      } catch (error) { this.error = error.message; }
    },
    async onLearningSeeked(event) {
      try {
        const state = this.learningPlaybackState(event?.currentTarget);
        if (state.restoringPosition) { state.restoringPosition = false; return; }
        state.seeking = false;
        state.lastObservedPosition = state.player.currentTime * 1000;
        state.playing = false;
        if (state.row && !state.completed && !state.player.paused) return await this.onLearningPlay({ currentTarget: state.player });
      } catch (error) { this.error = error.message; }
    },
    async onLearningEnded(event) {
      try {
        const state = this.learningPlaybackState(event?.currentTarget);
        if (!state.player.ended || !state.row) throw new Error("请实际完整播放视频后再检查完成结果。");
        if (state.completed) return this.finishCurrentVideo();
        return await this.queueLearningPlayback(state, "ENDED", state.player.currentTime * 1000, state.player.playbackRate);
      } catch (error) { this.error = error.message; }
    },
    async reportProgress() {
      try {
        const state = this.learningPlaybackState();
        if (!state.row) throw new Error("请先实际播放视频，再保存播放记录。");
        return await this.queueLearningPlayback(state, "HEARTBEAT", state.player.currentTime * 1000, state.player.playbackRate);
      } catch (error) { this.error = error.message; return null; }
    },
    async finishCurrentVideo() {
      try {
        const state = this.learningPlaybackState();
        if (state.completed) {
          if (this.videos.filter((item) => item.mustComplete !== false).every((item) => item.status === "finished")) return await this.finishAll(state.context);
          return this.nextVideo();
        }
        if (state.player.ended && state.row) return await this.onLearningEnded({ currentTarget: state.player });
        if (state.row) await this.reportProgress();
        this.error = "请实际完整播放视频后再检查完成结果。";
      } catch (error) { this.error = error.message; }
    },
    selectLearningVideo(index) {
      if (index === this.currentIndex) return;
      this.$refs.learningVideo?.pause();
      this.currentIndex = index;
    },
    nextVideo() {
      if (this.currentIndex < this.videos.length - 1) {
        this.selectLearningVideo(this.currentIndex + 1);
      }
    },
    async finishAll(context = this.learningContext()) {
      if (!context.sessionId || !this.isCurrentLearningContext(context)) return false;
      const wasBusy = this.busy;
      this.busy = true;
      this.error = "";
      try {
        const data = await FenghaoApi.screenComplete(context.sessionId, context.deviceToken);
        if (!this.isCurrentLearningContext(context)) return false;
        if (data?.sessionId !== context.sessionId) throw new Error("学习完成响应不匹配，请重试。");
        if (data.status !== "learning_completed" || data.allCompleted !== true) {
          throw new Error("服务端尚未确认全部视频完成，请重试。");
        }
        if (data.examUnlocked !== true || (context.assignmentId
          && (data.assignmentId !== context.assignmentId || data.gate?.status !== "EXAM_READY"))) {
          throw new Error("视频学习已完成，但手机端答题尚未解锁，请确认其他必学内容后重试。");
        }
        this.session = Object.assign({}, this.session, data);
        this.stage = "completed";
        this.message = "学习完成，手机端答题入口已解锁。";
        this.stopPolling();
        return true;
      } catch (error) {
        if (this.isCurrentLearningContext(context)) this.error = error.message || "学习完成确认失败，请重试。";
        return false;
      } finally {
        if (this.isCurrentLearningContext(context)) this.busy = wasBusy;
      }
    },
    async clearAndRestart() {
      if (!this.session.sessionId) return this.createSession();
      this.sessionEpoch += 1;
      this.$refs.learningVideo?.pause();
      this.playbackStates = {};
      const context = this.learningContext();
      this.stopPolling();
      this.busy = true;
      this.error = "";
      try {
        await FenghaoApi.screenClear(context.sessionId, context.deviceToken);
        if (!this.isCurrentLearningContext(context)) return;
        await this.createSession();
      } catch (error) {
        // createSession 会更新 epoch；只在仍属于本次操作时显示错误。
        if (this.isCurrentLearningContext(context)) this.error = error.message || "清空会话失败";
      } finally {
        if (this.isCurrentLearningContext(context)) {
          this.busy = false;
          this.startPolling();
        }
      }
    },
    async resetSession() {
      await this.clearAndRestart();
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
        if (data.passwordChangeRequired === true) {
          this.adminLoginForm.password = "";
          throw new Error("请先在现有管理后台修改初始密码，再返回此处登录。");
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
      this.cancelAssistantRequest();
      this.stopAssistantVoice();
    },
    cancelAssistantRequest() {
      this.assistantRequestId += 1;
      this.assistantAbort?.abort();
      this.assistantAbort = null;
      this.assistantBusy = false;
      this.assistantSpeakingThisTurn = false;
      this.assistantLiveStatus = "";
      this.assistantMessages.forEach((message) => { message.processing = ""; });
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
        const response = await fetch("/api/v1/assistant/status", { cache: "no-store", headers: this.deviceHeaders() });
        if (!response.ok) throw Object.assign(new Error("问答服务不可用"), { status: response.status });
        const status = await response.json();
        if (status.configured) {
          this.assistantConnection = "联网问答已配置 · 待实际提问验证";
          this.assistantConnectionMode = "online";
        } else {
          this.assistantConnection = "本地演示 · 未配置联网密钥";
          this.assistantConnectionMode = "demo";
        }
        this.assistantSpeechConfigured = Boolean(status.speech);
        this.setupAssistantVoice();
      } catch (error) {
        const pairingRequired = !this.deviceId || !this.deviceToken || error.status === 401;
        this.assistantConnection = pairingRequired ? "请先完成大屏设备配对" : "服务暂不可用";
        this.assistantConnectionMode = pairingRequired ? "pairing" : "error";
        this.assistantSpeechConfigured = false;
        this.setupAssistantVoice();
      }
    },
    setupAssistantVoice() {
      if (!this.assistantVoice && typeof window.createVoice === "function") {
        const screen = this;
        this.assistantVoice = window.createVoice({
          deviceId: this.deviceId,
          deviceToken: this.deviceToken,
          onInterrupt() { screen.cancelAssistantRequest(); },
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
      if (this.assistantConnectionMode === "pairing") {
        this.assistantVoiceHint = "请先完成大屏设备配对，再使用语音问答";
      } else if (this.assistantConnectionMode === "error") {
        this.assistantVoiceHint = "语音服务状态暂无法确认，请稍后重试";
      } else if (!browserSupported) {
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
      this.assistantVoice?.stopListening?.();
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
      if (!question) return;
      if (this.assistantBusy) this.cancelAssistantRequest();
      const requestId = ++this.assistantRequestId;
      const controller = new AbortController();
      this.assistantAbort = controller;
      const userMessage = { role: "user", content: question, references: [], followUps: [] };
      const assistantMessage = { role: "assistant", content: "", processing: "正在理解问题", references: [], followUps: [] };
      this.assistantMessages.push(userMessage, assistantMessage);
      this.assistantInput = "";
      this.assistantLiveAnswer = "";
      this.assistantLiveStatus = assistantMessage.processing;
      this.assistantBusy = true;
      this.scrollAssistantToLatest();
      this.assistantSpeakingThisTurn = Boolean(this.assistantVoice && this.assistantSpeechEnabled && this.assistantSpeakReplies);
      try {
        if (this.assistantSpeakingThisTurn) {
          this.assistantVoice.preparePlayback?.();
          const speaking = await this.assistantVoice.beginSpeech(this.assistantSpeechRate);
          if (requestId !== this.assistantRequestId) return;
          if (speaking === false) this.assistantSpeakingThisTurn = false;
        }
        const messages = this.assistantMessages
          .filter((item) => !item.localOnly && (item.role === "user" || (item.role === "assistant" && item.content)))
          .slice(-10)
          .map((item) => ({ role: item.role, content: item.content }));
        const response = await fetch("/api/v1/assistant/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...this.deviceHeaders() },
          body: JSON.stringify({ messages }),
          signal: controller.signal,
        });
        if (requestId !== this.assistantRequestId) return;
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload?.error?.message || "问答服务暂不可用，请稍后重试。");
        }
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("text/event-stream")) {
          await this.readAssistantStream(response, assistantMessage, requestId);
        } else {
          const frame = await response.json();
          if (requestId !== this.assistantRequestId) return;
          this.consumeAssistantFrame(assistantMessage, frame);
        }
        if (requestId !== this.assistantRequestId) return;
        if (!assistantMessage.content) assistantMessage.content = "暂未收到有效回答，请稍后重试。";
        this.assistantLiveAnswer = assistantMessage.content;
        this.assistantLiveStatus = "";
        assistantMessage.processing = "";
        if (this.assistantSpeakingThisTurn) this.assistantVoice.endSpeech();
      } catch (error) {
        if (requestId !== this.assistantRequestId) return;
        if (this.assistantSpeakingThisTurn) this.assistantVoice.cancelSpeech();
        assistantMessage.processing = "";
        assistantMessage.content = `抱歉，本次问答未能完成。**${error?.message || "服务暂不可用，请稍后重试。"}**`;
        this.assistantLiveAnswer = assistantMessage.content;
        this.assistantLiveStatus = "";
        this.assistantConnection = "服务暂不可用";
        this.assistantConnectionMode = "error";
      } finally {
        if (requestId === this.assistantRequestId) {
          this.assistantAbort = null;
          this.assistantSpeakingThisTurn = false;
          this.assistantBusy = false;
          this.scrollAssistantToLatest();
          this.$nextTick(() => this.$refs.assistantInput?.focus());
        }
      }
    },
    async readAssistantStream(response, message, requestId = this.assistantRequestId) {
      const reader = response.body?.getReader();
      if (!reader) throw new Error("未收到流式问答内容。");
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let done = false;
      while (!done) {
        const packet = await reader.read();
        if (requestId !== this.assistantRequestId) {
          await reader.cancel().catch(() => {});
          return;
        }
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
