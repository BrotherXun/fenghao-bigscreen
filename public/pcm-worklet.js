// 麦克风采集处理器：重采样到 16kHz、打包成 PCM16、并在音频线程内计算能量。
// 判停放在这里而不是主线程，是为了不受页面渲染卡顿影响——它决定“用户说完了”的时刻，
// 直接落在首字延迟的关键路径上。

const TARGET_RATE = 16000;
const FRAME_SAMPLES = 1600; // 100ms @ 16kHz

class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(FRAME_SAMPLES);
    this.filled = 0;
    this.ratio = sampleRate / TARGET_RATE;
    this.cursor = 0;
    this.active = true;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "stop") {
        this.active = false;
      }
    };
  }

  emit() {
    let sum = 0;
    const pcm = new Int16Array(FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i += 1) {
      const sample = Math.max(-1, Math.min(1, this.buffer[i]));
      sum += sample * sample;
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    this.port.postMessage(
      { type: "audio", pcm: pcm.buffer, level: Math.sqrt(sum / FRAME_SAMPLES) },
      [pcm.buffer]
    );
    this.filled = 0;
  }

  process(inputs) {
    if (!this.active) {
      return false;
    }
    const channel = inputs[0] && inputs[0][0];
    if (!channel || !channel.length) {
      return true;
    }

    // 线性重采样：浏览器多数以 48kHz 采集，火山识别要求 16kHz 单声道。
    while (this.cursor < channel.length) {
      const index = Math.floor(this.cursor);
      const fraction = this.cursor - index;
      const current = channel[index];
      const next = index + 1 < channel.length ? channel[index + 1] : current;
      this.buffer[this.filled] = current + (next - current) * fraction;
      this.filled += 1;
      if (this.filled >= FRAME_SAMPLES) {
        this.emit();
      }
      this.cursor += this.ratio;
    }
    this.cursor -= channel.length;
    return true;
  }
}

registerProcessor("pcm-worklet", PcmWorklet);
