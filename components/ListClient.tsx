"use client";

// S3: the priced list. Photos, Hindi names, − qty + steppers, "?" candidate picks,
// नहीं-मिला rows, live total, real payment method, confirm sheet (hold 1.5 s + 15 s undo).

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { productEmoji } from "@/lib/client/emoji";
import { speakHi } from "@/lib/client/tts";
import { HoldConfirm } from "@/components/HoldConfirm";
import { PinPad } from "@/components/PinPad";

type Variant = { spinId: string; skuId: string; packDesc: string; pricePaise: number; inStock: boolean };
type Candidate = { product: { name: string; brand?: string; imageUrl?: string }; variant: Variant };
type Matched = {
  key: string;
  voice: { name_hi: string; qty: number; unit: string; spoken: string };
  status: "matched" | "ambiguous" | "not_found";
  chosen?: Candidate;
  candidates?: Candidate[];
  quantity: number;
};
type CartItem = { spinId: string; name: string; quantity: number; linePaise: number };
type Cart = {
  items: CartItem[];
  toPayPaise: number;
  itemTotalPaise?: number;
  feesPaise?: number;
  storeCount: number;
  warnings: string[];
  removedOutOfStock: string[];
  paymentOptions?: { swiggyMoney?: { available: boolean }; cod?: { available: boolean } };
};
type Status = {
  state: string;
  stateHi: string;
  error?: string | null;
  transcript?: string;
  matched?: Matched[] | null;
  cart?: Cart | null;
  reasons?: string[];
  dry?: boolean;
};

type Line = { spinId: string; skuId: string; quantity: number };
type Phase = "loading" | "ready" | "sheet" | "countdown" | "waiting" | "failed";

const ru = (p?: number | null) => `₹${Math.round((p ?? 0) / 100)}`;
const TERMINAL = ["placed", "partially_placed", "not_placed", "unknown", "rejected", "expired", "superseded"];

