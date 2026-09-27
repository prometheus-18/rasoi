"use client";

// Hold 1.5 s to confirm — a filling ring; releasing early cancels.

import { useRef, useState } from "react";

const HOLD_MS = 1500;

export function HoldConfirm({ label, holdingLabel, onConfirmed }: { label: string; holdingLabel: string; onConfirmed: () => void }) {
  const [progress, setProgress] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef(0);
  const doneRef = useRef(false);

  function start(e: React.PointerEvent<HTMLButtonElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    if (doneRef.current) return;
    startRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const p = Math.min(1, (Date.now() - startRef.current) / HOLD_MS);
      setProgress(p);
      if (p >= 1 && !doneRef.current) {
        doneRef.current = true;
        stopTimer();
        try {
          navigator.vibrate?.(60);
        } catch {}
        onConfirmed();
      }
    }, 40);
  }

  function stopTimer() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }

  function cancel() {
    if (doneRef.current) return;
    stopTimer();
    setProgress(0);
  }

  return (
    <button
      type="button"
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
      className="mic-safe relative h-16 w-full overflow-hidden rounded-2xl bg-go text-2xl font-extrabold text-white shadow-lg select-none"
    >
      <span className="absolute inset-0 bg-go-deep transition-none" style={{ width: `${progress * 100}%` }} />
      <span className="relative z-10">{progress > 0 && progress < 1 ? holdingLabel : label}</span>
    </button>
  );
}
