"use client";

// Owner dashboard (English). Reached via the one-time link from the bot (/admin command).
// Doubles as the setup checklist while env vars are still missing.

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";

type State = {
  setup: Record<string, boolean>;
  appUrl: string;
  flags: { paused: boolean; dryRun: boolean };
  limits: Record<string, unknown> & { supervised: boolean };
  spend: { spentDayPaise: number; spentWeekPaise: number; ordersToday: number };
  login: { loggedIn: boolean; expiresAt?: string; hoursLeft?: number };
  pinnedAddressId: string | null;
  addresses: { id: string; label?: string; line?: string; pincode?: string; lat?: number; lng?: number; pinned: boolean }[];
  addressError: string | null;
  devices: { id: string; name: string; locked: boolean; revoked: boolean; lastSeen?: string }[];
  orders: { id: string; state: string; totalPaise: number; paymentMethod: string; createdAt: string; swiggyOrderIds?: string[] }[];
  unknownCount: number;
};

const ru = (p: number) => `₹${Math.round(p / 100)}`;

const SETUP_LABELS: Record<string, string> = {
  database: "Neon Postgres (DATABASE_URL)",
  gemini: "Gemini key (GEMINI_API_KEY, project rasoi-prod)",
  groq: "Groq key — Whisper fallback (GROQ_API_KEY)",
  telegram: "Telegram bot (TELEGRAM_BOT_TOKEN + OWNER_CHAT_ID)",
  tokenEncKey: "Token encryption key (TOKEN_ENC_KEY)",
  pinPepper: "PIN pepper (PIN_PEPPER)",
  cronSecret: "Cron secret (CRON_SECRET)",
  pinnedAddress: "Pinned address (PINNED_ADDRESS_ID)",
  allowRealOrders: "Real orders enabled (ALLOW_REAL_ORDERS, Production)",
};

