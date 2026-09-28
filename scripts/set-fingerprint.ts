/**
 * Computes PINNED_ADDRESS_FINGERPRINT for the pinned address from the latest read-only spike dump,
 * writes it to .env.local and (if VERCEL_TOKEN is present) to the Vercel project env.
 *   npx tsx scripts/set-fingerprint.ts
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnvLocal } from "./lib/env-local";

loadEnvLocal();
const { makeFingerprint } = await import("../lib/commerce/address");

const files = readdirSync("spike-results").filter((f) => f.startsWith("readonly-")).sort();
if (!files.length) throw new Error("run scripts/spike-readonly.ts first");
const dump = JSON.parse(readFileSync(`spike-results/${files.at(-1)}`, "utf8"));
const addrs: any[] = dump.get_addresses?.payload?.addresses ?? dump.get_addresses?.payload?.data?.addresses ?? [];
const pinnedId = process.env.PINNED_ADDRESS_ID;
const a = addrs.find((x) => x.id === pinnedId);
if (!a) throw new Error("pinned address not in dump");
const fp = JSON.stringify(makeFingerprint({ id: a.id, label: a.addressTag ?? a.addressCategory, line: a.addressLine }));
console.log("fingerprint:", fp);

let env = readFileSync(".env.local", "utf8");
env = env.replace(/^PINNED_ADDRESS_FINGERPRINT=.*$/m, `PINNED_ADDRESS_FINGERPRINT=${fp}`);
writeFileSync(".env.local", env);
console.log(".env.local updated");

const token = process.env.VERCEL_TOKEN;
if (token) {
  const H = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  const p = await (await fetch("https://api.vercel.com/v9/projects/rasoi?slug=rahul-vermas-projects-2b206f2b", { headers: H })).json();
  const q = `?teamId=${p.accountId}`;
  const list = await (await fetch(`https://api.vercel.com/v9/projects/${p.id}/env${q}`, { headers: H })).json();
  const e = list.envs.find((x: any) => x.key === "PINNED_ADDRESS_FINGERPRINT");
  const r = await fetch(`https://api.vercel.com/v9/projects/${p.id}/env/${e.id}${q}`, { method: "PATCH", headers: H, body: JSON.stringify({ value: fp, target: ["production", "preview"] }) });
  console.log("Vercel env:", r.ok ? "patched (takes effect on next deploy)" : `FAILED ${r.status}`);
}
