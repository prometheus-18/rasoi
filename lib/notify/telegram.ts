// Telegram Bot API via plain fetch. Owner-facing text is English, plain text (no parse_mode).
// Approve/Reject buttons carry an opaque single-use token stored in the KV — the callback_data
// itself contains no draft ids or amounts (and stays well under Telegram's 64-byte limit).

import { randomToken } from "@/lib/crypto";
import { env } from "@/lib/env";
import { getStore } from "@/lib/store";

export type TgButton = { text: string; callback_data?: string; url?: string };

async function tg(method: string, payload: Record<string, unknown>): Promise<any> {
  if (!env.telegramBotToken) {
    console.log(`[telegram disabled] ${method}`, JSON.stringify(payload).slice(0, 400));
    return null;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.telegramBotToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) console.error(`telegram ${method} failed`, res.status, JSON.stringify(body)?.slice(0, 300));
    return body;
  } catch (e) {
    console.error(`telegram ${method} error`, String(e));
    return null;
  }
}

export async function sendOwner(text: string, buttons?: TgButton[][]): Promise<number | null> {
  if (!env.ownerChatId) {
    console.log(`[telegram disabled] sendOwner: ${text}`);
    return null;
  }
  const body = await tg("sendMessage", {
    chat_id: env.ownerChatId,
    text,
    // never let Telegram's preview crawler fetch our one-time links
    link_preview_options: { is_disabled: true },
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
  return body?.result?.message_id ?? null;
}

export async function editOwnerMessage(messageId: number, text: string): Promise<void> {
  if (!env.ownerChatId) return;
  await tg("editMessageText", { chat_id: env.ownerChatId, message_id: messageId, text });
}

export async function answerCallback(callbackQueryId: string, text?: string): Promise<void> {
  await tg("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
}

export async function sendChat(chatId: number | string, text: string): Promise<void> {
  await tg("sendMessage", { chat_id: chatId, text, link_preview_options: { is_disabled: true } });
}

// ── Single-use callback tokens (approve/reject and other owner actions) ──────

export type CallbackAction = {
  action: "approve" | "reject" | "confirm_setting" | "resolve_placed" | "resolve_not_placed" | "unlock_device" | "revoke_device";
  draftId?: string;
  version?: number;
  key?: string;
  value?: unknown;
};

const CB_TTL_MS = 60 * 60_000;

export async function makeCallbackData(action: CallbackAction): Promise<string> {
  const token = randomToken(12);
  await getStore().setKV(`cb:${token}`, action, CB_TTL_MS);
  return `cb:${token}`;
}

/** Atomic take — a button can only ever fire once. Expired/duplicate → null. */
export async function consumeCallbackData(data: string): Promise<CallbackAction | null> {
  if (!data.startsWith("cb:")) return null;
  return await getStore().takeKV<CallbackAction>(`cb:${data.slice(3)}`);
}
