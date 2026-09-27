"use client";

// Owner page: connect the Swiggy account (paste-back OAuth login) and pin the delivery address.
// Reachable with an owner session (Telegram /admin link) or the ADMIN_SETUP_KEY during setup.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";

type State = {
  setup: Record<string, boolean>;
  login: { loggedIn: boolean; expiresAt?: string; hoursLeft?: number };
  pinnedAddressId: string | null;
  addresses: { id: string; label?: string; line?: string; pincode?: string; pinned: boolean }[];
  addressError: string | null;
  tools?: { names: string[]; checkoutSchema?: unknown } | null;
  flags: { dryRun: boolean; paused: boolean };
};

export function LoginClient() {
  const [s, setS] = useState<State | null>(null);
  const [needKey, setNeedKey] = useState(false);
  const [paste, setPaste] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setS(await api<State>("/api/admin/state"));
      setNeedKey(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedKey(true);
      else setMsg("Could not load. Refresh the page.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitPaste() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api<{ expiresAt: string }>("/api/swiggy/paste", { method: "POST", body: JSON.stringify({ pasted: paste }) });
      setMsg(`✅ Swiggy connected. Login valid until ${new Date(res.expiresAt).toLocaleString("en-IN")}.`);
      setPaste("");
      await load();
    } catch (e) {
      setMsg(`❌ ${e instanceof ApiError ? (e.data?.message ?? e.data?.error) : "Network error"}`);
    } finally {
      setBusy(false);
    }
  }

  if (needKey)
    return (
      <Shell>
        <Card title="Owner login">
          <p className="text-base text-faint">Enter the <b>ADMIN_SETUP_KEY</b> (from your Vercel environment variables / .env.local). Later, the Telegram bot's <b>/admin</b> link does this automatically.</p>
          <form method="post" action="/api/admin/session" className="mt-3 flex flex-col gap-3">
            <input name="key" type="password" autoComplete="off" placeholder="setup key" className="rounded-xl border-2 border-line bg-white p-3 text-lg" />
            <input type="hidden" name="next" value="/login" />
            <button type="submit" className="h-14 rounded-2xl bg-brand text-xl font-extrabold text-white">Continue →</button>
          </form>
        </Card>
      </Shell>
    );

  if (!s) return <Shell><p className="text-faint">Loading…</p></Shell>;

  const dbMissing = !s.setup.database;

  return (
    <Shell>
      {msg && <p className="rounded-2xl bg-warn-bg px-4 py-3 text-base font-semibold text-warn">{msg}</p>}

      {dbMissing && (
        <Card title="⚠ Database not configured">
          <p className="text-base">This deployment has no <b>DATABASE_URL</b>, so the Swiggy login cannot be saved. Add it in Vercel → Settings → Environment Variables and redeploy.</p>
        </Card>
      )}

      <Card title={s.login.loggedIn ? `✅ Swiggy connected · ${s.login.hoursLeft} h left` : "1 · Connect your Swiggy account"}>
        <ol className="list-decimal space-y-2 pl-5 text-base">
          <li>
            Tap the button below. Swiggy's own login page opens — enter your <b>phone number + OTP</b> (the same account you use in the Swiggy app).
          </li>
          <li>
            After the OTP, Chrome shows <b>“localhost — This site can’t be reached”</b>. That is expected — nothing is broken.
          </li>
          <li>
            Tap the address bar, <b>copy the whole URL</b> (it starts with <code>http://localhost/callback?code=</code>), paste it below and press Save — within 2 minutes.
          </li>
        </ol>
        <a
          href="/api/swiggy/login"
          target="_blank"
          rel="noreferrer"
          className="mt-4 flex h-16 items-center justify-center rounded-2xl bg-brand text-2xl font-extrabold text-white"
        >
          🔑 Open Swiggy login
        </a>
        <div className="mt-3 flex flex-col gap-2">
          <input
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder="http://localhost/callback?code=…"
            className="rounded-xl border-2 border-line bg-white p-3 text-base"
          />
          <button type="button" disabled={busy || paste.length < 6} onClick={() => void submitPaste()} className="h-14 rounded-2xl bg-go text-xl font-extrabold text-white disabled:opacity-40">
            {busy ? "…" : "Save login"}
          </button>
        </div>
        <p className="mt-3 text-sm text-faint">The login lasts 5 days. Keep the Swiggy app closed while the cook is ordering (Swiggy warns of session conflicts).</p>
      </Card>

      <Card title="2 · Delivery address">
        {!s.login.loggedIn && <p className="text-base text-faint">Appears after step 1.</p>}
        {s.addressError && <p className="text-sm text-danger">{s.addressError}</p>}
        {s.addresses.map((a) => (
          <div key={a.id} className={`border-b border-line py-2 text-base last:border-0 ${a.pinned ? "font-bold" : ""}`}>
            {a.pinned ? "📌 " : ""}
            {a.label ?? "address"} — {a.line ?? ""} {a.pincode ?? ""}
            <div className="mt-1 break-all font-mono text-xs text-faint">PINNED_ADDRESS_ID={a.id}</div>
          </div>
        ))}
        {s.login.loggedIn && !s.pinnedAddressId && s.addresses.length > 0 && (
          <p className="mt-2 rounded-xl bg-warn-bg p-2 text-sm text-warn">Copy the home address id above into Vercel as <b>PINNED_ADDRESS_ID</b> and redeploy. Orders are refused until it is set.</p>
        )}
        {s.pinnedAddressId && !s.addresses.some((a) => a.pinned) && s.addresses.length > 0 && (
          <p className="mt-2 rounded-xl bg-red-50 p-2 text-sm text-danger">PINNED_ADDRESS_ID does not match any saved address.</p>
        )}
      </Card>

      <Card title="3 · Mode">
        <p className="text-base">
          Orders are currently <b>{s.flags.dryRun ? "DRY RUN (practice — nothing is sent to Swiggy)" : "LIVE"}</b>
          {s.flags.paused ? " · PAUSED" : ""}. Payment: <b>Cash on delivery</b> (Swiggy's MCP supports COD only today).
        </p>
      </Card>

      {s.tools && (
        <Card title="Swiggy tools seen on the server">
          <p className="break-words text-sm text-faint">{s.tools.names.join(", ")}</p>
          {s.tools.checkoutSchema ? <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-bg p-2 text-xs">{JSON.stringify(s.tools.checkoutSchema, null, 1)}</pre> : null}
        </Card>
      )}

      <p className="text-center text-sm">
        <Link href="/admin" className="font-bold text-brand underline">Owner dashboard →</Link>
        {" · "}
        <Link href="/" className="font-bold text-brand underline">Cook app →</Link>
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col gap-4 px-5 py-8">
      <h1 className="text-3xl font-extrabold">Rasoi — connect Swiggy</h1>
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