export function ListClient({ draftId }: { draftId: string }) {
  const router = useRouter();
  const [matched, setMatched] = useState<Matched[]>([]);
  const [lines, setLines] = useState<Record<string, Line>>({});
  const [cart, setCart] = useState<Cart | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [waitingHi, setWaitingHi] = useState("मालिक से पूछ रहे हैं…");
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [pinNeeded, setPinNeeded] = useState(false);
  const [countdown, setCountdown] = useState(15);
  const [payment, setPayment] = useState<"SWIGGY_MONEY" | "COD">("SWIGGY_MONEY");
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const linesRef = useRef(lines);
  linesRef.current = lines;

  const syncCart = useCallback(
    async (ls: Record<string, Line>) => {
      const list = Object.values(ls).filter((l) => l.quantity > 0);
      if (!list.length) {
        setCart(null);
        return;
      }
      setSyncing(true);
      try {
        const res = await api<{ cart: Cart; paymentMethod: "SWIGGY_MONEY" | "COD" }>(`/api/draft/${draftId}/cart`, {
          method: "POST",
          body: JSON.stringify({ lines: list }),
        });
        setCart(res.cart);
        setPayment(res.paymentMethod);
      } catch (e) {
        setError(e instanceof ApiError ? (e.data?.hi ?? "दुकान से जवाब नहीं मिला") : "इंटरनेट नहीं चल रहा");
      } finally {
        setSyncing(false);
      }
    },
    [draftId],
  );

  // initial load: status → (match) → cart
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        let s = await api<Status>(`/api/draft/${draftId}/status`);
        if (TERMINAL.includes(s.state)) {
          router.replace(`/status/${draftId}`);
          return;
        }
        if (["awaiting_approval", "approved", "approved_waiting_login", "placing_swiggypay", "placing_cod"].includes(s.state)) {
          setPhase("waiting");
          setWaitingHi(s.stateHi);
          return;
        }
        let m = s.matched ?? null;
        if (!m || s.state === "parsed") {
          const res = await api<{ matched: Matched[] }>(`/api/draft/${draftId}/match`, { method: "POST" });
          m = res.matched;
        }
        if (dead) return;
        setMatched(m ?? []);
        const initial: Record<string, Line> = {};
        for (const item of m ?? []) {
          if (item.status === "matched" && item.chosen) {
            initial[item.key] = { spinId: item.chosen.variant.spinId, skuId: item.chosen.variant.skuId, quantity: item.quantity };
          }
        }
        setLines(initial);
        setPhase("ready");
        await syncCart(initial);
        const found = (m ?? []).filter((x) => x.status !== "not_found").length;
        void speakHi(found ? "लिस्ट तैयार है" : "कुछ नहीं मिला — फिर से बोलें");
      } catch (e) {
        if (dead) return;
        setError(e instanceof ApiError ? (e.data?.hi ?? "कुछ गड़बड़ हुई") : "इंटरनेट नहीं चल रहा");
        setPhase("failed");
      }
    })();
    return () => {
      dead = true;
    };
  }, [draftId, router, syncCart]);

  // waiting phase: poll status until terminal
  useEffect(() => {
    if (phase !== "waiting") return;
    const t = setInterval(async () => {
      try {
        const s = await api<Status>(`/api/draft/${draftId}/status`);
        setWaitingHi(s.stateHi);
        if (TERMINAL.includes(s.state)) {
          clearInterval(t);
          router.replace(`/status/${draftId}`);
        }
      } catch {}
    }, 2500);
    return () => clearInterval(t);
  }, [phase, draftId, router]);

  function queueSync(next: Record<string, Line>) {
    setLines(next);
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => void syncCart(linesRef.current), 800);
  }

  function bump(item: Matched, delta: number) {
    const cur = lines[item.key];
    if (!cur) return;
    const q = Math.max(0, Math.min(20, cur.quantity + delta));
    queueSync({ ...lines, [item.key]: { ...cur, quantity: q } });
  }

  function pickCandidate(item: Matched, c: Candidate) {
    setMatched((ms) => ms.map((m) => (m.key === item.key ? { ...m, status: "matched", chosen: c } : m)));
    queueSync({ ...lines, [item.key]: { spinId: c.variant.spinId, skuId: c.variant.skuId, quantity: item.quantity || 1 } });
  }

  async function confirm() {
    setPhase("waiting");
    setWaitingHi("भेज रहे हैं…");
    try {
      const res = await api<{ status: string; hi?: string }>(`/api/draft/${draftId}/confirm`, { method: "POST", body: "{}" });
      setWaitingHi(res.hi ?? "…");
      void speakHi(res.hi ?? "");
    } catch (e) {
      if (e instanceof ApiError && e.data?.error === "pin_required") {
        setPinNeeded(true);
        setPhase("ready");
        return;
      }
      if (e instanceof ApiError && e.data?.status === "resync" && e.data?.cart) {
        setCart(e.data.cart as Cart);
        setError("दाम बदल गए — फिर से देखकर पक्का करें");
        void speakHi("दाम बदल गए हैं, फिर से देख लीजिए");
        setPhase("ready");
        return;
      }
      const msg = e instanceof ApiError ? (e.data?.hi ?? "कुछ गड़बड़ हुई") : "इंटरनेट नहीं चल रहा";
      setError(msg);
      void speakHi(msg);
      setPhase("ready");
    }
  }

  function startCountdown() {
    setPhase("countdown");
    setCountdown(15);
    countdownTimer.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          if (countdownTimer.current) clearInterval(countdownTimer.current);
          void confirm();
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }

  function cancelCountdown() {
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    setPhase("ready");
    void speakHi("रोक दिया");
  }

  const priceOf = (item: Matched): number => {
    const line = lines[item.key];
    const fromCart = cart?.items.find((ci) => ci.spinId === line?.spinId);
    if (fromCart) return fromCart.linePaise;
    if (item.chosen && line) return item.chosen.variant.pricePaise * line.quantity;
    return 0;
  };

  if (phase === "loading")
    return (
      <Center>
        <div className="h-16 w-16 animate-spin rounded-full border-8 border-line border-t-brand" />
        <p className="text-2xl font-bold">दाम देख रहे हैं…</p>
      </Center>
    );

  if (phase === "waiting")
    return (
      <Center>
        <div className="text-6xl animate-bob">🙏</div>
        <p className="px-8 text-center text-3xl font-extrabold">{waitingHi}</p>
        <p className="text-lg text-faint">यह पेज खुला रखें</p>
      </Center>
    );

  if (phase === "failed")
    return (
      <Center>
        <div className="text-6xl">😔</div>
        <p className="px-8 text-center text-2xl font-bold">{error ?? "कुछ गड़बड़ हुई"}</p>
        <Link href="/" className="rounded-2xl bg-brand px-8 py-4 text-2xl font-bold text-white">
          🎤 फिर से बोलें
        </Link>
      </Center>
    );

  const total = cart?.toPayPaise ?? 0;
  const anyItems = Object.values(lines).some((l) => l.quantity > 0);
  const minOrder = cart?.warnings.some((w) => /99|minimum/i.test(w));
  const swiggyMoney = cart?.paymentOptions?.swiggyMoney?.available;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col pb-44">
      <header className="sticky top-0 z-20 flex items-center justify-between bg-bg/95 px-5 py-3 backdrop-blur">
        <Link href="/" className="text-xl font-bold text-faint">
          ← वापस
        </Link>
        <h1 className="text-2xl font-extrabold">आपकी लिस्ट</h1>
        <button type="button" onClick={() => void speakHi(`कुल ${Math.round(total / 100)} रुपये`)} className="h-12 w-12 rounded-full bg-card text-2xl shadow" aria-label="कुल सुनें">
          🔊
        </button>
      </header>

      {error && phase === "ready" && (
        <button type="button" onClick={() => setError(null)} className="mx-5 mt-1 rounded-2xl bg-warn-bg px-4 py-3 text-lg font-bold text-warn">
          ⚠ {error}
        </button>
      )}

      <ul className="mt-2 flex flex-col gap-3 px-4">
        {matched.map((item) => (
          <li key={item.key} className={`rounded-card bg-card p-3 shadow-sm ${item.status === "not_found" ? "opacity-60" : ""}`}>
            {item.status === "not_found" ? (
              <div className="flex items-center gap-3">
                <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-line text-3xl">❌</span>
                <div>
                  <p className="text-2xl font-bold">{item.voice.name_hi}</p>
                  <p className="text-lg font-semibold text-danger">नहीं मिला</p>
                </div>
              </div>
            ) : item.status === "ambiguous" ? (
              <div>
                <p className="mb-2 text-2xl font-bold">
                  {item.voice.name_hi} <span className="text-warn">?</span>
                </p>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {(item.candidates ?? []).map((c) => (
                    <button
                      key={c.variant.spinId}
                      type="button"
                      onClick={() => pickCandidate(item, c)}
                      className="flex min-w-28 shrink-0 flex-col items-center gap-1 rounded-2xl border-2 border-line bg-bg p-2 active:border-brand"
                    >
                      <ProductImage name={c.product.name} url={c.product.imageUrl} size={56} />
                      <span className="max-w-28 truncate text-sm font-bold">{c.product.name}</span>
                      <span className="text-sm text-faint">{c.variant.packDesc}</span>
                      <span className="text-base font-extrabold">{ru(c.variant.pricePaise)}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <ProductImage name={item.chosen!.product.name} url={item.chosen!.product.imageUrl} size={64} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-2xl font-bold leading-tight">{item.voice.name_hi}</p>
                  <p className="truncate text-base text-faint">
                    {item.chosen!.product.name} · {item.chosen!.variant.packDesc}
                  </p>
                  <p className="text-xl font-extrabold">{ru(priceOf(item))}</p>
                </div>
                <div className="flex items-center gap-1">
                  <Stepper label="कम करें" onClick={() => bump(item, -1)}>
                    −
                  </Stepper>
                  <span className="w-9 text-center text-2xl font-extrabold">{lines[item.key]?.quantity ?? 0}</span>
                  <Stepper label="बढ़ाएं" onClick={() => bump(item, +1)}>
                    +
                  </Stepper>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      {(cart?.removedOutOfStock.length ?? 0) > 0 && (
        <p className="mx-5 mt-3 rounded-2xl bg-warn-bg px-4 py-2 text-base font-semibold text-warn">कुछ चीज़ें खत्म हैं: {cart!.removedOutOfStock.join(", ")}</p>
      )}

      <footer className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-md border-t border-line bg-card px-5 pb-6 pt-3 shadow-[0_-8px_30px_rgba(0,0,0,0.08)]">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-lg font-semibold text-faint">
            {swiggyMoney ? "💳 Swiggy Money" : `💵 ${ru(total)} नकद देना है`}
            {cart && cart.storeCount > 1 ? ` · 🏪 ${cart.storeCount} दुकान` : ""}
          </span>
          <span className="text-3xl font-extrabold">
            {syncing ? <span className="text-faint">…</span> : ru(total)}
          </span>
        </div>
        {minOrder && <p className="mb-2 text-center text-base font-bold text-warn">₹99 से कम — और सामान जोड़ें</p>}
        <div className="flex gap-3">
          <Link href="/" className="flex h-16 flex-1 items-center justify-center rounded-2xl border-2 border-brand text-xl font-extrabold text-brand">
            🎤 और बोलें
          </Link>
          <button
            type="button"
            disabled={!anyItems || syncing || Boolean(minOrder)}
            onClick={() => setPhase("sheet")}
            className="h-16 flex-[1.4] rounded-2xl bg-go text-2xl font-extrabold text-white shadow-lg disabled:opacity-40"
          >
            ✅ ऑर्डर करो →
          </button>
        </div>
      </footer>

      {(phase === "sheet" || phase === "countdown") && cart && (
        <div className="fixed inset-0 z-40 flex items-end bg-black/50" role="dialog">
          <div className="mx-auto w-full max-w-md rounded-t-3xl bg-bg p-5 pb-8">
            <p className="text-center text-2xl font-extrabold">पक्का करें?</p>
            <div className="my-3 flex gap-2 overflow-x-auto">
              {cart.items.map((ci) => (
                <span key={ci.spinId} className="flex shrink-0 items-center gap-1 rounded-xl bg-card px-3 py-2 text-base font-bold shadow-sm">
                  {productEmoji(ci.name)} ×{ci.quantity}
                </span>
              ))}
            </div>
            <p className="mb-1 text-center text-4xl font-extrabold">{ru(total)}</p>
            <p className="mb-4 text-center text-lg font-semibold text-faint">{swiggyMoney ? "💳 Swiggy Money से कटेंगे" : "💵 डिलीवरी पर नकद देना है"}</p>
            {phase === "sheet" ? (
              <>
                <HoldConfirm label={`✅ ${ru(total)} — दबाए रखें`} onConfirmed={startCountdown} />
                <button type="button" onClick={() => setPhase("ready")} className="mt-3 w-full rounded-2xl py-3 text-xl font-bold text-faint">
                  वापस
                </button>
              </>
            ) : (
              <>
                <p className="text-center text-xl font-bold">{countdown} सेकंड में ऑर्डर होगा…</p>
                <button type="button" onClick={cancelCountdown} className="mt-3 h-16 w-full rounded-2xl bg-danger text-2xl font-extrabold text-white">
                  रद्द करें
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {pinNeeded && (
        <PinPad
          onDone={() => {
            setPinNeeded(false);
            void confirm();
          }}
          onCancel={() => setPinNeeded(false)}
        />
      )}
    </main>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-5 px-5">{children}</main>;
}

function Stepper({ children, label, onClick }: { children: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="h-12 w-12 rounded-full bg-line text-3xl font-extrabold leading-none active:bg-brand active:text-white">
      {children}
    </button>
  );
}

function ProductImage({ name, url, size }: { name: string; url?: string; size: number }) {
  if (url)
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={name} width={size} height={size} className="shrink-0 rounded-2xl bg-line object-cover" style={{ width: size, height: size }} />;
  return (
    <span className="flex shrink-0 items-center justify-center rounded-2xl bg-line" style={{ width: size, height: size, fontSize: size * 0.55 }}>
      {productEmoji(name)}
    </span>
  );
}
