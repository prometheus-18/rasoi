# Rasoi — voice grocery ordering for the cook (final plan)

## Context

Every day the cook asks us to order vegetables/ingredients, so we are always in the loop. Goal: the cook opens an
app on his phone, **holds a button and speaks Hindi/Hinglish** ("pyaz ek kilo, do packet dahi, dhaniya"), sees the
list with photos and prices, confirms, and the order is placed on **Swiggy Instamart** from the owner's own account,
paid from **Swiggy Money wallet** (Cash on Delivery if wallet can't be used), delivered to the saved home address.
Owner gets a Telegram message for every order and taps Approve for anything above the limits. Budget ₹0/month.
Delhi NCR. Repo private on GitHub (`prometheus-18`), everything on D: drive.

### Research summary (verified 2026-09-27; 18 research + 6 fact-check + 3 review agents)

| Question | Answer |
|---|---|
| Best quick-commerce MCP | **Swiggy Instamart official MCP** `https://mcp.swiggy.com/im` (search, cart, checkout, tracking). Payment: **SwiggyPay** (Swiggy Money wallet, debits instantly), COD, UPI. |
| Fallback | **Zepto official MCP** (`mcp.zepto.co.in/mcp`, Zepto Cash, working refresh tokens) — thinner docs, 17-day outage Aug 2026. Same adapter interface → config switch. |
| Blinkit / BigBasket / others | No official MCP (Blinkit unofficial ones break ToS). BigBasket has an undocumented MCP — maybe later. |
| Wi-Fi router / Airtel TV box as server | **Not possible.** Router is Airtel-locked; IPTV box blocks all app installs since 2025 and sleeps its network. |
| Free 24/7 host | **Vercel Hobby** (you already have it) — free, always on, HTTPS built in (phone browser needs HTTPS for the mic). |
| Speech-to-text (Hindi) | **Gemini Flash-Lite** free tier: audio in → JSON item list out in one call. Free fallback Groq Whisper. Meta's "300 ms" model (Muse Voice Transcribe) is paid/closed, no Hindi accuracy data → not used. Upgrade: Sarvam Saaras v4 (best Indic benchmarks, ~₹75/mo after ₹100 credit). |
| Claude as the brain? | No. Claude Pro is not an API key and Anthropic's terms forbid using it to power an app. Gemini free is enough. |
| Owner alerts | **Telegram bot** (free, buttons, works anywhere) + Web Push backup. SMS to Indian numbers is not free for apps (TRAI DLT rules, trials only, no free reply path). |
| Cook's app | **PWA** — a webpage installed to the home screen from Chrome; looks/works like an app, auto-updates, no APK/Play Store. APK later only if needed. |

### Swiggy facts that shape the design (official docs)
- Login = phone + OTP in browser (OAuth 2.1 + PKCE + dynamic client registration). **Access token 5 days, no refresh
  token yet**; session 30 days sliding → re-login every ≤5 days, usually silent (no OTP). Auth code valid 120 s.
- Redirect allowlist is exact-match (`http://localhost/callback` etc.). Vercel URL needs Swiggy approval (builders@swiggy.in)
  → **paste-back login** until approved.
- **Orders cannot be cancelled** via MCP (customer care 080-67466729). **No sandbox** — every test order is real.
- `checkout` not idempotent, takes only `addressId` + `paymentMethod`, orders **whatever is in the live cart**. Cart is
  **one per account, shared with your Swiggy app**; `update_cart` replaces it. Multi-store carts → several orders, can partly fail.
- SwiggyPay appears only when `get_payment_options` offers it; no balance API; low balance → checkout fails, nothing charged.
- `get_orders` default `orderType` is "DASH" — exact Instamart value found in Phase 0. Min order ₹99. 70 req/min.
- Swiggy: "one MCP session per user, not per request" → persist `Mcp-Session-Id`. Discovery metadata broken → hard-code
  `https://mcp.swiggy.com/auth/{register,authorize,token}`. Live server serves 16 of 19 documented tools → code against `tools/list`.
- `create_address`/`delete_address` exist → adapter tool **allowlist** blocks them. Policy grey zone (personal use of
  localhost path) → also apply to Builders Club.

## Decisions (confirmed with you)
Host Vercel Hobby (`bom1`) · your own Swiggy account · SwiggyPay → auto-COD fallback (with the safety rules below) ·
Telegram bot · paste-back login + apply to Swiggy · cook self-confirms within limits, owner approves above · PWA.

## Architecture

```
 Cook's phone — Chrome PWA (Hindi, photos, big buttons)        Owner's phone — Telegram
        │ HTTPS (home Wi-Fi or mobile data)                           ▲ alerts / Approve / login link
        ▼                                                             │
 ┌──────────────── Vercel Hobby (free, 24/7, region bom1) — Next.js "rasoi" ────────────────┐
 │ Cook UI    /  /list/[id]  /status/[id]  /pair  /check                                     │
 │ Owner UI   /admin (only via one-time link from the bot)                                   │
 │ API        /api/voice · /api/draft/[id]/{match,cart,confirm,checkout,status} ·           │
 │            /api/swiggy/{login,paste} · /api/telegram (webhook) · /api/cron/{daily,tick}   │
 │ Engine     order state machine + policy (all safety in code; LLM never touches Swiggy)    │
 └────────┬──────────────────┬───────────────────────┬────────────────────┬─────────────────┘
          ▼                  ▼                       ▼                    ▼
   Gemini API          Swiggy Instamart MCP     Neon Postgres (free,   Telegram Bot API
   (free key, own      mcp.swiggy.com/im        Singapore region)      + optional cron-job.org
   GCP project)        your account, token      tokens(encrypted),     pinger every 30 min
   audio → JSON        encrypted in DB          drafts, orders, audit
```
Laptop = development + Phase 0 only. Wi-Fi = just the road; the app lives on Vercel. Adding a phone = pair it (but
only **one draft at a time** can touch the shared cart — enforced by a lock).

## One order, end to end
1. Mic pressed → `GET /api/warm` (wakes function + DB, caches `your_go_to_items` for the day) while cook talks.
   Phone records WebM/Opus (noise suppression, ~32 kbps, ≤60 s), `POST /api/voice` (raw bytes to route handler).
2. **Gemini Flash-Lite** (audio + JSON schema + household glossary) → `{transcript, items:[{name_hi, search_en, qty,
   unit, confidence, needs_clarification}]}`. Code normalises Hindi quantities (aadha 0.5, paav 250 g, sawa/dedh/dhai/
   saadhe/paune, "dhai sau" 250, darjan 12, gaddi bunch). Response returns immediately → phone shows Devanagari names.
3. Match (streams to phone): `pantry_map` cache hit (spoken name → SKU) → else rank `your_go_to_items` → else
   `search_products` (4 in parallel, one MCP session). Ambiguous items → one batched Gemini text call returns
   **candidate indexes only**; code validates. Policy runs on every candidate before display.
4. Draft takes the **cart lease** → `update_cart(pinned address, items)` (response includes live cart, out-of-stock
   removals, quantity reductions) → `get_payment_options` → phone shows **one list screen** (S3): photo, Hindi name,
   pack, ₹, − qty +, "?" alternatives, "नहीं मिला" rows, live total incl. fees, **real payment method** (wallet icon or big
   "₹412 नकद देना है"), multi-store warning. Edits by tap or voice (debounced 800 ms cart sync).
5. Big green button → bottom sheet (photos, total, payment) → **hold 1.5 s to confirm** → optional 15 s "रद्द करें"
   countdown. Policy check: within limits → continue; else → Telegram Approve/Reject (cook sees "मालिक से पूछ रहे हैं",
   can cancel; cart cleared while waiting, snapshot kept).
6. `POST checkout` = one atomic CAS `UPDATE … SET state='placing' WHERE state IN (…) AND NOT paused AND
   spend+total ≤ limits RETURNING`; returns 202; work runs in `after()`; phone polls status.
7. In that run, holding the lease: `update_cart(snapshot)` → `get_cart` → **exact item set, toPay ≤ approved,
   selectedAddress == PINNED** → `checkout(addressId, paymentMethod)` **exactly once, never retried**.
8. Outcome: placed / partially_placed / **not placed** (only on pre-send error, 400/401/419, or 200 `success:false`) /
   **unknown** (timeout, 5xx, parse error → block all new checkouts, reconcile via `get_orders` at 3/10/30/120 s
   matching time+items+total, else ask owner `/resolve`). Success message shown verbatim + Hindi; Telegram alert
   (items, total, method, fees, budget left). `get_order_details` compared to snapshot → red alert on mismatch.
9. Status screen polls server-cached `track_order` every 30–60 s while visible; Hindi TTS on changes.

## Safety and security (all in server code)
- **LLM boundaries**: never calls Swiggy, never sees address/phone/token; outputs only item list / candidate index.
- **Route auth table**: cook routes = HttpOnly device cookie (SHA-256 in DB) + draft ownership check + Origin check;
  owner routes (`/admin`, `/api/swiggy/*`) = 12 h session cookie minted only from a one-time 10-min link sent by the
  bot on `/admin`; `/api/telegram` = `X-Telegram-Bot-Api-Secret-Token` (constant-time) + `from.id`==OWNER + `update_id`
  dedupe table; `/api/cron/*` = `CRON_SECRET` bearer. UUID ids everywhere.
- **Telegram**: reply 200 within 1 s, work in `after()`; callback_data = `approve:<draft>:<version>:<exp>:<HMAC>`,
  single-use via CAS; expiry checked lazily (60 min); plain-text messages (no parse_mode); only the fixed login message carries a link.
- **Safety-lowering admin actions** (DRY_RUN off, raise limits, resume, pair device, end supervised week) need a Telegram Approve tap.
- **Locks on Neon**: neon-http has no transactions → every transition is a single conditional `UPDATE … RETURNING`;
  `orders.idempotency_key = draftId+cartHash` UNIQUE; global `commerce_lock` row (one draft at a time from cart_synced→placed);
  any `placing`/`unknown`/`partially_placed` row blocks new checkouts and **counts as spent**.
- **Payment**: method chosen only from `get_payment_options` *before* confirm; adapter asserts ∈ {SwiggyPay, COD}, never
  UPI, never omitted. After a SwiggyPay error: **COD only if** the failure was definite (200 `success:false` payment
  message) AND `get_orders` shows no order AND cart unchanged AND `cod` offered → one COD checkout, cook told
  "कैश तैयार रखें ₹X" (screen + voice). Otherwise → unknown flow / "wallet low — top up, tap Retry" to owner.
- **Limits** (IST windows, `toPay` incl. fees; editable via bot): ₹1000/order, ₹1500/day, ₹5000/week, 3 orders/day,
  ≤5 units or 5 kg per item; COD ₹600/order & 1/day; line total > ₹400 → approval; product never ordered before and
  > ₹150 → approval; keyword blocklist (coin, gold, silver, gift card, voucher, phone, charger, cigarette, beer…);
  ordering hours 06:00–21:30 IST (outside → approval). Over limit = ask owner, **never clamp silently**.
- **Address**: `PINNED_ADDRESS_ID` + fingerprint (pincode, rounded lat/lng, label) in Production env, verified before every checkout.
- **Tool allowlist**: search_products, your_go_to_items, get_addresses, update_cart, clear_cart, get_cart,
  get_payment_options, checkout, get_orders, get_order_details, track_order, get_delivery_status. Nothing else callable.
- **Cart hygiene**: clear before awaiting_approval / on abandon / after every DRY_RUN; rebuild from snapshot on approval;
  clear first if cart's selected address ≠ pinned. (Phase 0 checks whether `clear_cart` works — issue #58.)
- **Env scoping**: secrets Production-only + Sensitive; `ALLOW_REAL_ORDERS=true` only in Production, checked inside the
  adapter; preview/dev always dry; Neon preview branching off; no `vercel env pull`; AES-256-GCM token key versioned.
- **Device/PIN**: QR/code = one-time 10-min pairing code → device cookie; PIN (peppered HMAC) at pairing and once per
  12 h, not per order; atomic fail counter, 5 fails → locked until owner `/unlock` (alert at 3); per-device rate limit
  30 voice / 10 confirms per day; `/devices` list + revoke; "new device paired" alert.
- **Audit log**: append-only (DB role without UPDATE/DELETE), hash chain, PII stripped, transcripts purged after 90 days,
  audio never stored after parsing. Telegram history = external copy.
- **Retry policy**: reads/tracking ≤5 with backoff (honour Retry-After); cart tools ≤2; **checkout 0** (bypasses the
  wrapper; unit test proves a 504 never re-calls). `swiggy-errors.ts` maps status+message → AUTH/419/RATE_LIMIT/MIN_ORDER/
  UNSERVICEABLE/CART_EXPIRED/OOS/PAYMENT_DECLINED/TRANSIENT/UNKNOWN from real messages captured in Phase 0.
- **Incident runbook** (in README): `/pause` → delete `swiggy_auth` row → rotate AES key + DB password → check addresses/
  orders in Swiggy app → call Swiggy care → re-pair devices.

## Never a dead end for the cook (failure table, Hindi text + same spoken)
| Situation | Cook sees | System does |
|---|---|---|
| Swiggy login expired / Swiggy down / Gemini quota out | "मालिक को भेज दिया ✓" | Draft saved; transcript + list + audio link → owner Telegram; "Resume" button after re-login |
| Order status unknown | "ऑर्डर शायद हो गया — दोबारा मत करना" | New orders blocked; reconcile; owner `/resolve` |
| Part of split order failed | "ये आ रहा है… / ये नहीं आया…" + "बाकी फिर से मंगाओ" | New draft with failed items only; placed lines never re-added |
| Store closed / not serviceable | "दुकान अभी बंद है, बाद में ↻" | Draft kept |
| Under ₹99 | "₹99 से कम — और सामान जोड़ें" + usual-item chips | — |
| Cart expired | silent re-sync; re-confirm only if total moved > ₹10 / 3 % | — |
| Paused by owner / rejected / expired approval | reason + "बदलकर फिर पूछें" | — |
| Wallet failed → COD | "कैश तैयार रखें ₹X" | COD rules above |
| Gemini 429/503 | retry → fallback model → "टैप करके चुनें" (chips) → send to owner | — |

## Voice (STT) — primary + fallback
- Primary: **Gemini 3.5 Flash-Lite** (fallback model **3.1 Flash-Lite**, separate quota) via a key in a **new Google
  Cloud project `rasoi-prod`** (quota is per project, not per key — must not share the OmniRoute project); `rasoi-dev`
  project for eval. Pin exact model ids, never `-latest`. Free-tier day quota resets 12:30 PM IST (1:30 PM winter).
- Consent: explain to the cook in Hindi that his voice goes to Google (free tier may be human-reviewed); one-line
  notice on pairing screen. Option: enable billing on `rasoi-prod` (paid tier = no training use; few paise/month).
- Upgrade path if kitchen accuracy < 90 %: Sarvam Saaras v4 (`codemix` mode, keyterms = household items; ₹100 free credit).
- **Meta "300 ms" model — checked, does not change the pick.** It is **Meta Muse Voice Transcribe** (released
  2026-09-01; ~0.16 s streaming latency, 3.1 % English WER, Hindi + code-switching supported, but no Hindi accuracy
  published, one anecdotal Hinglish test was poor). It is **closed, API-only, paid ($0.18/hour, no free tier
  documented), India sign-up unconfirmed, text-only output** (would still need a 2nd LLM call for the JSON list).
  Meta's open-weights model (Omnilingual ASR, Nov 2025) needs a GPU nobody hosts free and scores worse than Gemini
  on Hindi (13.7 % vs 8.3 % WER on the Voice of India benchmark). → Gemini stays primary.
- **Free fallback**: **Groq `whisper-large-v3`** (`language=hi`, grocery-term prompt; free 2,000 req/day, no card)
  → text → Gemini Flash-Lite text call for the JSON. Third: Gemini 3.5 Transcribe (same key) or Cloudflare Workers AI whisper-turbo.
- **Key setup (India, no card):**
  - Gemini: https://aistudio.google.com/apikey → sign in → **first create a new Google Cloud project `rasoi-prod`**
    → Create API key in that project → `GEMINI_API_KEY`. Limits visible at aistudio.google.com/rate-limit.
  - Groq: https://console.groq.com → sign up (Google/email) → API Keys → Create → `GROQ_API_KEY`.
  - Sarvam (optional): https://dashboard.sarvam.ai → sign up → ₹100 credit auto → API Keys → `SARVAM_API_KEY`
    (`POST https://api.sarvam.ai/speech-to-text`, `model=saaras:v4`, `mode=codemix`).

## Owner channel
- **Telegram bot** (BotFather → token; owner `/start` → chat_id; `setWebhook` with `secret_token`). Commands: `/pause`,
  `/resume`, `/orders`, `/budget`, `/login`, `/limits`, `/devices`, `/unlock`, `/resolve`, `/dryrun`. Inline buttons: Approve/Reject,
  Retry (COD), Placed/Not placed, Revoke device.
- Login link: one stable `https://<app>/api/swiggy/login` (fresh PKCE per tap, several valid at once, 15 min). Owner opens
  it **in Chrome** (Telegram → Settings → Chat Settings → In-App Browser OFF, once). Chrome error page → ⋮ Share → Copy
  link → paste to bot (accepts full URL or just code; regex tolerant). Reminders: daily cron (08:00 IST) when < 48 h
  left + lazy reminder on any request when < 24 h (throttle 6 h) + optional cron-job.org pinger every 30 min → `/api/cron/tick`.
- **SMS — checked, not free in India**: Twilio trial = 100 SMS / 30 days only; Fast2SMS ₹50 credit then ₹5/SMS;
  Textbelt 1/day; every domestic route needs TRAI DLT registration (business entity + KYC); no free inbound number,
  so Approve/Reject by SMS reply is impossible. Airtel/Jio email-to-SMS gateways are dead. WhatsApp Cloud API needs
  Meta business setup + template approval, ~₹0.115/message. → **Telegram primary** (free, unlimited, buttons).
- **Fallback channel: Web Push** from the same PWA installed on *your* phone (VAPID, free, no third party; action
  buttons Approve/Reject; `urgency:'high'`). Android Doze can delay it, so it is the backup, not the primary.
  Approve/Reject messages also carry signed `url` buttons (`/approve?t=…`) that work even if the webhook is down.
- Telegram setup (Phase 0): @BotFather `/newbot` → token → `TELEGRAM_BOT_TOKEN`; you tap **Start** on the bot
  (bots cannot message first); `getUpdates` once → `OWNER_CHAT_ID`; `openssl rand -hex 32` → `TELEGRAM_WEBHOOK_SECRET`;
  `setWebhook {url, secret_token, allowed_updates:[message,callback_query], drop_pending_updates:true}`; handler must
  `answerCallbackQuery` and edit the message after a tap. Limits 1 msg/s per chat — fine.

## MVP screens (Hindi, photos, digits, audio on every screen)
```
 ┌─────────────────────────┐  ┌──────────────────────────────┐  ┌─────────────────────────┐
 │ रसोई           🔊 मदद   │  │ आपकी लिस्ट     कुल ₹412  🔊  │  │ ✓ ऑर्डर हो गया     🔊    │
 │                         │  │ [🧅] प्याज़  Onion 1 kg      │  │ Swiggy: "Order placed…" │
 │        ( 🎤 )           │  │      ₹38     − 1 +   🗑  🔊  │  │ 🛵 रास्ते में  ~14 मिनट   │
 │  दबाकर बोलिए / टैप करें  │  │ [🥛] दही Amul Masti 400 g   │  │ [💵 कैश ₹412 तैयार रखें] │
 │                         │  │      ₹35     − 2 +   🗑  🔊  │  │                         │
 │ रोज़ का सामान [🧅][🍅][🥛]│  │ [🌿] धनिया ? [100g] [250g]  │  │ [🏠 वापस]               │
 │ पिछले ऑर्डर  कल ₹380     │  │ [❌] हींग — नहीं मिला        │  └─────────────────────────┘
 │ ⚠ बैनर (offline/login) │  │ 💳 Swiggy Money  🏪 1 दुकान   │      S5 Status
 └─────────────────────────┘  │ [🎤 और बोलें] [✅ ऑर्डर करो →] │
   S1 Home                    └──────────────────────────────┘
                                S3 List + confirm sheet (hold 1.5 s)
```
S0 pairing (owner on cook's phone: open in **Chrome**, "Allow on every visit" for mic, Add to Home screen, PIN,
`storage.persist()`, Hindi TTS check), S2 listening ("सुन रहे हैं…" + level ring), S6 reorder (loads into S3, never
auto-orders). `/check` page: MediaRecorder→Gemini round trip, hi-IN voice present, wake lock, standalone mode, browser.
Hold-to-talk spec: hybrid (hold > 600 ms = release sends; tap = start, "भेजो" = stop), `touch-action:none`,
`setPointerCapture`, pointercancel = send, cue after `onstart` + vibrate, min 0.8 s, Screen Wake Lock, blob in `onstop`.
TTS: `lang='hi-IN'` always, wait `voiceschanged`, ~15 pre-recorded MP3 prompts cached by service worker; TTS is comfort, not a safety control.
Latency budget: names ≤ 5 s, priced list ≤ 10 s p90; per-stage timings in audit log.

## Tech stack
Next.js App Router + TypeScript + Tailwind, PWA (manifest + SW: skipWaiting/clients.claim, never cache `/api`) ·
`@modelcontextprotocol/sdk` client, Streamable HTTP, own OAuth (hard-coded endpoints), **persisted session id**, cached
`tools/list` (daily), 15–20 s abort per call, 45 s route budget · `@google/genai` · Neon Postgres (**aws-ap-southeast-1**,
autoscale cap 0.5 CU, no pingers to DB routes) + Drizzle (neon-http; CAS statements) · Telegram via `fetch` · `zod` ·
Vitest · `vercel.json` `regions:["bom1"]`, `maxDuration` 300 on checkout route.

## Project layout — `D:\projects\rasoi`
```
app/                 page (S1), list/[id], status/[id], pair, check, admin
app/api/             voice, warm, draft/[id]/{match,cart,confirm,checkout,status}, swiggy/{login,paste},
                     telegram, cron/{daily,tick}
lib/commerce/        provider.ts (interface) · swiggy.ts (adapter + tool allowlist + session persistence) ·
                     swiggy-auth.ts (DCR, PKCE, paste-back, AES token store) · swiggy-errors.ts · zepto.ts (later)
lib/voice/           gemini.ts (audio→JSON, model fallback) · units.ts · glossary.ts
lib/orders/          engine.ts (state machine, CAS transitions, reconciler) · policy.ts (limits, approval rules) ·
                     checkout.ts (pre-flight, outcome classification, no-retry)
lib/notify/telegram.ts   lib/auth/{device,owner,pin}.ts   lib/crypto.ts
lib/db/schema.ts     settings, swiggy_auth, devices, drafts, orders, order_stores, commerce_lock,
                     processed_updates, audit_log, pantry_map
scripts/spike-swiggy.ts  scripts/spike-voice.ts      eval/{clips (gitignored), run.ts}      tests/
```
State machine: recorded → parsed → matched → cart_synced → awaiting_confirm → (awaiting_approval → approved |
approved_waiting_login) → placing_swiggypay → (placing_cod) → placed | partially_placed | not_placed | unknown;
plus superseded, expired, rejected. Every transition = one conditional UPDATE; reconciler runs on any event.

## Build phases (value first)

**Phase 0 — Setup + gate (no app code yet)**
- Repo: `new-project rasoi` → `D:\projects\rasoi`, `gh repo create prometheus-18/rasoi --private`, push.
- You: Telegram + BotFather bot; Google Cloud project `rasoi-prod` + AI Studio key; check Swiggy app shows Swiggy
  Money (top up ~₹300); Vercel project + Neon (Singapore).
- `spike-swiggy.ts` on laptop (localhost login, token in memory only; **never calls checkout except the one agreed
  ₹100–150 SwiggyPay order with you watching**): `tools/list`, `get_addresses` (pin + fingerprint), `your_go_to_items`,
  `search_products`, `update_cart`/`get_cart`/`clear_cart` (does clear work? cart TTL?), `get_payment_options` (SwiggyPay?
  COD offered on Instamart?), cap check via cart warnings only, `get_orders` orderType that returns the test order and how
  fast, raw checkout response saved, does a 2nd login revoke the 1st token. Warn: spike wipes your app cart.
- Paste-back tested on **your phone** from a Telegram message, twice. Token used from a Vercel `bom1` function
  hourly for 48 h (pinger) — no 403/HTML.
- `spike-voice.ts`: 10–20 of the cook's existing WhatsApp voice notes through the Gemini prompt → accuracy read.
- `/check` page on the **cook's phone**. Gate: usable payment + custom client works + voice ≥ ~90 % → go.

**Phase 1 — Supervised MVP (first week of real use)**: Neon schema, token store, Swiggy adapter (allowlist, session
persistence, error mapper, no-retry checkout), minimal bot (secret, paste-back, Approve/Reject, forward-on-failure,
/pause), cook PWA S0/S1/S2/S3/S5 + hold-to-talk + TTS, engine with CAS + lock + reconciler + outcome classification.
**Every order needs owner Approve.** DRY_RUN + ALLOW_REAL_ORDERS gates. Deploy `bom1`, pair cook's phone.

**Phase 2 — Self-confirm within limits**: policy engine (limits, IST windows, COD rules, never-ordered rule, hours),
confirm sheet + undo countdown, S6 reorder, `/limits /budget /devices /unlock /resolve`, `/admin` via signed link,
lazy reminders + cron-job.org tick, audit hardening. Email builders@swiggy.in (allowlist Vercel callback).

**Phase 3 — Learning + polish**: pantry_map auto-learning (spoken name → SKU, usual qty), "और कुछ चाहिए?" prompt,
weekly spend report, Sarvam STT if needed, one-tap login once allowlisted.

**Phase 4 — Later**: Zepto adapter, "aaj rajma banana hai" → ingredient suggestions, second cook/device, price alerts.

## Cost
₹0/month (Vercel Hobby, Neon free, Gemini free, Telegram, cron-job.org). Optional: Gemini billing for privacy
(few paise/mo), Sarvam (~₹20/mo).

## Top risks
| Risk | Mitigation |
|---|---|
| Swiggy closes custom-client path | Builders Club application; Zepto adapter behind same interface; forward-to-owner fallback keeps household running |
| Duplicate non-cancellable order | CAS transitions, global lock, checkout 0-retry, unknown-state block, `get_orders` reconciliation, owner `/resolve` |
| Wrong items ordered | Photos + Hindi names + live cart total + hold-to-confirm + undo countdown + supervised week + per-item limits |
| Owner's app clashes with cook's cart | Cart cleared while waiting; rebuild + exact-match check right before checkout; owner told not to checkout from app during a cook order |
| 5-day login lapses | cron + lazy reminders + pinger; expired → list forwarded to owner, never a dead end |
| Public URL abuse | Auth on every route, secret webhook, device cookies, rate limits, Production-only secrets, wallet top-up as final cap |

## Verification
- Unit (Vitest, fake provider): unit normaliser; policy (limits, IST windows, COD rules, never-ordered, hours); engine
  (double tap, two devices, late Approve, forged/replayed Telegram update, 504 on checkout → unknown & no 2nd call,
  partial multi-store, cart changed, token expired mid-approval, preview env stays dry).
- Voice eval: `eval/run.ts` on 20–30 real kitchen clips → items+qty ≥ 90 %; latency log ≤ 10 s p90.
- Swiggy: Phase 0 spike checklist; DRY_RUN full flow; one real ₹100–150 SwiggyPay order; COD path in DRY_RUN;
  forced 401 → reminder + cook message; 48 h token-from-Vercel test.
- Telegram: approve/reject, expiry, /pause blocks checkout, paste-back from phone, forwarded audio playable.
- Phone: PWA installed in Chrome, mic "every visit", Hindi TTS plays, pairing + PIN + lockout/unlock, offline banner.
- Go-live: supervised week (all orders approved); audit log matches Swiggy order history; then limits mode.
