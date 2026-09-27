"use client";

// MediaRecorder wrapper: opus/webm at ~32 kbps with noise suppression, mp4 fallback (iOS).

export type Recording = { blob: Blob; mimeType: string; durationMs: number };

function pickMime(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const c of candidates) if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
  return "";
}

export class Recorder {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private stopResolve: ((r: Recording) => void) | null = null;
  onLevel?: (level: number) => void;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private audioCtx: AudioContext | null = null;

  async start(onStarted?: () => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { noiseSuppression: true, echoCancellation: true, channelCount: 1 },
    });
    const mimeType = pickMime();
    this.rec = new MediaRecorder(this.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 });
    this.chunks = [];
    this.rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.rec.onstart = () => {
      this.startedAt = Date.now();
      onStarted?.();
    };
    this.rec.start(250);

    // simple level meter for the listening ring
    try {
      this.audioCtx = new AudioContext();
      const src = this.audioCtx.createMediaStreamSource(this.stream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      this.levelTimer = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += Math.abs(v - 128);
        this.onLevel?.(Math.min(1, sum / buf.length / 40));
      }, 80);
    } catch {}
  }

  /** Stop and return the blob. Resolves even if stop fires twice. */
  stop(): Promise<Recording> {
    return new Promise((resolve) => {
      if (!this.rec || this.rec.state === "inactive") {
        this.cleanup();
        resolve({ blob: new Blob(this.chunks), mimeType: this.rec?.mimeType ?? "audio/webm", durationMs: Date.now() - this.startedAt });
        return;
      }
      this.stopResolve = resolve;
      this.rec.onstop = () => {
        const r: Recording = {
          blob: new Blob(this.chunks, { type: this.rec?.mimeType ?? "audio/webm" }),
          mimeType: (this.rec?.mimeType ?? "audio/webm").split(";")[0],
          durationMs: Date.now() - this.startedAt,
        };
        this.cleanup();
        this.stopResolve?.(r);
        this.stopResolve = null;
      };
      try {
        this.rec.stop();
      } catch {
        this.cleanup();
        resolve({ blob: new Blob(this.chunks), mimeType: "audio/webm", durationMs: Date.now() - this.startedAt });
      }
    });
  }

  cancel(): void {
    try {
      if (this.rec && this.rec.state !== "inactive") this.rec.stop();
    } catch {}
    this.cleanup();
  }

  private cleanup(): void {
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = null;
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
