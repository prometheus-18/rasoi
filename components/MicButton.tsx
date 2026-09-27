"use client";

// Hold-to-talk, hybrid spec (docs/PLAN.md):
//  hold > 600 ms → release sends · quick tap → recording starts, "भेजो" stops it
//  pointercancel → send · min 0.8 s else discard with a hint · max 60 s auto-send
//  cue (vibrate) after recorder onstart · touch-action:none · setPointerCapture · wake lock

import { useEffect, useRef, useState } from "react";
import { Recorder, type Recording } from "@/lib/client/recorder";
import { speakHi } from "@/lib/client/tts";

const MIN_MS = 800;
const MAX_MS = 60_000;
const HOLD_MS = 600;

type Props = {
  disabled?: boolean;
  onRecording: (r: Recording) => void;
  onStart?: () => void;
};

export function MicButton({ disabled, onRecording, onStart }: Props) {
  const [mode, setMode] = useState<"idle" | "starting" | "hold" | "tap">("idle");
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const recRef = useRef<Recorder | null>(null);
  const downAtRef = useRef(0);
  const startedRef = useRef(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const maxRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeRef = useRef<any>(null);
  const modeRef = useRef<typeof mode>("idle");
  modeRef.current = mode;

  useEffect(() => () => cleanupTimers(), []);

  function cleanupTimers() {
    if (tickRef.current) clearInterval(tickRef.current);
    if (maxRef.current) clearTimeout(maxRef.current);
    tickRef.current = null;
    maxRef.current = null;
    wakeRef.current?.release?.().catch(() => {});
    wakeRef.current = null;
  }

  async function begin() {
    if (disabled || modeRef.current !== "idle") return;
    setHint(null);
    setMode("starting");
    downAtRef.current = Date.now();
    startedRef.current = false;
    onStart?.();
    const rec = new Recorder();
    rec.onLevel = setLevel;
    recRef.current = rec;
    try {
      await rec.start(() => {
        startedRef.current = true;
        try {
          navigator.vibrate?.(30);
        } catch {}
      });
    } catch {
      setMode("idle");
      setHint("माइक चालू नहीं हुआ — Chrome में इजाज़त दें");
      return;
    }
    try {
      wakeRef.current = await (navigator as any).wakeLock?.request?.("screen");
    } catch {}
    setSeconds(0);
    tickRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    maxRef.current = setTimeout(() => void finish(), MAX_MS);
    // if the finger is already up (very fast tap), stay in tap mode
    setMode((m) => (m === "starting" ? (Date.now() - downAtRef.current > HOLD_MS ? "hold" : "tap") : m));
  }

  async function finish() {
    const rec = recRef.current;
    if (!rec || modeRef.current === "idle") return;
    setMode("idle");
    cleanupTimers();
    const r = await rec.stop();
    recRef.current = null;
    setLevel(0);
    if (r.durationMs < MIN_MS || r.blob.size < 800) {
      setHint("दबाकर रखें और बोलें");
      void speakHi("दबाकर रखिए और बोलिए");
      return;
    }
    onRecording(r);
  }

  function onPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    if (modeRef.current === "tap") {
      void finish(); // tap again to send
      return;
    }
    void begin();
  }

  function onPointerUp() {
    if (modeRef.current === "idle") return;
    const heldMs = Date.now() - downAtRef.current;
    if (heldMs > HOLD_MS) void finish();
    else setMode("tap"); // quick tap → keep listening until "भेजो"
  }

  const listening = mode === "hold" || mode === "tap" || mode === "starting";

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative">
        {listening && (
          <>
            <span className="absolute inset-0 rounded-full bg-brand/40 animate-pulse-ring" />
            <span className="absolute inset-0 rounded-full bg-brand/25 animate-pulse-ring [animation-delay:0.5s]" />
          </>
        )}
        <button
          type="button"
          aria-label="बोलने के लिए दबाएं"
          disabled={disabled}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => void finish()}
          onContextMenu={(e) => e.preventDefault()}
          className={`mic-safe relative z-10 flex h-44 w-44 items-center justify-center rounded-full shadow-[0_10px_40px_rgba(232,93,38,0.45)] transition-transform select-none ${
            listening ? "scale-110 bg-gradient-to-b from-brand to-brand-deep" : "bg-gradient-to-b from-[#F97316] to-brand-deep active:scale-95"
          } ${disabled ? "opacity-40 grayscale" : ""}`}
          style={{ transform: listening ? `scale(${1.08 + level * 0.1})` : undefined }}
        >
          <svg viewBox="0 0 24 24" className="h-20 w-20 fill-white" aria-hidden>
            <path d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-6a3.5 3.5 0 1 0-7 0v6A3.5 3.5 0 0 0 12 15Z" />
            <path d="M5.5 11.5a.9.9 0 0 1 1.8 0 4.7 4.7 0 0 0 9.4 0 .9.9 0 0 1 1.8 0 6.5 6.5 0 0 1-5.6 6.42V20h2.2a.9.9 0 0 1 0 1.8H8.9a.9.9 0 0 1 0-1.8h2.2v-2.08a6.5 6.5 0 0 1-5.6-6.42Z" />
          </svg>
        </button>
      </div>

      {mode === "tap" ? (
        <button
          type="button"
          onClick={() => void finish()}
          className="rounded-full bg-go px-10 py-3 text-2xl font-bold text-white shadow-lg active:scale-95"
        >
          भेजो ➤
        </button>
      ) : (
        <p className="text-xl font-semibold text-faint">{listening ? `सुन रहे हैं… ${seconds ? seconds + "s" : ""}` : "दबाकर बोलिए"}</p>
      )}
      {hint && <p className="rounded-xl bg-warn-bg px-4 py-2 text-lg font-semibold text-warn">{hint}</p>}
    </div>
  );
}
