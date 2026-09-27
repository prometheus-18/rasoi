"use client";

// Hold-to-talk, hybrid spec (docs/PLAN.md):
//  hold > 600 ms → release sends · quick tap → recording starts, "भेजो" stops it
//  pointercancel → send · min 0.8 s else discard with a hint · max 60 s auto-send
//  cue (vibrate) after recorder onstart · touch-action:none · setPointerCapture · wake lock
// Leak-proof: releasing during getUserMedia cancels the pending start; unmount cancels a live recording.

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

type Mode = "idle" | "starting" | "hold" | "tap";

export function MicButton({ disabled, onRecording, onStart }: Props) {
  const [mode, setMode] = useState<Mode>("idle");
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const recRef = useRef<Recorder | null>(null);
  const downAtRef = useRef(0);
  const releasedDuringStart = useRef(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const maxRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeRef = useRef<{ release?: () => Promise<void> } | null>(null);
  const modeRef = useRef<Mode>("idle");
  const mounted = useRef(true);
  modeRef.current = mode;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cleanupTimers();
      recRef.current?.cancel(); // never leave the mic on after navigating away
      recRef.current = null;
    };
  }, []);

  function cleanupTimers() {
    if (tickRef.current) clearInterval(tickRef.current);
    if (maxRef.current) clearTimeout(maxRef.current);
    tickRef.current = null;
    maxRef.current = null;
    wakeRef.current?.release?.().catch(() => {});
    wakeRef.current = null;
  }

  function setModeSafe(m: Mode) {
    modeRef.current = m;
    if (mounted.current) setMode(m);
  }

  async function begin() {
    if (disabled || modeRef.current !== "idle") return;
    setHint(null);
    setModeSafe("starting");
    downAtRef.current = Date.now();
    releasedDuringStart.current = false;
    onStart?.();
    const rec = new Recorder();
    rec.onLevel = (l) => mounted.current && setLevel(l);
    recRef.current = rec;
    try {
      await rec.start(() => {
        try {
          navigator.vibrate?.(30);
        } catch {}
      });
    } catch (e) {
      recRef.current = null;
      setModeSafe("idle");
      if (String((e as Error)?.message) !== "cancelled") setHint("माइक चालू नहीं हुआ — Chrome में इजाज़त दें");
      return;
    }
    if (!mounted.current || recRef.current !== rec) {
      rec.cancel();
      return;
    }
    if (releasedDuringStart.current) {
      // finger came up while the mic was still starting: a quick tap → tap mode, a hold → discard
      if (Date.now() - downAtRef.current > HOLD_MS) {
        rec.cancel();
        recRef.current = null;
        setModeSafe("idle");
        setHint("दबाकर रखें और बोलें");
        return;
      }
    }
    try {
      wakeRef.current = await (navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request?.("screen") ?? null;
    } catch {}
    setSeconds(0);
    tickRef.current = setInterval(() => mounted.current && setSeconds((s) => s + 1), 1000);
    maxRef.current = setTimeout(() => void finish(), MAX_MS);
    setModeSafe(releasedDuringStart.current ? "tap" : "hold");
  }

  async function finish() {
    const rec = recRef.current;
    if (!rec || modeRef.current === "idle") return;
    setModeSafe("idle");
    cleanupTimers();
    recRef.current = null;
    if (!rec.active) {
      rec.cancel();
      setLevel(0);
      return;
    }
    const r = await rec.stop();
    if (!mounted.current) return;
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
    if (modeRef.current === "starting") {
      releasedDuringStart.current = true; // begin() decides once the mic is actually up
      return;
    }
    const heldMs = Date.now() - downAtRef.current;
    if (heldMs > HOLD_MS) void finish();
    else setModeSafe("tap"); // quick tap → keep listening until "भेजो"
  }

  function onPointerCancel() {
    if (modeRef.current === "starting") {
      recRef.current?.cancel();
      recRef.current = null;
      setModeSafe("idle");
      return;
    }
    void finish(); // spec: pointercancel sends
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
          onPointerCancel={onPointerCancel}
          onContextMenu={(e) => e.preventDefault()}
          className={`mic-safe relative z-10 flex h-44 w-44 items-center justify-center rounded-full shadow-[0_10px_40px_rgba(232,93,38,0.45)] transition-transform select-none ${
            listening ? "bg-gradient-to-b from-brand to-brand-deep" : "bg-gradient-to-b from-[#F97316] to-brand-deep active:scale-95"
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
        <button type="button" onClick={() => void finish()} className="rounded-full bg-go px-10 py-3 text-2xl font-bold text-white shadow-lg active:scale-95">
          भेजो ➤
        </button>
      ) : (
        <p className="text-xl font-semibold text-faint">{listening ? `सुन रहे हैं… ${seconds ? seconds + "s" : ""}` : "दबाकर बोलिए"}</p>
      )}
      {hint && <p className="rounded-xl bg-warn-bg px-4 py-2 text-lg font-semibold text-warn">{hint}</p>}
    </div>
  );
}
