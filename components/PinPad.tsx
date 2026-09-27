"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/client/api";

export function PinPad({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(full: string) {
    setBusy(true);
    setError(null);
    try {
      await api("/api/pin", { method: "POST", body: JSON.stringify({ pin: full }) });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? (e.data?.hi ?? "पिन गलत है") : "इंटरनेट नहीं चल रहा");
      setPin("");
      setBusy(false);
    }
  }

  function press(d: string) {
    if (busy) return;
    if (d === "⌫") {
      setPin((p) => p.slice(0, -1));
      return;
    }
    const next = pin + d;
    setPin(next);
    if (next.length === 4) void submit(next);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" role="dialog" aria-label="पिन डालें">
      <div className="w-full max-w-md rounded-t-3xl bg-bg p-6 pb-10">
        <p className="text-center text-2xl font-extrabold">पिन डालें</p>
        <div className="my-5 flex justify-center gap-4">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={`h-5 w-5 rounded-full border-2 border-brand ${pin.length > i ? "bg-brand" : "bg-transparent"}`} />
          ))}
        </div>
        {error && <p className="mb-3 text-center text-lg font-bold text-danger">{error}</p>}
        <div className="grid grid-cols-3 gap-3">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map((d, i) =>
            d === "" ? (
              <span key={i} />
            ) : (
              <button
                key={i}
                type="button"
                onClick={() => press(d)}
                className="h-16 rounded-2xl bg-card text-3xl font-bold shadow-sm active:bg-line"
              >
                {d}
              </button>
            ),
          )}
        </div>
        <button type="button" onClick={onCancel} className="mt-4 w-full rounded-2xl py-3 text-xl font-bold text-faint">
          वापस
        </button>
      </div>
    </div>
  );
}
