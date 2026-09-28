"use client";

// S3: the priced list. Photos, names, − qty + steppers, "?" candidate picks, not-found rows,
// live total, real payment method, confirm sheet (hold 1.5 s + 15 s undo). Hindi/English toggle.
// Safety details: every timer is cleared on unmount (an undo countdown must NEVER fire after the
// cook navigated away), cart syncs are sequence-numbered (a slow old response can't overwrite a
// newer cart), and a pending sync is flushed before the confirm sheet shows a total.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import { productEmoji } from "@/lib/client/emoji";
import { speak } from "@/lib/client/tts";
import { useLang } from "@/lib/client/use-lang";
import { MSG, pick, ui, type UiKey } from "@/lib/i18n";
import { HoldConfirm } from "@/components/HoldConfirm";
import { LangToggle } from "@/components/LangToggle";
import { PinPad } from "@/components/PinPad";

type Variant = { spinId: string; skuId: string; packDesc: string; pricePaise: number; inStock: boolean; maxQuantity?: number };
type Candidate = { product: { name: string; brand?: string; imageUrl?: string }; variant: Variant };
type Matched = {
  key: string;
  voice: { name_hi: string; qty: number; unit: string; spoken: string; search_en: string };
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
  stateEn: string;
  error?: string | null;
  matched?: Matched[] | null;
  cart?: Cart | null;
};

type Line = { spinId: string; skuId: string; quantity: number };
type Phase = "loading" | "ready" | "sheet" | "countdown" | "waiting" | "failed" | "forwarded";

const MIN_ORDER_PAISE = 9900;
const TERMINAL = ["placed", "partially_placed", "not_placed", "unknown", "rejected", "expired", "superseded"];
const WAITING = ["awaiting_approval", "approved", "approved_waiting_login", "placing_swiggypay", "placing_cod"];

/** ₹ with paise only when they exist (cash amounts must be exact). */
const ru = (p?: number | null) => {
  const r = (p ?? 0) / 100;
  return `₹${Number.isInteger(r) ? r : r.toFixed(2)}`;
};

