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
npm run dev        # demo mode without env vars: mock catalog, in-memory store, no real anything
npm test           # policy / engine / checkout-never-retried proofs
npm run build
```

With no `DATABASE_URL` the app runs in **demo mode**: auto-paired device, mock products,
canned voice parse if `GEMINI_API_KEY` is missing, checkout hard-blocked. Set env vars
(see `.env.example`) to go real, then `npm run db:push` to create the schema.

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
