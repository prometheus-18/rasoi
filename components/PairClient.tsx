"use client";

// S0 pairing (owner sets this up on the cook's phone, in Chrome):
// code+PIN → mic permission ("Allow every visit") → voice check → install hint.

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { speak } from "@/lib/client/tts";
import { useLang } from "@/lib/client/use-lang";
import { pick, ui, type UiKey } from "@/lib/i18n";
import { LangToggle } from "@/components/LangToggle";

type Step = "code" | "mic" | "tts" | "done";

export function PairClient() {
  const router = useRouter();
  const [lang] = useLang();
  const t = (k: UiKey) => ui(k, lang);
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
      setError(e instanceof ApiError ? pick(lang, e.data, t("generic_error")) : t("no_internet"));
    } finally {
      setBusy(false);
    }
  }

  async function testMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((tr) => tr.stop());
      setMicOk(true);
      setStep("tts");
    } catch {
      setMicOk(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-6 py-6">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-3xl font-extrabold">{t("pair_title")}</h1>
          <p className="mt-1 text-base text-faint">{t("pair_consent")}</p>
        </div>
        <LangToggle />
      </div>

      {step === "code" && (
        <div className="mt-6 flex flex-col gap-4">
          <label className="text-xl font-bold">
            {t("pair_code_label")}
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
            {t("pair_pin_label")}
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
            {t("pair_name_label")}
            <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-2xl border-2 border-line bg-card p-4 text-xl" />
          </label>
          {error && <p className="rounded-2xl bg-red-50 p-3 text-center text-lg font-bold text-danger">{error}</p>}
          <button
            type="button"
            disabled={code.length !== 6 || pin.length !== 4 || busy}
            onClick={() => void pair()}
            className="h-16 rounded-2xl bg-go text-2xl font-extrabold text-white disabled:opacity-40"
          >
            {busy ? "…" : t("pair_button")}
          </button>
        </div>
      )}

      {step === "mic" && (
        <div className="mt-8 flex flex-col items-center gap-5 text-center">
          <div className="text-7xl">🎤</div>
          <p className="text-2xl font-bold">{t("mic_permission")}</p>
          <p className="text-lg text-faint">{t("mic_permission_hint")}</p>
          {micOk === false && <p className="rounded-2xl bg-red-50 p-3 text-lg font-bold text-danger">{t("mic_denied")}</p>}
          <button type="button" onClick={() => void testMic()} className="h-16 w-full rounded-2xl bg-brand text-2xl font-extrabold text-white">
            {t("mic_on")}
          </button>
        </div>
      )}

      {step === "tts" && (
        <div className="mt-8 flex flex-col items-center gap-5 text-center">
          <div className="text-7xl">🔊</div>
          <p className="text-2xl font-bold">{t("voice_check")}</p>
          <button type="button" onClick={() => void speak(t("hello_speech"), lang)} className="h-16 w-full rounded-2xl bg-brand text-2xl font-extrabold text-white">
            {t("hear_hello")}
          </button>
          <button type="button" onClick={() => setStep("done")} className="h-16 w-full rounded-2xl bg-go text-2xl font-extrabold text-white">
            {t("heard_ok")}
          </button>
          <button type="button" onClick={() => setStep("done")} className="text-lg font-bold text-faint">
            {t("heard_no")}
          </button>
        </div>
      )}

      {step === "done" && (
        <div className="mt-8 flex flex-col items-center gap-5 text-center">
          <div className="text-7xl">🎉</div>
          <p className="text-2xl font-bold">{t("done")}</p>
          <p className="rounded-2xl bg-card p-4 text-lg text-faint">{t("install_hint")}</p>
          <button type="button" onClick={() => router.push("/")} className="h-16 w-full rounded-2xl bg-go text-2xl font-extrabold text-white">
            {t("start")}
          </button>
        </div>
      )}
    </main>
  );
}
