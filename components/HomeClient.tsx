"use client";

// S1 home: language toggle · banner · big mic · everyday chips · demo notice.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError, ensureReady } from "@/lib/client/api";
import type { Recording } from "@/lib/client/recorder";
import { speak } from "@/lib/client/tts";
import { useLang } from "@/lib/client/use-lang";
import { pick, ui } from "@/lib/i18n";
import { LangToggle } from "@/components/LangToggle";
import { MicButton } from "@/components/MicButton";

type Warm = { ok: boolean; demo: boolean; paused: boolean; dryRun: boolean; loginOk: boolean; blocked: boolean };

const CHIPS = ["🧅", "🍅", "🥔", "🥛", "🌿", "🧄"];

export function HomeClient() {
  const router = useRouter();
  const [lang] = useLang();
  const [warm, setWarm] = useState<Warm | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const t = (k: Parameters<typeof ui>[0]) => ui(k, lang);

  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    void ensureReady()
      .then((w) => setWarm(w))
      .catch((e) => setError(e instanceof ApiError ? pick(lang, e.data, ui("server_error", lang)) : ui("no_internet", lang)));
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const msg = e instanceof ApiError ? pick(lang, e.data, t("generic_error")) : t("no_internet");
      setError(msg);
      void speak(msg, lang);
      setSending(false);
    }
  }

  const banner = !online
    ? t("offline")
    : warm && warm.paused
      ? t("paused_banner")
      : warm && warm.blocked
        ? t("blocked_banner")
        : warm && !warm.loginOk && !warm.demo
          ? t("login_banner")
          : null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-5 pb-8 pt-4">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-4xl font-extrabold tracking-tight">
          {t("app_name")} <span className="animate-bob inline-block">🍅</span>
        </h1>
        <div className="flex items-center gap-2">
          <LangToggle />
          <button
            type="button"
            onClick={() => void speak(t("help_speech"), lang)}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-card text-2xl shadow"
            aria-label={t("help")}
          >
            🔊
          </button>
        </div>
      </header>

      {banner && <div className="mt-3 rounded-2xl bg-warn-bg px-4 py-3 text-center text-lg font-bold text-warn">⚠ {banner}</div>}
      {warm?.demo && <div className="mt-3 rounded-2xl bg-card px-4 py-2 text-center text-base font-semibold text-faint">{t("demo_banner")}</div>}

      <section className="flex flex-1 flex-col items-center justify-center gap-6 py-8">
        {sending ? (
          <div className="flex flex-col items-center gap-4">
            <div className="h-16 w-16 animate-spin rounded-full border-8 border-line border-t-brand" />
            <p className="text-2xl font-bold">{t("making_list")}</p>
          </div>
        ) : (
          <MicButton disabled={!online || Boolean(warm?.paused) || Boolean(warm?.blocked)} onRecording={onRecording} onStart={() => void api("/api/warm").catch(() => {})} />
        )}
        {error && <p className="rounded-2xl bg-red-50 px-4 py-3 text-center text-lg font-bold text-danger">{error}</p>}
      </section>

      <section className="mt-auto">
        <p className="mb-2 text-lg font-bold text-faint">{t("everyday")}</p>
        <div className="flex gap-3 overflow-x-auto pb-1">
          {CHIPS.map((c) => (
            <span key={c} className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-card text-3xl shadow-sm">
              {c}
            </span>
          ))}
        </div>
        <p className="mt-3 text-center text-base text-faint">{t("example")}</p>
        <p className="mt-4 text-center">
          <Link href="/login" className="inline-flex h-10 items-center rounded-full px-3 text-sm font-semibold text-faint underline">
            {t("owner_link")}
          </Link>
        </p>
      </section>
    </main>
  );
}
