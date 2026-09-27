// Telegram webhook. Auth: X-Telegram-Bot-Api-Secret-Token (constant-time) + from.id == OWNER
// + update_id dedupe. Replies 200 fast; all work runs in after().

import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { createOwnerLink } from "@/lib/auth/owner";
import { completeSwiggyPaste, swiggyLoginStatus } from "@/lib/commerce/swiggy-auth";
import { timingSafeEqualStr } from "@/lib/crypto";
import { env } from "@/lib/env";
import { answerCallback, consumeCallbackData, editOwnerMessage, makeCallbackData, sendChat, sendOwner } from "@/lib/notify/telegram";
import { runCheckout } from "@/lib/orders/checkout";
import { approveDraft, getFlags, getLimits, rejectDraft, resolveUnknown, resumeWaitingDrafts, retryApprovedDrafts, setFlag, spendContext } from "@/lib/orders/engine";
import { createPairingCode } from "@/lib/auth/device";
import { getStore } from "@/lib/store";
import { rupeesText } from "@/lib/types";

export const maxDuration = 300;

const ok = () => NextResponse.json({ ok: true });

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!env.telegramWebhookSecret || !timingSafeEqualStr(secret, env.telegramWebhookSecret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const update: any = await req.json().catch(() => null);
  if (!update?.update_id) return ok();
  if (!(await getStore().markUpdateProcessed(Number(update.update_id)))) return ok();

  after(async () => {
    try {
      if (update.callback_query) await handleCallback(update.callback_query);
      else if (update.message) await handleMessage(update.message);
    } catch (e) {
      console.error("telegram handler error", e);
    }
  });
  return ok();
}

function isOwner(fromId: unknown): boolean {
  return Boolean(env.ownerChatId) && String(fromId) === String(env.ownerChatId);
}

async function handleCallback(cq: any): Promise<void> {
  if (!isOwner(cq.from?.id)) {
    await answerCallback(cq.id, "Not authorized");
    return;
  }
  const action = await consumeCallbackData(String(cq.data ?? ""));
  const messageId: number | undefined = cq.message?.message_id;
  if (!action) {
    await answerCallback(cq.id, "This button expired");
    if (messageId) await editOwnerMessage(messageId, `${cq.message?.text ?? ""}\n\n(expired)`);
    return;
  }
  await answerCallback(cq.id);
  const baseText: string = cq.message?.text ?? "";

  switch (action.action) {
    case "approve": {
      const result = await approveDraft(action.draftId!, action.version);
      if (result === "checkout") {
        if (messageId) await editOwnerMessage(messageId, `${baseText}\n\n✅ APPROVED — placing…`);
        await runCheckout(action.draftId!);
      } else if (result === "waiting_login") {
        if (messageId) await editOwnerMessage(messageId, `${baseText}\n\n✅ APPROVED — waiting for Swiggy login. Send /login.`);
      } else {
        if (messageId) await editOwnerMessage(messageId, `${baseText}\n\n(${result === "stale" ? "list changed since — ask the cook to confirm again" : "no longer pending"})`);
      }
      return;
    }
    case "reject": {
      const done = await rejectDraft(action.draftId!);
      if (messageId) await editOwnerMessage(messageId, `${baseText}\n\n${done ? "❌ REJECTED" : "(no longer pending)"}`);
      return;
    }
    case "confirm_setting": {
      await setFlag(action.key as "paused" | "dryRun", Boolean(action.value));
      if (messageId) await editOwnerMessage(messageId, `${baseText}\n\n✓ done`);
      if (action.key === "dryRun" && action.value === false) await sendOwner("🔴 DRY RUN is OFF — orders are REAL now (in Production).");
      if (action.key === "paused" && action.value === false) await retryApprovedDrafts(runCheckout);
      return;
    }
    case "resolve_placed":
    case "resolve_not_placed": {
      await resolveUnknown(action.key!, action.action === "resolve_placed");
      if (messageId) await editOwnerMessage(messageId, `${baseText}\n\n✓ marked ${action.action === "resolve_placed" ? "PLACED" : "NOT placed"}`);
      await retryApprovedDrafts(runCheckout); // anything that was waiting behind the unknown order
      return;
    }
    case "unlock_device": {
      await getStore().unlockDevice(action.key!);
      if (messageId) await editOwnerMessage(messageId, `${baseText}\n\n✓ unlocked`);
      return;
    }
    case "revoke_device": {
      await getStore().revokeDevice(action.key!);
      if (messageId) await editOwnerMessage(messageId, `${baseText}\n\n✓ revoked`);
      return;
    }
  }
}

