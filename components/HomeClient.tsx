"use client";

// S1 home: banner · big mic · everyday chips · demo notice. Warm the backend on first touch.

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, ensureReady } from "@/lib/client/api";
import type { Recording } from "@/lib/client/recorder";
import { speakHi } from "@/lib/client/tts";
import { MicButton } from "@/components/MicButton";

type Warm = { ok: boolean; demo: boolean; paused: boolean; dryRun: boolean; loginOk: boolean; blocked: boolean };

const CHIPS = ["🧅", "🍅", "🥔", "🥛", "🌿", "🧄"];

export function HomeClient() {
  const router = useRouter();
  const [warm, setWarm] = useState<Warm | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const warmed = useRef(false);

  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    void ensureReady()
      .then((w) => setWarm(w))
      .catch((e) => setError(e instanceof ApiError ? (e.data?.hi ?? "सर्वर से बात नहीं हो पाई") : "इंटरनेट नहीं चल रहा"));
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  async function onRecording(r: Recording) {
    setSending(true);
    setError(null);
    try {
      const res = await api<{ draftId: string }>("/api/voice", {
        method: "POST",
        headers: { "content-type": r.mimeType },
        body: r.blob,
      });
      router.push(`/list/${res.draftId}`);
    } catch (e) {
      const msg = e instanceof ApiError ? (e.data?.hi ?? "कुछ गड़बड़ हुई — फिर कोशिश करें") : "इंटरनेट नहीं चल रहा";
      setError(msg);
      void speakHi(msg);
      setSending(false);
    }
  }

  const banner = !online
    ? "इंटरनेट नहीं है — Wi-Fi देखें"
    : warm && warm.paused
      ? "अभी बंद है — मालिक से पूछें"
      : warm && warm.blocked
        ? "पिछला ऑर्डर पक्का नहीं हुआ — रुकिए"
        : warm && !warm.loginOk
          ? "मालिक का लॉगिन चाहिए — बता दिया है"
          : null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-5 pb-8 pt-4">
      <header className="flex items-center justify-between">
        <h1 className="text-4xl font-extrabold tracking-tight">
          रसोई <span className="animate-bob inline-block">🍅</span>
        </h1>
        <button
          type="button"
          onClick={() => void speakHi("बीच का बड़ा बटन दबाकर रखिए, और सामान बोलिए। छोड़ने पर लिस्ट बन जाएगी।")}
          className="flex h-12 w-12 items-center justify-center rounded-full bg-card text-2xl shadow"
          aria-label="मदद सुनें"
        >
          🔊
        </button>
      </header>

      {banner && <div className="mt-3 rounded-2xl bg-warn-bg px-4 py-3 text-center text-lg font-bold text-warn">⚠ {banner}</div>}
      {warm?.demo && <div className="mt-3 rounded-2xl bg-card px-4 py-2 text-center text-base font-semibold text-faint">डेमो मोड — असली ऑर्डर नहीं होगा</div>}

      <section className="flex flex-1 flex-col items-center justify-center gap-6 py-8">
        {sending ? (
          <div className="flex flex-col items-center gap-4">
            <div className="h-16 w-16 animate-spin rounded-full border-8 border-line border-t-brand" />
            <p className="text-2xl font-bold">लिस्ट बन रही है…</p>
          </div>
        ) : (
          <MicButton disabled={!online || Boolean(warm?.paused) || Boolean(warm?.blocked)} onRecording={onRecording} onStart={() => void api("/api/warm").catch(() => {})} />
        )}
        {error && <p className="rounded-2xl bg-red-50 px-4 py-3 text-center text-lg font-bold text-danger">{error}</p>}
      </section>

      <section className="mt-auto">
        <p className="mb-2 text-lg font-bold text-faint">रोज़ का सामान</p>
        <div className="flex gap-3 overflow-x-auto pb-1">
          {CHIPS.map((c) => (
            <span key={c} className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-card text-3xl shadow-sm">
              {c}
            </span>
          ))}
        </div>
        <p className="mt-3 text-center text-base text-faint">जैसे: “प्याज़ एक किलो, दो पैकेट दही, धनिया”</p>
      </section>
    </main>
  );
}
