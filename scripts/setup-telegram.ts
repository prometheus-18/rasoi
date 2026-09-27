/**
 * Telegram bot setup helper. Reads .env.local.
 *
 *   npx tsx scripts/setup-telegram.ts            # who am I, who messaged me (→ OWNER_CHAT_ID), webhook status
 *   npx tsx scripts/setup-telegram.ts --webhook  # set the webhook to $APP_URL/api/telegram with the secret
 *   npx tsx scripts/setup-telegram.ts --unset    # delete the webhook (needed before getUpdates works again)
 *
 * Steps for the owner: create the bot with @BotFather, put TELEGRAM_BOT_TOKEN in .env.local, tap Start on
 * the bot in Telegram, run this script → copy the printed chat id into OWNER_CHAT_ID.
 */
import { loadEnvLocal } from "./lib/env-local";

loadEnvLocal();
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is missing in .env.local");
  process.exit(1);
}
const flag = (f: string) => process.argv.includes(f);

async function tg(method: string, body?: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description ?? res.status}`);
  return json.result;
}

async function main() {
  const me = await tg("getMe");
  console.log(`Bot: @${me.username} (id ${me.id})`);

  if (flag("--unset")) {
    await tg("deleteWebhook", { drop_pending_updates: false });
    console.log("Webhook deleted.");
  }

  if (flag("--webhook")) {
    const appUrl = process.env.APP_URL?.replace(/\/$/, "");
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!appUrl || !secret) {
      console.error("APP_URL and TELEGRAM_WEBHOOK_SECRET must be set in .env.local to set the webhook.");
      process.exit(1);
    }
    await tg("setWebhook", {
      url: `${appUrl}/api/telegram`,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
    console.log(`Webhook set → ${appUrl}/api/telegram`);
  }

  const info = await tg("getWebhookInfo");
  console.log(`Webhook: ${info.url || "(none)"}${info.last_error_message ? ` — last error: ${info.last_error_message}` : ""}`);

  if (!info.url) {
    const updates: any[] = await tg("getUpdates", { limit: 50, allowed_updates: ["message"] });
    const seen = new Map<number, string>();
    for (const u of updates) {
      const m = u.message;
      if (m?.from?.id) seen.set(m.from.id, `${m.from.first_name ?? ""} ${m.from.last_name ?? ""} (@${m.from.username ?? "-"}) — "${(m.text ?? "").slice(0, 40)}"`);
    }
    if (!seen.size) console.log("\nNo messages yet. Open the bot in Telegram, tap Start, then run this again.");
    else {
      console.log("\nPeople who messaged the bot:");
      for (const [id, who] of seen) console.log(`  OWNER_CHAT_ID=${id}   ${who}`);
    }
    if (process.env.OWNER_CHAT_ID) console.log(`\nCurrent OWNER_CHAT_ID=${process.env.OWNER_CHAT_ID}${seen.has(Number(process.env.OWNER_CHAT_ID)) ? " ✓ matches" : ""}`);
  } else {
    console.log("(getUpdates is unavailable while a webhook is set — run with --unset to list chat ids.)");
  }
}

main().catch((e) => {
  console.error("FAILED:", e.message ?? e);
  process.exit(1);
});
