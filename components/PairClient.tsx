"use client";

// S0 pairing (owner sets this up on the cook's phone, in Chrome):
// code+PIN → mic permission ("Allow every visit") → TTS check → install hint.

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { speakHi } from "@/lib/client/tts";

type Step = "code" | "mic" | "tts" | "done";

export function PairClient() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("code");
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [micOk, setMicOk] = useState<boolean | null>(null);

  async function pair() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/pair", { method: "POST", body: JSON.stringify({ code, pin, name: name || undefined }) });
      setStep("mic");
    } catch (e) {
      setError(e instanceof ApiError ? (e.data?.hi ?? "कोड गलत है") : "इंटरनेट नहीं चल रहा");
    } finally {
      setBusy(false);
    }
  }

  async function testMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMicOk(true);
      setStep("tts");
    } catch {
      setMicOk(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-6 py-8">
      <h1 className="text-3xl font-extrabold">फ़ोन जोड़ें 📱</h1>
      <p className="mt-1 text-base text-faint">आवाज़ Google को जाती है ताकि लिस्ट बन सके।</p>

      {step === "code" && (
        <div className="mt-6 flex flex-col gap-4">
          <label className="text-xl font-bold">
            मालिक से मिला 6-अंकों का कोड
            <input
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              className="mt-1 w-full rounded-2xl border-2 border-line bg-card p-4 text-center text-3xl font-extrabold tracking-[0.5em]"
              placeholder="••••••"
            />
          </label>
          <label className="text-xl font-bold">
            नया पिन बनाएं (4 अंक)
            <input
              inputMode="numeric"
              type="password"
              maxLength={4}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              className="mt-1 w-full rounded-2xl border-2 border-line bg-card p-4 text-center text-3xl font-extrabold tracking-[0.5em]"
              placeholder="••••"
            />
          </label>
          <label className="text-xl font-bold">
            नाम (जैसे: रसोई का फ़ोन)
            <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-2xl border-2 border-line bg-card p-4 text-xl" />
          </label>
          {error && <p className="rounded-2xl bg-red-50 p-3 text-center text-lg font-bold text-danger">{error}</p>}
          <button
            type="button"
            disabled={code.length !== 6 || pin.length !== 4 || busy}
            onClick={() => void pair()}
            className="h-16 rounded-2xl bg-go text-2xl font-extrabold text-white disabled:opacity-40"
          >
            {busy ? "…" : "जोड़ें →"}
          </button>
        </div>
      )}

      {step === "mic" && (
        <div className="mt-8 flex flex-col items-center gap-5 text-center">
          <div className="text-7xl">🎤</div>
          <p className="text-2xl font-bold">माइक की इजाज़त दें</p>
          <p className="text-lg text-faint">Chrome पूछे तो “Allow / हर बार” चुनें</p>
          {micOk === false && <p className="rounded-2xl bg-red-50 p-3 text-lg font-bold text-danger">इजाज़त नहीं मिली — Chrome की सेटिंग में जाकर Allow करें</p>}
          <button type="button" onClick={() => void testMic()} className="h-16 w-full rounded-2xl bg-brand text-2xl font-extrabold text-white">
            माइक चालू करें
          </button>
        </div>
      )}

      {step === "tts" && (
        <div className="mt-8 flex flex-col items-center gap-5 text-center">
          <div className="text-7xl">🔊</div>
          <p className="text-2xl font-bold">आवाज़ की जांच</p>
          <button
            type="button"
            onClick={() => void speakHi("नमस्ते! रसोई तैयार है।")}
            className="h-16 w-full rounded-2xl bg-brand text-2xl font-extrabold text-white"
          >
            सुनें: “नमस्ते!”
          </button>
          <button type="button" onClick={() => setStep("done")} className="h-16 w-full rounded-2xl bg-go text-2xl font-extrabold text-white">
            सुनाई दिया ✓
          </button>
          <button type="button" onClick={() => setStep("done")} className="text-lg font-bold text-faint">
            सुनाई नहीं दिया, फिर भी आगे बढ़ें
          </button>
        </div>
      )}

      {step === "done" && (
        <div className="mt-8 flex flex-col items-center gap-5 text-center">
          <div className="text-7xl">🎉</div>
          <p className="text-2xl font-bold">हो गया!</p>
          <p className="rounded-2xl bg-card p-4 text-lg text-faint">
            Chrome के मेन्यू (⋮) से <b>“Add to Home screen / होम स्क्रीन पर जोड़ें”</b> दबाएं ताकि यह ऐप की तरह खुले।
          </p>
          <button type="button" onClick={() => router.push("/")} className="h-16 w-full rounded-2xl bg-go text-2xl font-extrabold text-white">
            शुरू करें →
          </button>
        </div>
      )}
    </main>
  );
}
