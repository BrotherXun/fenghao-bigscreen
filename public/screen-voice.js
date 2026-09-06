// 浏览器端语音控制器。
// 上行：麦克风 → PCM16/16k → /ws/voice → 火山大模型流式语音识别
// 下行：火山语音合成大模型 → PCM16/24k → /ws/voice → Web Audio 逐块播放
//
// 三处直接决定体感延迟：
//   1. 判停靠能量 VAD，静音 600ms 即收口，不等用户手动松手；
//   2. 提问瞬间就预热合成连接，第一句文本到达时握手已完成；
//   3. 回答的第一句允许在逗号处切分，让它更早进入合成。

(function () {
  "use strict";

  var FRAME_MS = 100;
  var SILENCE_FRAMES = 6;          // 说完后 600ms 静音即判定收口
  var SPEECH_FRAMES_IDLE = 2;      // 聆听态连续 200ms 有声即认为开始说话
  var SPEECH_FRAMES_PLAYING = 4;   // 播放态需连续 400ms，避免外放回声误触发
  var LEVEL_IDLE = 0.02;
  var LEVEL_PLAYING = 0.06;
  var MIN_SPEECH_FRAMES = 3;       // 短于 300ms 的声音当噪声丢弃
  var FIRST_SENTENCE_MIN = 6;      // 首句最短切分长度，约 1.5 秒语音，短于此会显得断续
  var FORCE_SPLIT_AT = 60;         // 单句过长时强制在逗号处切开
  var BARGE_PREROLL_FRAMES = 8;    // 播报时仅保留最近 800ms 的疑似用户语音
  var MAX_PENDING_ASR_FRAMES = 30; // 识别握手期间最多缓存 3 秒，避免弱网下无限增长

  function stripMarkdownForSpeech(value) {
    return String(value || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[ref_\d+\]/g, " ")
      .replace(/\*\*([^*]*)\*\*/g, "$1")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/^#{1,6}\s*/gm, "")
      .replace(/[#>|]/g, " ")
      // 保留换行：它是列表项之间天然的断句点。
      .replace(/[^\S\n]+/g, " ");
  }

  function createVoice(handlers) {
    var socket = null;
    var captureContext = null;
    var playbackContext = null;
    var workletNode = null;
    var micStream = null;
    var micSource = null;

    var connected = false;
    var listening = false;      // 麦克风开关（用户意图）
    var asrActive = false;      // 是否正在向识别服务送音频
    var asrReady = false;       // 火山识别连接已完成配置，可接收 PCM
    var asrStopPending = false; // 用户已说完，但识别握手尚未完成
    var pendingAsrAudio = [];
    var continuous = true;
    var mode = "idle";          // idle | listening | recording | thinking | playing

    var speechRun = 0;
    var silenceRun = 0;
    var speechFrames = 0;
    var hasSpeech = false;

    var playQueue = [];
    var activeSources = [];
    var nextPlayTime = 0;
    var ttsSampleRate = 24000;
    var awaitingTtsEnd = false;

    var speechBuffer = "";
    var spokenFirstSentence = false;
    var bargeInAudio = [];

    function emitState(next) {
      if (mode !== next) {
        mode = next;
        handlers.onStateChange(next);
      }
    }

    function fail(scope, message) {
      handlers.onError(scope, message);
    }

    function send(payload) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
      }
    }

    function queueAsrAudio(pcm) {
      if (!pcm || !asrActive) {
        return;
      }
      if (asrReady && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(pcm);
        return;
      }
      pendingAsrAudio.push(pcm);
      if (pendingAsrAudio.length > MAX_PENDING_ASR_FRAMES) {
        pendingAsrAudio.shift();
      }
    }

    function resetAsrBuffer() {
      asrReady = false;
      asrStopPending = false;
      pendingAsrAudio = [];
    }

    function flushAsrAudio() {
      if (!asrReady || !socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      pendingAsrAudio.forEach(function (pcm) { socket.send(pcm); });
      pendingAsrAudio = [];
    }

    // ---------- 播放 ----------

    function ensurePlaybackContext() {
      if (!playbackContext) {
        playbackContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (playbackContext.state === "suspended") {
        playbackContext.resume();
      }
      return playbackContext;
    }

    function enqueueAudio(arrayBuffer) {
      var context = ensurePlaybackContext();
      var pcm = new Int16Array(arrayBuffer);
      if (!pcm.length) {
        return;
      }
      var buffer = context.createBuffer(1, pcm.length, ttsSampleRate);
      var channel = buffer.getChannelData(0);
      for (var i = 0; i < pcm.length; i += 1) {
        channel[i] = pcm[i] / 0x8000;
      }
      var source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);

      var startAt = Math.max(context.currentTime + 0.02, nextPlayTime);
      source.start(startAt);
      nextPlayTime = startAt + buffer.duration;
      activeSources.push(source);
      source.onended = function () {
        var index = activeSources.indexOf(source);
        if (index !== -1) {
          activeSources.splice(index, 1);
        }
        if (!activeSources.length && awaitingTtsEnd === false && mode === "playing") {
          finishPlayback();
        }
      };
      emitState("playing");
    }

    function stopPlayback() {
      activeSources.forEach(function (source) {
        try {
          source.onended = null;
          source.stop();
        } catch (error) {
          // 已结束的节点再次 stop 会抛错，忽略即可。
        }
      });
      activeSources = [];
      playQueue = [];
      nextPlayTime = 0;
    }

    function finishPlayback() {
      nextPlayTime = 0;
      if (listening && continuous) {
        resumeListening();
      } else {
        emitState(listening ? "listening" : "idle");
      }
    }

    // ---------- 判停与打断 ----------

    function handleLevel(level, pcm) {
      var playing = mode === "playing";
      var threshold = playing ? LEVEL_PLAYING : LEVEL_IDLE;
      var needed = playing ? SPEECH_FRAMES_PLAYING : SPEECH_FRAMES_IDLE;

      if (level >= threshold) {
        speechRun += 1;
        silenceRun = 0;
        if (playing && pcm) {
          bargeInAudio.push(pcm);
          if (bargeInAudio.length > BARGE_PREROLL_FRAMES) {
            bargeInAudio.shift();
          }
        }
      } else {
        silenceRun += 1;
        speechRun = 0;
        if (playing) {
          bargeInAudio = [];
        }
      }

      if (playing) {
        // 播放期间检测到用户开口，立刻停嘴并转入新一轮聆听。
        if (speechRun >= needed) {
          bargeIn();
          return true; // 当前帧已被写入打断预录音，不能重复发送。
        }
        return false;
      }

      if (!asrActive) {
        return false;
      }

      if (speechRun >= needed && !hasSpeech) {
        hasSpeech = true;
        emitState("recording");
      }
      if (hasSpeech) {
        speechFrames += 1;
        if (silenceRun >= SILENCE_FRAMES) {
          closeUtterance();
        }
      }
      return false;
    }

    function closeUtterance() {
      if (!asrActive) {
        return;
      }
      asrActive = false;
      if (speechFrames < MIN_SPEECH_FRAMES) {
        // 噪声误触发：丢弃本段，直接重开聆听。
        resetAsrBuffer();
        send({ type: "asr_abort" });
        resumeListening();
        return;
      }
      if (asrReady) {
        send({ type: "asr_stop" });
      } else {
        asrStopPending = true;
      }
      emitState("thinking");
    }

    function bargeIn() {
      var preRoll = bargeInAudio.slice();
      bargeInAudio = [];
      send({ type: "tts_cancel" });
      stopPlayback();
      awaitingTtsEnd = false;
      resumeListening(preRoll);
    }

    function resumeListening(preRoll) {
      if (!listening || !connected) {
        emitState(listening ? "listening" : "idle");
        return;
      }
      asrReady = false;
      asrStopPending = false;
      pendingAsrAudio = Array.isArray(preRoll) ? preRoll.slice(-MAX_PENDING_ASR_FRAMES) : [];
      hasSpeech = pendingAsrAudio.length > 0;
      speechRun = 0;
      silenceRun = 0;
      speechFrames = pendingAsrAudio.length;
      asrActive = true;
      send({ type: "asr_start" });
      emitState(hasSpeech ? "recording" : "listening");
    }

    // ---------- 麦克风 ----------

    async function ensureMic() {
      if (workletNode) {
        if (captureContext.state === "suspended") {
          await captureContext.resume();
        }
        return;
      }
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      captureContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      await captureContext.audioWorklet.addModule("pcm-worklet.js");
      micSource = captureContext.createMediaStreamSource(micStream);
      workletNode = new AudioWorkletNode(captureContext, "pcm-worklet");
      workletNode.port.onmessage = function (event) {
        var data = event.data;
        if (!data || data.type !== "audio") {
          return;
        }
        var consumedByBargeIn = handleLevel(data.level, data.pcm);
        if (!consumedByBargeIn && asrActive) {
          queueAsrAudio(data.pcm);
        }
      };
      micSource.connect(workletNode);
      // 必须接到 destination，否则音频图不会被拉动、process 不会执行。
      // 处理器从不写 outputs，所以输出是静音，不会把麦克风原声播出去形成回授。
      workletNode.connect(captureContext.destination);
    }

    function releaseMic() {
      if (workletNode) {
        workletNode.port.postMessage({ type: "stop" });
        workletNode.disconnect();
        workletNode = null;
      }
      if (micSource) {
        micSource.disconnect();
        micSource = null;
      }
      if (micStream) {
        micStream.getTracks().forEach(function (track) { track.stop(); });
        micStream = null;
      }
      if (captureContext) {
        captureContext.close();
        captureContext = null;
      }
    }

    // ---------- 连接 ----------

    function connect() {
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        return Promise.resolve(connected);
      }
      return new Promise(function (resolve) {
        var protocol = location.protocol === "https:" ? "wss://" : "ws://";
        var next = new WebSocket(protocol + location.host + "/ws/voice");
        next.binaryType = "arraybuffer";
        socket = next;

        next.onopen = function () {
          connected = true;
          resolve(true);
        };
        next.onclose = function () {
          connected = false;
          if (listening) {
            listening = false;
            releaseMic();
            emitState("idle");
            fail("connection", "语音通道已断开。");
          }
          resolve(false);
        };
        next.onerror = function () {
          connected = false;
          resolve(false);
        };
        next.onmessage = function (event) {
          if (typeof event.data !== "string") {
            enqueueAudio(event.data);
            return;
          }
          handleControl(JSON.parse(event.data));
        };
      });
    }

    function handleControl(message) {
      switch (message.type) {
        case "hello":
          ttsSampleRate = message.ttsSampleRate || 24000;
          break;
        case "asr_ready":
          asrReady = true;
          flushAsrAudio();
          if (asrStopPending) {
            asrStopPending = false;
            send({ type: "asr_stop" });
          } else if (!asrActive) {
            send({ type: "asr_abort" });
          }
          break;
        case "asr_partial":
          handlers.onPartialTranscript(message.text || "");
          break;
        case "asr_final":
          handleFinalTranscript(message.text || "");
          break;
        case "tts_begin":
          ttsSampleRate = message.sampleRate || ttsSampleRate;
          break;
        case "tts_end":
          awaitingTtsEnd = false;
          if (!activeSources.length) {
            finishPlayback();
          }
          break;
        case "error":
          fail(message.scope, message.message);
          if (message.scope === "asr") {
            resetAsrBuffer();
            resumeListening();
          }
          break;
        default:
          break;
      }
    }

    function handleFinalTranscript(text) {
      var value = String(text || "").trim();
      resetAsrBuffer();
      handlers.onPartialTranscript("");
      if (!value) {
        resumeListening();
        return;
      }
      handlers.onFinalTranscript(value);
    }

    // ---------- 文本切句 ----------

    function takeSentence(force) {
      var text = speechBuffer;
      if (!text) {
        return "";
      }
      // 只认全角句读：ASCII 的 ? ! ; 会出现在网址和实体里，用它们断句会把链接劈成两半。
      var hardBreak = text.search(/[。！？；\n]/);
      if (hardBreak !== -1) {
        var sentence = text.slice(0, hardBreak + 1);
        speechBuffer = text.slice(hardBreak + 1);
        return sentence;
      }
      var softBreak = text.search(/[，、]/);
      if (softBreak !== -1) {
        // 首句：逗号只要落在最短长度之后就提前送出，抢下第一句的合成时间。
        // 后续句：只有整句攒得过长才在逗号处泄压，否则保持语气完整。
        var ready = spokenFirstSentence
          ? text.length >= FORCE_SPLIT_AT
          : softBreak + 1 >= FIRST_SENTENCE_MIN;
        if (ready) {
          var soft = text.slice(0, softBreak + 1);
          speechBuffer = text.slice(softBreak + 1);
          return soft;
        }
      }
      if (force && text.trim()) {
        speechBuffer = "";
        return text;
      }
      return "";
    }

    function flushSentences(force) {
      var sentence = takeSentence(force);
      while (sentence) {
        var clean = sentence.trim();
        // 只剩标点或空白的片段不值得发一次合成请求。
        if (clean && /[\p{L}\p{N}]/u.test(clean)) {
          send({ type: "tts_text", text: clean });
          spokenFirstSentence = true;
        }
        sentence = takeSentence(force);
      }
    }

    // ---------- 对外接口 ----------

    return {
      isAvailable: function () {
        return Boolean(navigator.mediaDevices && window.AudioWorklet);
      },
      isListening: function () {
        return listening;
      },
      setContinuous: function (value) {
        continuous = Boolean(value);
      },
      connect: connect,

      startListening: async function () {
        if (listening) {
          return true;
        }
        var ok = await connect();
        if (!ok) {
          fail("connection", "无法连接语音通道，请确认服务端已配置语音密钥。");
          return false;
        }
        try {
          await ensureMic();
        } catch (error) {
          fail("mic", "无法访问麦克风：" + (error && error.message || "权限被拒绝"));
          return false;
        }
        ensurePlaybackContext();
        listening = true;
        resumeListening();
        return true;
      },

      stopListening: function () {
        listening = false;
        asrActive = false;
        resetAsrBuffer();
        bargeInAudio = [];
        send({ type: "asr_abort" });
        // 关麦克风的同时必须掐掉播报：否则音频会继续播完，
        // 而此时麦克风已关、开口打断也失效，等于没有任何办法叫停。
        awaitingTtsEnd = false;
        speechBuffer = "";
        send({ type: "tts_cancel" });
        stopPlayback();
        releaseMic();
        emitState("idle");
      },

      // 在用户主动发送问题时调用，避免浏览器把首段播报当成非用户触发的自动播放。
      preparePlayback: function () {
        ensurePlaybackContext();
      },

      // 提问瞬间调用：预热合成连接，等第一句文本到达时握手已完成。
      beginSpeech: function (speedRatio) {
        speechBuffer = "";
        spokenFirstSentence = false;
        awaitingTtsEnd = true;
        stopPlayback();
        emitState("thinking");
        send({ type: "tts_start", speedRatio: Number(speedRatio) || 1.2 });
      },

      pushText: function (delta) {
        if (!awaitingTtsEnd) {
          return;
        }
        // 先清洗再切句：markdown 会跨增量到达，必须等它拼完整才能安全剥离，
        // 否则半截链接里的标点会被当成句末，网址也会被念出来。
        speechBuffer = stripMarkdownForSpeech(speechBuffer + String(delta || ""));
        flushSentences(false);
      },

      endSpeech: function () {
        if (!awaitingTtsEnd) {
          return;
        }
        flushSentences(true);
        send({ type: "tts_end" });
      },

      cancelSpeech: function () {
        awaitingTtsEnd = false;
        speechBuffer = "";
        send({ type: "tts_cancel" });
        stopPlayback();
        if (listening) {
          resumeListening();
        } else {
          emitState("idle");
        }
      }
    };
  }

  window.createVoice = createVoice;
}());
