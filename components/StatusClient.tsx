"use client";

// S5: order outcome + live tracking. Speaks state changes in the chosen language.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { productEmoji } from "@/lib/client/emoji";
import { speak } from "@/lib/client/tts";
import { useLang } from "@/lib/client/use-lang";
import { pick, ui, type UiKey } from "@/lib/i18n";
import { LangToggle } from "@/components/LangToggle";

type Status = {
  state: string;
  stateHi: string;
  stateEn: string;
  errorHi?: string | null;
  errorEn?: string | null;
  cart?: { items: { spinId: string; name: string; quantity: number }[]; toPayPaise: number } | null;
  paymentMethod?: "SWIGGY_MONEY" | "COD" | null;
  swiggyMessage?: string | null;
  dry?: boolean;
  track?: { status?: string; etaMinutes?: number } | null;
};

const ru = (p?: number | null) => {
  const r = (p ?? 0) / 100;
  return `₹${Number.isInteger(r) ? r : r.toFixed(2)}`;
};

const ICON: Record<string, string> = {
  placed: "✅",
  partially_placed: "🟡",
  not_placed: "❌",
  unknown: "⚠️",
  rejected: "🙅",
  expired: "⏰",
  superseded: "🔁",
};

export function StatusClient({ draftId }: { draftId: string }) {
  const [lang] = useLang();
  const t = (k: UiKey, vars?: Record<string, string | number>) => ui(k, lang, vars);
  const [s, setS] = useState<Status | null>(null);
  const lastState = useRef("");
  const langRef = useRef(lang);
  langRef.current = lang;

  useEffect(() => {
    let stop = false;
    async function load() {
      try {
        const res = await api<Status>(`/api/draft/${draftId}/status`);
        if (stop) return;
        setS(res);
        if (res.state !== lastState.current) {
          lastState.current = res.state;
          void speak(pick(langRef.current, { hi: res.stateHi, en: res.stateEn }), langRef.current);
        }
      } catch {}
    }
    void load();
    const tm = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 40_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop = true;
      clearInterval(tm);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [draftId]);

  if (!s)
    return (
      <main className="mx-auto flex min-h-dvh max-w-md items-center justify-center">
        <div className="h-16 w-16 animate-spin rounded-full border-8 border-line border-t-brand" />
      </main>
    );

  const icon = ICON[s.state] ?? "⏳";
  const good = s.state === "placed";
  const errorText = pick(lang, { hi: s.errorHi, en: s.errorEn });

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center px-6 pb-10 pt-4 text-center">
      <div className="flex w-full justify-end">
        <LangToggle />
      </div>
      <div className={`mt-8 text-8xl ${good ? "animate-bob" : ""}`}>{icon}</div>
      <h1 className="mt-4 text-4xl font-extrabold leading-snug">{pick(lang, { hi: s.stateHi, en: s.stateEn })}</h1>
      {s.dry && <p className="mt-2 rounded-xl bg-card px-4 py-1 text-lg font-bold text-faint">{t("demo_no_order")}</p>}
      {errorText && !good && <p className="mt-3 text-xl font-semibold text-danger">{errorText}</p>}
      {s.swiggyMessage && <p className="mt-3 rounded-2xl bg-card px-4 py-3 text-lg text-faint">Swiggy: “{s.swiggyMessage}”</p>}

      {good && s.track && (
        <p className="mt-4 rounded-2xl bg-card px-5 py-3 text-2xl font-bold shadow-sm">
          🛵 {s.track.status === "DELIVERED" ? t("delivered") : t("on_the_way")}
          {s.track.etaMinutes ? ` · ~${s.track.etaMinutes} ${t("minutes")}` : ""}
        </p>
      )}

      {good && s.paymentMethod === "COD" && (
        <p className="mt-4 rounded-2xl bg-warn-bg px-5 py-4 text-2xl font-extrabold text-warn">{t("keep_cash", { amt: ru(s.cart?.toPayPaise) })}</p>
      )}

      {s.cart && (
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {s.cart.items.map((i) => (
            <span key={i.spinId} className="rounded-xl bg-card px-3 py-2 text-lg font-bold shadow-sm">
              {productEmoji(i.name)} ×{i.quantity}
            </span>
          ))}
        </div>
      )}
      {s.cart && <p className="mt-2 text-2xl font-extrabold">{ru(s.cart.toPayPaise)}</p>}

      {(s.state === "not_placed" || s.state === "rejected" || s.state === "expired") && <p className="mt-4 text-xl font-semibold text-faint">{t("change_and_retry")}</p>}
      {s.state === "unknown" && <p className="mt-4 text-xl font-bold text-warn">{t("do_not_reorder")}</p>}

      <Link href="/" className="mt-auto flex h-16 w-full items-center justify-center rounded-2xl bg-brand text-2xl font-extrabold text-white shadow-lg">
        {t("home")}
      </Link>
    </main>
  );
}
