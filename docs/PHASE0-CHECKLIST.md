# Phase 0 checklist — things only the owner can do

Everything here is free. Do them in order; each takes 2–10 minutes.

## 1. Telegram bot (owner alerts + approvals)
1. Install Telegram on your phone (if not already). Open **@BotFather** → send `/newbot`.
2. Name: `Rasoi`, username: something ending in `bot` (e.g. `rasoi_home_bot`).
3. BotFather replies with a **token** like `123456789:AAH...`. Keep it — this is `TELEGRAM_BOT_TOKEN`.
4. Open your new bot (link BotFather gives you) and tap **Start** (bots cannot message you first).
5. Optional: BotFather → `/setjoingroups` → Disable.

## 2. Gemini key in its OWN Google Cloud project (voice → list)
Quota is per Google Cloud project, not per key. This must not share the project used by OmniRoute / DIY-Alexa.
1. Go to https://console.cloud.google.com/projectcreate → name `rasoi-prod` → Create.
2. Go to https://aistudio.google.com/apikey → **Create API key** → choose project **rasoi-prod** → copy the key.
   This is `GEMINI_API_KEY`. (No billing needed for the free tier.)
3. Free-tier limits for that project: https://aistudio.google.com/rate-limit (sign in).
4. Optional later: a second project `rasoi-dev` for testing so tests never eat the cook's daily quota.

## 3. Swiggy account
1. Open the Swiggy app → **Account → Swiggy Money**. Confirm you see a balance / top-up option.
2. Top up **~₹300** (this becomes the test-order money and, later, the weekly cap).
3. Make sure the **home address** is saved in the app with the correct flat/landmark.
4. Empty your Instamart cart in the app before running the spike (the spike replaces the cart).

## 4. Run the Swiggy spike (on this laptop, read-only)
```powershell
cd D:\projects\rasoi
npx tsx scripts/spike-swiggy.ts --save-token
```
- A browser opens → Swiggy login with your phone + OTP → page says "login received".
- Pick the HOME address when asked. Type `yes` if it asks about replacing the cart.
- It prints: tools count, addresses, your usual items, an "onion" search, cart total, **payment options
  (look for `swiggyMoney.available: true` and `cod.available`)**, whether `clear_cart` works, and which
  `get_orders` type returns Instamart orders. Results are saved in `spike-results\` (gitignored).
- Paste the console summary into the chat.

If the browser login page says the redirect is not allowed, run instead:
```powershell
npx tsx scripts/spike-swiggy.ts --save-token --redirect=paste
```
(login in the browser → it lands on a "site can't be reached" page → copy the address bar → paste into the terminal within 2 minutes).

## 5. The one real test order (~₹100–150, only after step 4 looks good)
```powershell
$env:SPIKE_ALLOW_CHECKOUT = "yes"
npx tsx scripts/spike-swiggy.ts --place-order --pay=SwiggyPay --query=onion
```
It shows the cart and total, then asks you to type `PLACE ORDER`. This is a REAL order and cannot be cancelled.
It then records how fast the order appears in `get_orders` and whether the cart empties.

## 6. Voice spike (WhatsApp voice notes)
1. Ask the cook to send 10–20 WhatsApp voice notes with typical grocery lists (in the kitchen, normal noise).
2. In WhatsApp, long-press each note → Share/Export → save to `D:\projects\rasoi\eval\clips\` (they are `.opus`).
3. Run:
```powershell
$env:GEMINI_API_KEY = "<key from step 2>"
npx tsx scripts/spike-voice.ts eval\clips
```
It prints the transcript and the parsed items per clip. Tell me which items/quantities were wrong.

## 7. Vercel + Neon (hosting; needed from Phase 1)
1. https://vercel.com → your existing account → later I will link the GitHub repo `prometheus-18/rasoi`.
2. In the Vercel project → **Storage → Create → Neon Postgres** → region **Singapore (aws-ap-southeast-1)** → free plan.
   (I will guide this when we deploy.)

## 8. Cook's phone (5 minutes, with the cook)
- Which phone / Android version? Is Chrome installed? Does it have a Hindi voice for text-to-speech
  (Settings → Accessibility → Text-to-speech → Google → language Hindi)? Tell me the model.
