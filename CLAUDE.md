# rasoi

Voice grocery ordering for the household cook: hold-to-talk Hindi/Hinglish → Gemini parses the list →
Swiggy Instamart official MCP builds the cart and places the order on the owner's account → Telegram
alerts/approvals for the owner. Runs on Vercel Hobby (free). See docs/PLAN.md for the full approved plan.

## Rules
- Everything stays on D: (this folder). No files on C:.
- Real orders are irreversible and there is no Swiggy sandbox. `checkout` is called only from
  `lib/orders/checkout.ts`, never retried, and gated by DRY_RUN (DB) + ALLOW_REAL_ORDERS (env, Production only).
- The LLM never calls Swiggy tools and never sees the address, phone number or token.
- Every safety rule lives in server code (lib/orders/policy.ts), not in prompts or the UI.
- Never commit secrets or eval audio clips (see .gitignore). Swiggy token is stored AES-256-GCM encrypted.
- Owner-facing text: English. Cook-facing text: colloquial Hindi (Devanagari), digits 0-9, big tap targets.

## Setup notes
- Created 2026-09-27. Node 24, npm 11. Package manager: npm.
- Local AI gateway: OmniRoute at http://localhost:20128 (`omni-status`, `claude-omni`). Do NOT use the
  OmniRoute Gemini key for this app — Rasoi uses its own Google Cloud project `rasoi-prod`.
