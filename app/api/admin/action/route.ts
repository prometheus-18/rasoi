// POST { action, ... } → owner actions from /admin.
// SAFETY-LOWERING actions (dryrun_off, resume) require a Telegram Approve tap when the bot
// is configured — the web session alone is not enough.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { json } from "@/lib/api";
import { createPairingCode } from "@/lib/auth/device";
import { isOwnerRequest } from "@/lib/auth/owner";
import { env } from "@/lib/env";
import { makeCallbackData, sendOwner } from "@/lib/notify/telegram";
import { resolveUnknown, setFlag } from "@/lib/orders/engine";
import { getStore } from "@/lib/store";

const zBody = z.object({
  action: z.enum(["pause", "resume", "dryrun_on", "dryrun_off", "pair_code", "revoke_device", "unlock_device", "resolve", "test_telegram"]),
  deviceId: z.string().optional(),
  name: z.string().max(40).optional(),
  orderId: z.string().optional(),
  placed: z.boolean().optional(),
});

async function confirmViaTelegram(key: "paused" | "dryRun", value: boolean, label: string): Promise<boolean> {
  if (!env.telegramConfigured) return false;
  const cb = await makeCallbackData({ action: "confirm_setting", key, value });
  await sendOwner(`⚠️ Confirm on Telegram: ${label}`, [[{ text: `Yes, ${label}`, callback_data: cb }]]);
  return true;
}

export async function POST(req: NextRequest) {
  if (!(await isOwnerRequest(req))) return json({ error: "owner_only" }, 401);
  const body = zBody.safeParse(await req.json().catch(() => null));
  if (!body.success) return json({ error: "bad_request" }, 400);
  const store = getStore();
  const a = body.data;

  switch (a.action) {
    case "pause":
      await setFlag("paused", true);
      await sendOwner("⏸️ Ordering PAUSED from /admin.");
      return json({ ok: true });
    case "resume":
      if (await confirmViaTelegram("paused", false, "resume ordering")) return json({ ok: true, pending: "confirm on Telegram" });
      await setFlag("paused", false);
      return json({ ok: true });
    case "dryrun_on":
      await setFlag("dryRun", true);
      await sendOwner("🧪 DRY RUN is ON — no real orders.");
      return json({ ok: true });
    case "dryrun_off":
      if (await confirmViaTelegram("dryRun", false, "turn DRY RUN OFF (real orders!)")) return json({ ok: true, pending: "confirm on Telegram" });
      // Without Telegram there is no second factor — refuse, since this enables real money movement.
      return json({ error: "telegram_required", message: "Configure the Telegram bot first; DRY RUN off needs a Telegram confirmation tap." }, 400);
    case "pair_code": {
      const code = await createPairingCode(a.name ?? "cook");
      return json({ ok: true, code, expiresMin: 10 });
    }
    case "revoke_device":
      if (!a.deviceId) return json({ error: "deviceId required" }, 400);
      await store.revokeDevice(a.deviceId);
      await store.audit("device_revoked", { deviceId: a.deviceId });
      return json({ ok: true });
    case "unlock_device":
      if (!a.deviceId) return json({ error: "deviceId required" }, 400);
      await store.unlockDevice(a.deviceId);
      await store.audit("device_unlocked", { deviceId: a.deviceId });
      return json({ ok: true });
    case "resolve":
      if (!a.orderId || a.placed === undefined) return json({ error: "orderId and placed required" }, 400);
      await resolveUnknown(a.orderId, a.placed);
      return json({ ok: true });
    case "test_telegram":
      await sendOwner("👋 Rasoi test message — the bot works.");
      return json({ ok: env.telegramConfigured, configured: env.telegramConfigured });
  }
}
