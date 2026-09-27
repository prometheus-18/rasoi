"use client";

// /check — the owner runs this on the cook's phone (Phase 0 gate + debugging).

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { Recorder } from "@/lib/client/recorder";
import { hindiVoiceAvailable, speakHi } from "@/lib/client/tts";

type Row = { name: string; ok: boolean | null; detail: string };

export function CheckClient() {
  const [rows, setRows] = useState<Row[]>([]);
  const [roundTrip, setRoundTrip] = useState<string>("");

  useEffect(() => {
    void (async () => {
      const out: Row[] = [];
      const standalone = window.matchMedia("(display-mode: standalone)").matches;
      out.push({ name: "Installed as app (standalone)", ok: standalone, detail: standalone ? "yes" : "opened in browser tab" });
      out.push({ name: "Chrome-ish browser", ok: /chrome/i.test(navigator.userAgent), detail: navigator.userAgent.slice(0, 80) });
      out.push({ name: "Mic API", ok: Boolean(navigator.mediaDevices?.getUserMedia), detail: "getUserMedia" });
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
      out.push({ name: "MediaRecorder", ok: Boolean(mime), detail: mime ?? "none supported" });
      const hi = await hindiVoiceAvailable();
      out.push({ name: "Hindi TTS voice", ok: hi, detail: hi ? "hi-IN found" : "install Google TTS Hindi (Settings → Accessibility)" });
      out.push({ name: "Wake lock", ok: "wakeLock" in navigator, detail: "keeps screen on while talking" });
      out.push({ name: "Cookies", ok: navigator.cookieEnabled, detail: "" });
      try {
        const warm = await api<any>("/api/warm");
        out.push({ name: "Server + device", ok: true, detail: `demo=${warm.demo} dryRun=${warm.dryRun} login=${warm.loginOk}` });
      } catch (e) {
        out.push({ name: "Server + device", ok: false, detail: e instanceof ApiError ? `${e.status} ${e.data?.error}` : "network error" });
      }
      try {
        const persisted = await navigator.storage?.persist?.();
        out.push({ name: "Storage persist", ok: Boolean(persisted), detail: String(persisted) });
      } catch {
        out.push({ name: "Storage persist", ok: null, detail: "n/a" });
      }
      setRows(out);
    })();
  }, []);

  async function testRoundTrip() {
    setRoundTrip("रिकॉर्ड हो रहा है… 3 सेकंड बोलिए (जैसे: प्याज़ एक किलो)");
    try {
      const rec = new Recorder();
      await rec.start();
      await new Promise((r) => setTimeout(r, 3500));
      const { blob, mimeType } = await rec.stop();
      setRoundTrip("भेज रहे हैं…");
      const t0 = Date.now();
      const res = await api<any>("/api/voice", { method: "POST", headers: { "content-type": mimeType }, body: blob });
      setRoundTrip(`✅ ${Date.now() - t0} ms — "${res.transcript}" → ${res.items?.map((i: any) => `${i.search_en} ${i.qty}${i.unit}`).join(", ")}`);
    } catch (e) {
      setRoundTrip(`❌ ${e instanceof ApiError ? (e.data?.hi ?? e.data?.error) : String(e)}`);
    }
  }

  return (
    <main className="mx-auto min-h-dvh max-w-md px-5 py-8">
      <h1 className="text-3xl font-extrabold">जांच / Check</h1>
      <ul className="mt-4 flex flex-col gap-2">
        {rows.map((r) => (
          <li key={r.name} className="rounded-2xl bg-card px-4 py-3 shadow-sm">
            <p className="text-lg font-bold">
              {r.ok === null ? "➖" : r.ok ? "✅" : "❌"} {r.name}
            </p>
            {r.detail && <p className="break-all text-sm text-faint">{r.detail}</p>}
          </li>
        ))}
      </ul>
      <div className="mt-5 flex flex-col gap-3">
        <button type="button" onClick={() => void speakHi("नमस्ते! यह हिंदी की आवाज़ है।")} className="h-14 rounded-2xl bg-card text-xl font-bold shadow-sm">
          🔊 हिंदी आवाज़ सुनें
        </button>
        <button type="button" onClick={() => void testRoundTrip()} className="h-14 rounded-2xl bg-brand text-xl font-extrabold text-white">
          🎤 माइक → Gemini जांच (3 सेकंड)
        </button>
        {roundTrip && <p className="rounded-2xl bg-card p-3 text-base">{roundTrip}</p>}
      </div>
    </main>
  );
}