export function AdminClient() {
  const [s, setS] = useState<State | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  const [pairName, setPairName] = useState("रसोई");

  const load = useCallback(async () => {
    try {
      setS(await api<State>("/api/admin/state"));
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 401 ? "Session expired — send /admin to the Telegram bot for a fresh link." : "Failed to load.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(body: Record<string, unknown>, okMsg?: string) {
    setMsg(null);
    try {
      const res = await api<any>("/api/admin/action", { method: "POST", body: JSON.stringify(body) });
      setMsg(res.pending ? `→ ${res.pending}` : (res.code ? `Pairing code: ${res.code} (10 min)` : okMsg ?? "Done."));
      void load();
    } catch (e) {
      setMsg(e instanceof ApiError ? `Error: ${e.data?.message ?? e.data?.error}` : "Network error");
    }
  }

  async function submitPaste() {
    setMsg(null);
    try {
      const res = await api<any>("/api/swiggy/paste", { method: "POST", body: JSON.stringify({ pasted: paste }) });
      setMsg(`Swiggy login OK until ${new Date(res.expiresAt).toLocaleString()}`);
      setPaste("");
      void load();
    } catch (e) {
      setMsg(e instanceof ApiError ? `Login failed: ${e.data?.message ?? e.data?.error}` : "Network error");
    }
  }

  if (err) return <Shell><p className="rounded-2xl bg-red-50 p-4 text-lg font-bold text-danger">{err}</p></Shell>;
  if (!s) return <Shell><p className="text-lg text-faint">Loading…</p></Shell>;

  const setupDone = Object.entries(s.setup).filter(([k]) => k !== "demo" && k !== "allowRealOrders").every(([, v]) => v);

  return (
    <Shell>
      {msg && <button type="button" onClick={() => setMsg(null)} className="w-full rounded-2xl bg-warn-bg px-4 py-3 text-left text-base font-semibold text-warn">{msg}</button>}

      <Card title="Status">
        <div className="grid grid-cols-2 gap-2 text-base">
          <Stat label="Mode" value={s.setup.demo ? "DEMO (no DB)" : s.flags.dryRun ? "DRY RUN" : "🔴 LIVE"} />
          <Stat label="Ordering" value={s.flags.paused ? "⏸ paused" : "▶ active"} />
          <Stat label="Swiggy login" value={s.login.loggedIn ? `OK · ${s.login.hoursLeft} h left` : "❌ not logged in"} />
          <Stat label="Today" value={`${ru(s.spend.spentDayPaise)} · ${s.spend.ordersToday} orders`} />
          <Stat label="This week" value={ru(s.spend.spentWeekPaise)} />
          <Stat label="Supervised" value={s.limits.supervised ? "ON (all orders approved)" : "off"} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {s.flags.paused ? (
            <Btn onClick={() => act({ action: "resume" })}>▶ Resume</Btn>
          ) : (
            <Btn onClick={() => act({ action: "pause" })}>⏸ Pause</Btn>
          )}
          {s.flags.dryRun ? (
            <Btn onClick={() => act({ action: "dryrun_off" })}>Go live (confirm on Telegram)</Btn>
          ) : (
            <Btn onClick={() => act({ action: "dryrun_on" })}>Back to DRY RUN</Btn>
          )}
          <Btn onClick={() => act({ action: "test_telegram" }, "Sent (check Telegram)")}>Test Telegram</Btn>
        </div>
        {s.unknownCount > 0 && <p className="mt-3 rounded-xl bg-red-50 p-3 font-bold text-danger">⚠ {s.unknownCount} unknown order(s) — resolve via the bot: /resolve</p>}
      </Card>

      <Card title="Swiggy login (paste-back)">
        <p className="text-sm text-faint">
          1. Open <a className="font-bold text-brand underline" href="/api/swiggy/login" target="_blank" rel="noreferrer">the Swiggy login link</a> in Chrome and finish the phone + OTP login.
          <br />
          2. Chrome lands on a “localhost — site can’t be reached” page. That is expected. Copy the FULL address-bar URL.
          <br />
          3. Paste it here within 2 minutes:
        </p>
        <div className="mt-2 flex gap-2">
          <input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="http://localhost/callback?code=…" className="min-w-0 flex-1 rounded-xl border-2 border-line bg-white p-3 text-sm" />
          <Btn onClick={() => void submitPaste()}>Save</Btn>
        </div>
        {s.login.loggedIn && (
          <div className="mt-3 flex items-center justify-between">
            <span className="text-sm text-faint">Logged in · {s.login.hoursLeft} h left</span>
            <Btn onClick={() => act({ action: "clear_swiggy_login" }, "Swiggy login deleted")}>Delete login (incident)</Btn>
          </div>
        )}
      </Card>

      <Card title="Delivery address (PINNED_ADDRESS_ID)">
        {!s.login.loggedIn && <p className="text-sm text-faint">Log in to Swiggy first — the saved addresses show here so you can pin the home address.</p>}
        {s.addressError && <p className="text-sm text-danger">{s.addressError}</p>}
        {s.addresses.map((a) => (
          <div key={a.id} className={`border-b border-line py-2 text-sm last:border-0 ${a.pinned ? "font-bold" : ""}`}>
            {a.pinned ? "📌 " : ""}
            {a.label ?? "address"} — {a.line ?? ""} {a.pincode ?? ""}
            <div className="mt-1 break-all font-mono text-xs text-faint">id: {a.id}</div>
          </div>
        ))}
        {s.login.loggedIn && !s.pinnedAddressId && s.addresses.length > 0 && (
          <p className="mt-2 rounded-xl bg-warn-bg p-2 text-sm text-warn">Copy the home address id into Vercel as PINNED_ADDRESS_ID (Production, Sensitive) and redeploy. No real order can be placed until then.</p>
        )}
      </Card>

      <Card title="Devices">
        {s.devices.filter((d) => !d.revoked).length === 0 && <p className="text-base text-faint">None paired yet.</p>}
        {s.devices.filter((d) => !d.revoked).map((d) => (
          <div key={d.id} className="flex items-center justify-between border-b border-line py-2 last:border-0">
            <div>
              <p className="font-bold">📱 {d.name} {d.locked && <span className="text-danger">LOCKED</span>}</p>
              <p className="text-sm text-faint">last seen {d.lastSeen ? new Date(d.lastSeen).toLocaleString() : "never"}</p>
            </div>
            <div className="flex gap-2">
              {d.locked && <Btn onClick={() => act({ action: "unlock_device", deviceId: d.id })}>Unlock</Btn>}
              <Btn onClick={() => act({ action: "revoke_device", deviceId: d.id })}>Revoke</Btn>
            </div>
          </div>
        ))}
        <div className="mt-3 flex gap-2">
          <input value={pairName} onChange={(e) => setPairName(e.target.value)} className="min-w-0 flex-1 rounded-xl border-2 border-line bg-white p-3 text-sm" placeholder="device name" />
          <Btn onClick={() => act({ action: "pair_code", name: pairName })}>New pairing code</Btn>
        </div>
      </Card>

      <Card title="Recent orders">
        {s.orders.length === 0 && <p className="text-base text-faint">No orders yet.</p>}
        {s.orders.map((o) => (
          <p key={o.id} className="border-b border-line py-2 text-sm last:border-0">
            {new Date(o.createdAt).toLocaleString()} — <b>{ru(o.totalPaise)}</b> {o.paymentMethod} → <b>{o.state}</b>
            {o.swiggyOrderIds?.length ? ` (${o.swiggyOrderIds.join(", ")})` : ""}
          </p>
        ))}
      </Card>

      <Card title={`Setup checklist ${setupDone ? "✅" : ""}`}>
        {Object.entries(SETUP_LABELS).map(([k, label]) => (
          <p key={k} className="py-1 text-base">
            {s.setup[k] ? "✅" : "⬜"} {label}
          </p>
        ))}
        <p className="mt-2 text-sm text-faint">Set these in Vercel → Project → Settings → Environment Variables (secrets: Production only + Sensitive), then redeploy.</p>
      </Card>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-4 px-5 py-8">
      <h1 className="text-3xl font-extrabold">Rasoi — owner dashboard</h1>
      {children}
    </main>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card bg-card p-4 shadow-sm">
      <h2 className="mb-2 text-xl font-extrabold">{title}</h2>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-bg p-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-faint">{label}</p>
      <p className="font-bold">{value}</p>
    </div>
  );
}

function Btn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white active:bg-brand-deep">
      {children}
    </button>
  );
}