export function ListClient({ draftId }: { draftId: string }) {
  const router = useRouter();
  const [lang] = useLang();
  const t = (k: UiKey, vars?: Record<string, string | number>) => ui(k, lang, vars);
  const [matched, setMatched] = useState<Matched[]>([]);
  const [lines, setLines] = useState<Record<string, Line>>({});
  const [cart, setCart] = useState<Cart | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [waitingMsg, setWaitingMsg] = useState<{ hi: string; en: string }>({ hi: "", en: "" });
  const [waitingState, setWaitingState] = useState("");
  const [waitingSince, setWaitingSince] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(0);
  const [pinNeeded, setPinNeeded] = useState(false);
  const [countdown, setCountdown] = useState(15);
  const [payment, setPayment] = useState<"SWIGGY_MONEY" | "COD">("COD");
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0); // monotonically increasing cart-sync id; stale responses are ignored
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const mounted = useRef(true);
  const langRef = useRef(lang);
  langRef.current = lang;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (syncTimer.current) clearTimeout(syncTimer.current);
    };
  }, []);

  const syncCart = useCallback(
    async (ls: Record<string, Line>): Promise<Cart | null> => {
      const list = Object.values(ls).filter((l) => l.quantity > 0);
      if (!list.length) {
        setCart(null);
        return null;
      }
      const mySeq = ++seq.current;
      setInFlight((n) => n + 1);
      try {
        const res = await api<{ cart: Cart; paymentMethod: "SWIGGY_MONEY" | "COD" }>(`/api/draft/${draftId}/cart`, {
          method: "POST",
          body: JSON.stringify({ lines: list }),
        });
        if (!mounted.current || mySeq !== seq.current) return null; // a newer sync superseded this one
        setCart(res.cart);
        setPayment(res.paymentMethod);
        return res.cart;
      } catch (e) {
        if (!mounted.current || mySeq !== seq.current) return null;
        if (e instanceof ApiError && e.data?.state === "changed") {
          setPhase("waiting");
          setWaitingMsg({ hi: ui("list_confirmed_wait", "hi"), en: ui("list_confirmed_wait", "en") });
          return null;
        }
        setError(e instanceof ApiError ? pick(langRef.current, e.data, MSG.shop_no_reply[langRef.current]) : ui("no_internet", langRef.current));
        return null;
      } finally {
        if (mounted.current) setInFlight((n) => Math.max(0, n - 1));
      }
    },
    [draftId],
  );

  // initial load: status → (match) → cart
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const s = await api<Status>(`/api/draft/${draftId}/status`);
        if (dead) return;
        if (TERMINAL.includes(s.state)) {
          router.replace(`/status/${draftId}`);
          return;
        }
        if (WAITING.includes(s.state)) {
          setPhase("waiting");
          setWaitingMsg({ hi: s.stateHi, en: s.stateEn });
          setWaitingState(s.state);
          setWaitingSince(Date.now());
          return;
        }
        if (s.error === "login_needed" || s.error === "swiggy_down") {
          setPhase("forwarded");
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
        void speak(ui(found ? "list_ready_speech" : "nothing_found_speech", langRef.current), langRef.current);
      } catch (e) {
        if (dead) return;
        if (e instanceof ApiError && (e.data?.error === "login_needed" || e.data?.error === "swiggy_down")) {
          setPhase("forwarded");
          void speak(ui("forwarded_title", langRef.current), langRef.current);
          return;
        }
        setError(e instanceof ApiError ? pick(langRef.current, e.data, ui("generic_error", langRef.current)) : ui("no_internet", langRef.current));
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
    const tm = setInterval(async () => {
      try {
        const s = await api<Status>(`/api/draft/${draftId}/status`);
        if (!mounted.current) return;
        setWaitingMsg({ hi: s.stateHi, en: s.stateEn });
        setWaitingState(s.state);
        if (TERMINAL.includes(s.state)) {
          clearInterval(tm);
          router.replace(`/status/${draftId}`);
        }
      } catch {}
    }, 2500);
    return () => clearInterval(tm);
  }, [phase, draftId, router]);

  // undo countdown: lives in an effect so unmount/cancel always clears it, and confirm() runs
  // as a normal effect side-effect, never inside a state updater
  useEffect(() => {
    if (phase !== "countdown") return;
    if (countdown <= 0) {
      void confirm();
      return;
    }
    const tm = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(tm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, countdown]);

  function queueSync(next: Record<string, Line>) {
    setLines(next);
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => void syncCart(linesRef.current), 800);
  }

  /** Flush any pending debounced edit and wait for the freshest cart before showing a total. */
  async function flushSync(): Promise<Cart | null> {
    if (syncTimer.current) {
      clearTimeout(syncTimer.current);
      syncTimer.current = null;
      return await syncCart(linesRef.current);
    }
    if (inFlight > 0) return await syncCart(linesRef.current);
    return cart;
  }

  function bump(item: Matched, delta: number) {
    const cur = lines[item.key];
    if (!cur) return;
    const cap = item.chosen?.variant.maxQuantity ?? 20;
    const q = Math.max(0, Math.min(cap, cur.quantity + delta));
    queueSync({ ...lines, [item.key]: { ...cur, quantity: q } });
  }

  function pickCandidate(item: Matched, c: Candidate) {
    setMatched((ms) => ms.map((m) => (m.key === item.key ? { ...m, status: "matched", chosen: c } : m)));
    queueSync({ ...lines, [item.key]: { spinId: c.variant.spinId, skuId: c.variant.skuId, quantity: item.quantity || 1 } });
  }

  async function openSheet() {
    setError(null);
    const fresh = await flushSync();
    if (!mounted.current) return;
    if (!fresh || fresh.items.length === 0) return;
    setPhase("sheet");
  }

  async function confirm() {
    setPhase("waiting");
    setWaitingMsg({ hi: ui("sending", "hi"), en: ui("sending", "en") });
    setWaitingSince(Date.now());
    try {
      const res = await api<{ status: string; hi?: string; en?: string }>(`/api/draft/${draftId}/confirm`, { method: "POST", body: "{}" });
      if (!mounted.current) return;
      setWaitingMsg({ hi: res.hi ?? "…", en: res.en ?? res.hi ?? "…" });
      setWaitingState(res.status === "placing" ? "approved" : "awaiting_approval");
      void speak(pick(langRef.current, res), langRef.current);
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof ApiError && e.data?.error === "pin_required") {
        setPinNeeded(true);
        setPhase("ready");
        return;
      }
      if (e instanceof ApiError && e.data?.status === "resync" && e.data?.cart) {
        setCart(e.data.cart as Cart);
        setError(ui("prices_changed_check", langRef.current));
        void speak(ui("prices_changed_speech", langRef.current), langRef.current);
        setPhase("ready");
        return;
      }
      const m = e instanceof ApiError ? pick(langRef.current, e.data, ui("generic_error", langRef.current)) : ui("no_internet", langRef.current);
      setError(m);
      void speak(m, langRef.current);
      setPhase("ready");
    }
  }

  async function retryCheckout() {
    try {
      await api(`/api/draft/${draftId}/checkout`, { method: "POST", body: "{}" });
      setWaitingSince(Date.now());
    } catch (e) {
      if (e instanceof ApiError && e.data?.error === "pin_required") setPinNeeded(true);
    }
  }

  const priceOf = (item: Matched): number => {
    const line = lines[item.key];
    const fromCart = cart?.items.find((ci) => ci.spinId === line?.spinId);
    if (fromCart) return fromCart.linePaise;
    if (item.chosen && line) return item.chosen.variant.pricePaise * line.quantity;
    return 0;
  };

  const itemName = (item: Matched) => (lang === "en" ? item.chosen?.product.name ?? item.voice.search_en : item.voice.name_hi);

  if (phase === "loading")
    return (
      <Center>
        <div className="h-16 w-16 animate-spin rounded-full border-8 border-line border-t-brand" />
        <p className="text-2xl font-bold">{t("checking_prices")}</p>
      </Center>
    );

  if (phase === "forwarded")
    return (
      <Center>
        <div className="text-6xl">📨</div>
        <p className="px-6 text-center text-3xl font-extrabold">{t("forwarded_title")}</p>
        <p className="px-8 text-center text-xl text-faint">{t("forwarded_body")}</p>
        <Link href="/" className="flex h-16 w-full items-center justify-center rounded-2xl bg-brand text-2xl font-extrabold text-white">
          {t("home")}
        </Link>
      </Center>
    );

  if (phase === "waiting") {
    const stuckApproved = waitingState === "approved" && Date.now() - waitingSince > 20_000;
    return (
      <Center>
        <div className="text-6xl animate-bob">🙏</div>
        <p className="px-8 text-center text-3xl font-extrabold">{pick(lang, waitingMsg)}</p>
        <p className="text-lg text-faint">{t("keep_open")}</p>
        {stuckApproved && (
          <button type="button" onClick={() => void retryCheckout()} className="h-16 w-full rounded-2xl bg-brand text-2xl font-extrabold text-white">
            {t("try_again")}
          </button>
        )}
      </Center>
    );
  }

  if (phase === "failed")
    return (
      <Center>
        <div className="text-6xl">😔</div>
        <p className="px-8 text-center text-2xl font-bold">{error ?? t("generic_error")}</p>
        <Link href="/" className="rounded-2xl bg-brand px-8 py-4 text-2xl font-bold text-white">
          {t("speak_again")}
        </Link>
      </Center>
    );

  const total = cart?.toPayPaise ?? 0;
  const itemTotal = cart?.itemTotalPaise ?? cart?.items.reduce((s, i) => s + i.linePaise, 0) ?? 0;
  const anyItems = Object.values(lines).some((l) => l.quantity > 0);
  const minOrderShort = anyItems && itemTotal > 0 && itemTotal < MIN_ORDER_PAISE;
  const swiggyMoney = payment === "SWIGGY_MONEY" && cart?.paymentOptions?.swiggyMoney?.available;
  const syncing = inFlight > 0;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col pb-44">
      <header className="sticky top-0 z-20 flex items-center justify-between gap-2 bg-bg/95 px-3 py-2 backdrop-blur">
        <Link href="/" className="flex h-12 items-center rounded-xl px-3 text-xl font-bold text-faint active:bg-line">
          {t("back")}
        </Link>
        <h1 className="text-2xl font-extrabold">{t("your_list")}</h1>
        <div className="flex items-center gap-2">
          <LangToggle />
          <button type="button" onClick={() => void speak(t("total_speech", { n: Math.round(total / 100) }), lang)} className="h-12 w-12 rounded-full bg-card text-2xl shadow" aria-label={t("hear_total")}>
            🔊
          </button>
        </div>
      </header>

      {error && (
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
                  <p className="text-2xl font-bold">{lang === "en" ? item.voice.search_en : item.voice.name_hi}</p>
                  <p className="text-lg font-semibold text-danger">{t("not_found")}</p>
                </div>
              </div>
            ) : item.status === "ambiguous" ? (
              <div>
                <p className="mb-2 text-2xl font-bold">
                  {lang === "en" ? item.voice.search_en : item.voice.name_hi} <span className="text-warn">?</span>
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
                  <p className="truncate text-2xl font-bold leading-tight">{itemName(item)}</p>
                  <p className="truncate text-base text-faint">
                    {item.chosen!.product.name} · {item.chosen!.variant.packDesc}
                  </p>
                  <p className="text-xl font-extrabold">{ru(priceOf(item))}</p>
                </div>
                <div className="flex items-center gap-1">
                  <Stepper label={t("decrease")} onClick={() => bump(item, -1)}>
                    −
                  </Stepper>
                  <span className="w-9 text-center text-2xl font-extrabold">{lines[item.key]?.quantity ?? 0}</span>
                  <Stepper label={t("increase")} onClick={() => bump(item, +1)}>
                    +
                  </Stepper>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      {(cart?.removedOutOfStock.length ?? 0) > 0 && (
        <p className="mx-5 mt-3 rounded-2xl bg-warn-bg px-4 py-2 text-base font-semibold text-warn">
          {t("out_of_stock")} {cart!.removedOutOfStock.join(", ")}
        </p>
      )}

      <footer className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-md border-t border-line bg-card px-5 pb-6 pt-3 shadow-[0_-8px_30px_rgba(0,0,0,0.08)]">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-lg font-semibold text-faint">
            {swiggyMoney ? t("wallet_short") : `💵 ${ru(total)} ${t("cash_to_pay")}`}
            {cart && cart.storeCount > 1 ? ` · 🏪 ${cart.storeCount} ${t("stores")}` : ""}
          </span>
          <span className="text-3xl font-extrabold">{syncing ? <span className="text-faint">…</span> : ru(total)}</span>
        </div>
        {minOrderShort && <p className="mb-2 text-center text-base font-bold text-warn">{MSG.below_min[lang]}</p>}
        <div className="flex gap-3">
          <Link href="/" className="flex h-16 flex-1 items-center justify-center rounded-2xl border-2 border-brand text-xl font-extrabold text-brand">
            {t("say_more")}
          </Link>
          <button
            type="button"
            disabled={!anyItems || syncing || minOrderShort}
            onClick={() => void openSheet()}
            className="h-16 flex-[1.4] rounded-2xl bg-go text-2xl font-extrabold text-white shadow-lg disabled:opacity-40"
          >
            {t("order_now")}
          </button>
        </div>
      </footer>

      {(phase === "sheet" || phase === "countdown") && cart && (
        <div className="fixed inset-0 z-40 flex items-end bg-black/50" role="dialog">
          <div className="mx-auto w-full max-w-md rounded-t-3xl bg-bg p-5 pb-8">
            <p className="text-center text-2xl font-extrabold">{t("confirm_q")}</p>
            <div className="my-3 flex gap-2 overflow-x-auto">
              {cart.items.map((ci) => (
                <span key={ci.spinId} className="flex shrink-0 items-center gap-1 rounded-xl bg-card px-3 py-2 text-base font-bold shadow-sm">
                  {productEmoji(ci.name)} ×{ci.quantity}
                </span>
              ))}
            </div>
            <p className="mb-1 text-center text-4xl font-extrabold">{ru(total)}</p>
            <p className="mb-4 text-center text-lg font-semibold text-faint">{swiggyMoney ? t("pay_wallet") : t("pay_cod")}</p>
            {phase === "sheet" ? (
              <>
                <HoldConfirm
                  label={`✅ ${ru(total)} — ${t("hold_to_confirm")}`}
                  holdingLabel={t("holding")}
                  onConfirmed={() => {
                    setCountdown(15);
                    setPhase("countdown");
                  }}
                />
                <button type="button" onClick={() => setPhase("ready")} className="mt-3 h-14 w-full rounded-2xl text-xl font-bold text-faint">
                  {t("back_plain")}
                </button>
              </>
            ) : (
              <>
                <p className="text-center text-xl font-bold">{t("ordering_in", { n: countdown })}</p>
                <button
                  type="button"
                  onClick={() => {
                    setPhase("ready");
                    void speak(t("cancelled_speech"), lang);
                  }}
                  className="mt-3 h-16 w-full rounded-2xl bg-danger text-2xl font-extrabold text-white"
                >
                  {t("cancel")}
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
