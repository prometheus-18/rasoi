"use client";

// S5: order outcome + live tracking. Hindi TTS on state changes.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { productEmoji } from "@/lib/client/emoji";
import { speakHi } from "@/lib/client/tts";

type Status = {
  state: string;
  stateHi: string;
  error?: string | null;
  cart?: { items: { spinId: string; name: string; quantity: number }[]; toPayPaise: number } | null;
  paymentMethod?: "SWIGGY_MONEY" | "COD" | null;
  swiggyMessage?: string | null;
  dry?: boolean;
  track?: { status?: string; etaMinutes?: number; message?: string } | null;
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
  const [s, setS] = useState<Status | null>(null);
  const lastState = useRef("");

  useEffect(() => {
    let stop = false;
    async function load() {
      try {
        const res = await api<Status>(`/api/draft/${draftId}/status`);
        if (stop) return;
        setS(res);
        if (res.state !== lastState.current) {
          lastState.current = res.state;
          void speakHi(res.stateHi);
        }
      } catch {}
    }
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 40_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop = true;
      clearInterval(t);
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

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center px-6 pb-10 pt-16 text-center">
      <div className={`text-8xl ${good ? "animate-bob" : ""}`}>{icon}</div>
      <h1 className="mt-4 text-4xl font-extrabold leading-snug">{s.stateHi}</h1>
      {s.dry && <p className="mt-2 rounded-xl bg-card px-4 py-1 text-lg font-bold text-faint">डेमो — असली ऑर्डर नहीं हुआ</p>}
      {s.error && !good && <p className="mt-3 text-xl font-semibold text-danger">{s.error}</p>}
      {s.swiggyMessage && <p className="mt-3 rounded-2xl bg-card px-4 py-3 text-lg text-faint">Swiggy: “{s.swiggyMessage}”</p>}

      {good && s.track && (
        <p className="mt-4 rounded-2xl bg-card px-5 py-3 text-2xl font-bold shadow-sm">
          🛵 {s.track.status === "DELIVERED" ? "पहुंच गया" : "रास्ते में"}
          {s.track.etaMinutes ? ` · ~${s.track.etaMinutes} मिनट` : ""}
        </p>
      )}

      {good && s.paymentMethod === "COD" && (
        <p className="mt-4 rounded-2xl bg-warn-bg px-5 py-4 text-2xl font-extrabold text-warn">💵 कैश तैयार रखें {ru(s.cart?.toPayPaise)}</p>
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

      {(s.state === "not_placed" || s.state === "rejected" || s.state === "expired") && (
        <p className="mt-4 text-xl font-semibold text-faint">बदलकर फिर से बोल सकते हैं</p>
      )}
      {s.state === "unknown" && <p className="mt-4 text-xl font-bold text-warn">दोबारा ऑर्डर मत करना — मालिक देख रहे हैं</p>}

      <Link href="/" className="mt-auto flex h-16 w-full items-center justify-center rounded-2xl bg-brand text-2xl font-extrabold text-white shadow-lg">
        🏠 वापस
      </Link>
    </main>
  );
}