async function handleMessage(msg: any): Promise<void> {
  const text: string = (msg.text ?? "").trim();
  const fromId = msg.from?.id;

  if (!env.ownerChatId) {
    // Setup phase: help the owner find their chat id, do nothing else.
    if (text.startsWith("/start")) await sendChat(msg.chat.id, `Namaste! Your chat id is ${msg.chat.id}. Put it in Vercel as OWNER_CHAT_ID and redeploy.`);
    return;
  }
  if (!isOwner(fromId)) return; // silently ignore strangers

  const store = getStore();
  const reply = (t: string, buttons?: { text: string; callback_data?: string; url?: string }[][]) => sendOwner(t, buttons);

  // Paste-back login: a message containing code= or a bare long code while a login is pending.
  if (/[?&]code=/.test(text) || (/^[A-Za-z0-9_.~-]{16,}$/.test(text) && !text.startsWith("/"))) {
    try {
      const { expiresAt } = await completeSwiggyPaste(text);
      await reply(`🔓 Swiggy login OK. Valid until ${expiresAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST.`);
      const resumed = await resumeWaitingDrafts(runCheckout);
      await retryApprovedDrafts(runCheckout);
      if (resumed > 0) await reply(`▶️ ${resumed} waiting order(s) resumed.`);
    } catch (e) {
      await reply(`Login paste failed: ${String((e as Error).message)}. Tap the /login link and paste again within 2 minutes.`);
    }
    return;
  }

  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  switch (cmd) {
    case "/start":
    case "/help":
      await reply(
        "Rasoi bot commands:\n/login — Swiggy login link\n/pause /resume — stop/allow ordering\n/dryrun on|off — practice mode\n/orders — recent orders\n/budget — today/week spend\n/limits — current limits\n/pair — new device code\n/devices — list devices\n/unlock — unlock devices\n/resolve — settle an unknown order\n/admin — open the dashboard",
      );
      return;
    case "/pause":
      await setFlag("paused", true);
      await reply("⏸️ Paused. No orders can be placed until /resume.");
      return;
    case "/resume": {
      await setFlag("paused", false);
      await reply("▶️ Resumed. Ordering is allowed again.");
      const n = await retryApprovedDrafts(runCheckout);
      if (n) await reply(`▶️ ${n} approved order(s) that were waiting are being placed now.`);
      return;
    }
    case "/dryrun": {
      const arg = text.split(/\s+/)[1]?.toLowerCase();
      const flags = await getFlags();
      if (arg === "on") {
        await setFlag("dryRun", true);
        await reply("🧪 DRY RUN ON — no real orders.");
      } else if (arg === "off") {
        const cb = await makeCallbackData({ action: "confirm_setting", key: "dryRun", value: false });
        await reply("⚠️ Turn DRY RUN OFF? Orders become REAL (in Production) and cannot be cancelled.", [[{ text: "Yes, go live", callback_data: cb }]]);
      } else await reply(`DRY RUN is ${flags.dryRun ? "ON (practice mode)" : "OFF (real orders in Production)"}. Use /dryrun on|off.`);
      return;
    }
    case "/login": {
      const url = await createOwnerLink("/api/swiggy/login");
      const status = await swiggyLoginStatus();
      await reply(
        `${status.loggedIn ? `Current login OK (${status.hoursLeft} h left).` : "Not logged in."}\n\nOpen this in CHROME (not Telegram's browser), finish the phone+OTP login, then copy the final address-bar URL from the error page and paste it here:\n${url}\n\nLink valid 10 min; the pasted code only 2 min.`,
      );
      return;
    }
    case "/pair": {
      const name = text.split(/\s+/).slice(1).join(" ") || "cook";
      const code = await createPairingCode(name);
      await reply(`📱 Pairing code for "${name}": ${code}\nOn the cook's phone open ${env.appUrl}/pair and enter it within 10 minutes.`);
      return;
    }
    case "/orders": {
      const orders = await store.recentOrders(8);
      if (!orders.length) {
        await reply("No orders yet.");
        return;
      }
      const lines = orders.map((o) => `${o.createdAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} — ₹${rupeesText(o.totalPaise)} ${o.paymentMethod} → ${o.state}`);
      await reply(lines.join("\n"));
      return;
    }
    case "/budget": {
      const [limits, spend] = await Promise.all([getLimits(), spendContext(new Date())]);
      await reply(
        `Today: ₹${rupeesText(spend.spentDayPaise)} of ₹${rupeesText(limits.perDayPaise)} (${spend.ordersToday}/${limits.ordersPerDay} orders)\nThis week: ₹${rupeesText(spend.spentWeekPaise)} of ₹${rupeesText(limits.perWeekPaise)}`,
      );
      return;
    }
    case "/limits": {
      const l = await getLimits();
      await reply(
        `Per order ₹${rupeesText(l.perOrderPaise)} · day ₹${rupeesText(l.perDayPaise)} · week ₹${rupeesText(l.perWeekPaise)}\nOrders/day ${l.ordersPerDay} · COD ₹${rupeesText(l.codPerOrderPaise)} ×${l.codOrdersPerDay}/day\nHours 06:00–21:30 IST · supervised: ${l.supervised ? "ON (everything needs approval)" : "off"}`,
      );
      return;
    }
    case "/devices": {
      const devices = await store.listDevices();
      if (!devices.length) {
        await reply("No devices paired. /pair to create a code.");
        return;
      }
      for (const d of devices.filter((d) => !d.revoked)) {
        const cbRevoke = await makeCallbackData({ action: "revoke_device", key: d.id });
        const buttons = [[{ text: "🗑 Revoke", callback_data: cbRevoke }]];
        if (d.locked) buttons[0].push({ text: "🔓 Unlock", callback_data: await makeCallbackData({ action: "unlock_device", key: d.id }) });
        await reply(`📱 ${d.name}${d.locked ? " (LOCKED)" : ""} — last seen ${d.lastSeen ? d.lastSeen.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "never"}`, buttons);
      }
      return;
    }
    case "/unlock": {
      const locked = (await store.listDevices()).filter((d) => d.locked && !d.revoked);
      for (const d of locked) await store.unlockDevice(d.id);
      await reply(locked.length ? `🔓 Unlocked: ${locked.map((d) => d.name).join(", ")}` : "No locked devices.");
      return;
    }
    case "/resolve": {
      const unknowns = await store.unknownOrders();
      if (!unknowns.length) {
        await reply("Nothing to resolve — no unknown orders.");
        return;
      }
      for (const u of unknowns) {
        const placed = await makeCallbackData({ action: "resolve_placed", key: u.id });
        const notPlaced = await makeCallbackData({ action: "resolve_not_placed", key: u.id });
        await reply(`❓ Unknown order ₹${rupeesText(u.totalPaise)} (${u.paymentMethod}) from ${u.createdAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}. Check the Swiggy app — did it go through?`, [
          [{ text: "It was placed", callback_data: placed }, { text: "NOT placed", callback_data: notPlaced }],
        ]);
      }
      return;
    }
    case "/admin": {
      const url = await createOwnerLink("/admin");
      await reply(`Dashboard (valid 10 min, then the session lasts 12 h):\n${url}`);
      return;
    }
    default:
      if (text.startsWith("/")) await reply("Unknown command — /help");
  }
}
