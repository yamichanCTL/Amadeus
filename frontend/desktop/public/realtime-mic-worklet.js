// Keep capture and resampling off the page's main thread. Never store audio.
class AmadeusMicrophone extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputFrame = 0;
    this.nextOutputFrame = 0;
    this.previousSample = 0;
    this.step = sampleRate / 16000;
    this.packet = new Int16Array(1600); // 100 ms at 16 kHz.
    this.packetLength = 0;
    this.levelFrames = 0;
    this.levelPower = 0;
    this.levelPeak = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type === "flush") {
        this.emitPacket();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  emitPacket() {
    if (!this.packetLength) return;
    const pcm = this.packetLength === this.packet.length
      ? this.packet : this.packet.slice(0, this.packetLength);
    this.port.postMessage({
      type: "packet", pcm: pcm.buffer,
      rms: Math.sqrt(this.levelPower / Math.max(1, this.levelFrames)),
      peak: this.levelPeak,
    }, [pcm.buffer]);
    this.packet = new Int16Array(1600);
    this.packetLength = 0;
    this.levelFrames = 0;
    this.levelPower = 0;
    this.levelPeak = 0;
  }

  process(inputs, outputs) {
    for (const channel of outputs[0] || []) channel.fill(0);
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i += 1) {
      const current = input[i];
      const frame = this.inputFrame++;
      this.levelPower += current * current;
      this.levelPeak = Math.max(this.levelPeak, Math.abs(current));
      this.levelFrames += 1;
      while (this.nextOutputFrame <= frame) {
        const fraction = frame === 0 ? 1 : this.nextOutputFrame - (frame - 1);
        const value = frame === 0 ? current
          : this.previousSample + (current - this.previousSample) * fraction;
        const clipped = Math.max(-1, Math.min(1, value));
        this.packet[this.packetLength++] = clipped < 0
          ? Math.round(clipped * 32768) : Math.round(clipped * 32767);
        this.nextOutputFrame += this.step;
        if (this.packetLength === this.packet.length) this.emitPacket();
      }
      this.previousSample = current;
    }
    return true;
  }
}

registerProcessor("amadeus-microphone", AmadeusMicrophone);
