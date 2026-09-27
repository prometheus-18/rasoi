# रसोई (Rasoi)

Voice grocery ordering for the household cook: hold-to-talk Hindi/Hinglish → Gemini parses the list →
Swiggy Instamart official MCP builds the cart → owner approves on Telegram → order placed on the owner's
account. Runs free on Vercel Hobby (`bom1`) + Neon Postgres. Full plan: `docs/PLAN.md`.

## Safety model (do not weaken)

- `checkout` is called **only** from `lib/orders/checkout.ts`, **exactly once** per order
  (unique idempotency key), **never retried**. A timeout → state `unknown`, which blocks all
  new orders until reconciled via `get_orders` or the owner's `/resolve`.
- Two gates before any real order: `DRY_RUN` (DB flag, default ON, turned off only via a
  Telegram confirm tap) and `ALLOW_REAL_ORDERS=true` (env, honored **only** in the Vercel
  Production environment, re-checked inside the Swiggy adapter).
- The LLM (Gemini) receives only audio + a glossary. It never calls Swiggy tools and never
  sees the address, phone number or token. Every rule lives in `lib/orders/policy.ts` (server code).
- Swiggy adapter tool **allowlist** (12 tools); `create_address`/`delete_address` are not callable.
- Swiggy access token stored AES-256-GCM encrypted (`TOKEN_ENC_KEY`, versioned).

## Dev

```bash
npm install
npm run dev        # reads .env.local; without keys = demo mode (mock catalog, in-memory store)
npm test           # policy / engine / checkout-never-retried / rules-parser proofs
npm run build
npx tsx scripts/setup-telegram.ts            # find OWNER_CHAT_ID after tapping Start on the bot
npx tsx scripts/setup-telegram.ts --webhook  # point the bot at $APP_URL/api/telegram
```

With no `DATABASE_URL` the app runs in **demo mode**: auto-paired device, mock products,
checkout hard-blocked. Voice is REAL as soon as `GEMINI_API_KEY` (and/or `GROQ_API_KEY`) is set —
even in demo mode. Voice paths, in order: Gemini audio → Groq Whisper + Gemini text → Groq Whisper +
deterministic Hinglish rules parser (`lib/voice/rules.ts`). Set the remaining env vars
(see `.env.example`) to go real, then `npm run db:push` to create the schema.

## Connecting Swiggy Instamart

1. Deploy (or `npm run dev`) with `DATABASE_URL` + `TOKEN_ENC_KEY` set — the token is stored encrypted in the DB.
2. Open `/admin` (Telegram `/admin` link, or `/api/admin/session` with `ADMIN_SETUP_KEY` during setup).
3. "Swiggy login" card → open the login link **in Chrome** → phone + OTP → Chrome shows
   "localhost — site can't be reached" (expected) → copy the full address-bar URL → paste into the
   card (or into the Telegram bot chat) within 2 minutes.
4. The "Delivery address" card now lists your saved Swiggy addresses → copy the home address id
   into `PINNED_ADDRESS_ID` (Vercel: Production + Sensitive) → redeploy.
5. The token lasts 5 days; the bot reminds you (<48 h) with a fresh login link. Until Swiggy
   allowlists the Vercel callback URL this paste-back flow is the only way in.

## Setup order (owner)

1. `docs/PHASE0-CHECKLIST.md` — Telegram bot, Gemini key (`rasoi-prod` project), Swiggy Money top-up.
2. Vercel project + Neon Postgres (Singapore) → set env vars (Production, Sensitive) → redeploy.
3. `npm run db:push` once with `DATABASE_URL` set (or run it locally against Neon).
4. Set the Telegram webhook (replace `<TOKEN>`, `<SECRET>`, `<APP>`):
   `https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<APP>/api/telegram&secret_token=<SECRET>&drop_pending_updates=true`
5. Bot: `/login` → Swiggy paste-back login. `/pair` → code for the cook's phone → `<APP>/pair`.
6. `<APP>/check` on the cook's phone; then the supervised week (every order approved), DRY_RUN off
   only after the Phase 0 spike + one real ₹100–150 test order.

## Incident runbook

Something looks wrong (unknown orders, strange approvals, suspected leak):

1. Telegram `/pause` — blocks all checkouts immediately.
2. Delete the Swiggy login: `/admin` → or SQL `DELETE FROM swiggy_auth;` — no order can be placed without it.
3. Rotate `TOKEN_ENC_KEY` (new `v2:` key) and the Neon password; redeploy.
4. Check Swiggy app: Account → Addresses (unchanged?) and Orders (anything unexpected?).
5. Unexpected orders: call Swiggy care 080-67466729 (orders cannot be cancelled via MCP).
6. Re-pair the cook's phone (`/devices` → revoke, `/pair` → new code).
