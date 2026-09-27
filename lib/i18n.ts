// Cook-facing strings in Hindi (default) and English. Shared by server routes (they return
// { hi, en }) and client components (they pick by the language toggle). Pure data, no "use client".

export type Lang = "hi" | "en";
export type Msg = { hi: string; en: string };

const m = (hi: string, en: string): Msg => ({ hi, en });

/** Messages the server attaches to responses / stores as draft.error keys. */
export const MSG = {
  // voice
  rate_limited_voice: m("आज के लिए बहुत हो गया — कल फिर बोलें", "That's enough for today — try again tomorrow"),
  too_long: m("बहुत लंबा हो गया — छोटा बोलें", "Too long — keep it shorter"),
  nothing_heard: m("कुछ सुनाई नहीं दिया — फिर से बोलें", "Nothing was heard — please speak again"),
  no_items: m("सामान समझ नहीं आया — फिर से बोलें", "Couldn't make out the items — please speak again"),
  quota_out: m("आज की सुनने की सीमा खत्म — मालिक को बता दिया", "Voice limit for today is over — the owner has been told"),
  parse_failed: m("समझ नहीं आया — फिर से बोलें (मालिक को बता दिया)", "Couldn't understand — speak again (the owner has been told)"),
  // match / cart
  forwarded: m("मालिक को भेज दिया ✓ — वो मंगा देंगे", "Sent to the owner ✓ — they will order it"),
  nothing_chosen: m("कुछ भी चुना नहीं है", "Nothing selected"),
  busy: m("कोई और ऑर्डर चल रहा है — थोड़ी देर रुकें", "Another order is in progress — please wait"),
  list_locked: m("लिस्ट पक्की हो चुकी है", "This list is already confirmed"),
  shop_no_reply: m("दुकान से जवाब नहीं मिला — फिर कोशिश करें", "The store didn't respond — try again"),
  // confirm
  pin_required: m("पहले पिन डालें", "Enter your PIN first"),
  rate_limited_confirm: m("आज के ऑर्डर पूरे हो गए", "Today's order limit is reached"),
  placing: m("ऑर्डर हो रहा है…", "Placing your order…"),
  asking_owner: m("मालिक से पूछ रहे हैं…", "Asking the owner…"),
  paused: m("अभी रुका हुआ है — मालिक से पूछें", "Ordering is paused — ask the owner"),
  blocked: m("पिछला ऑर्डर पक्का नहीं हुआ — मालिक को बता दिया", "The last order is unconfirmed — the owner has been told"),
  prices_changed: m("दाम बदल गए — फिर से देख लें", "Prices changed — please check again"),
  below_min: m("₹99 से कम — और सामान जोड़ें", "Below ₹99 — add more items"),
  zero_total: m("दाम नहीं मिला — फिर कोशिश करें", "Couldn't get the price — try again"),
  // pairing / pin
  bad_code: m("कोड गलत या पुराना है — मालिक से नया कोड लें", "Wrong or expired code — get a new one from the owner"),
  code_or_pin_bad: m("कोड या पिन ठीक नहीं है", "Code or PIN is not valid"),
  pair_locked: m("अभी कोड नहीं लिया जा सकता — मालिक से पूछें", "Pairing is locked right now — ask the owner"),
  pin_format: m("पिन 4 अंकों का है", "The PIN is 4 digits"),
  device_locked: m("फ़ोन लॉक है — मालिक से खुलवाएं", "This phone is locked — ask the owner to unlock it"),
  device_locked_now: m("फ़ोन लॉक हो गया — मालिक से खुलवाएं", "The phone got locked — ask the owner to unlock it"),
  wrong_pin: m("पिन गलत है ({n} मौके बचे)", "Wrong PIN ({n} tries left)"),
  // checkout outcomes (stored as draft.error keys)
  err_paused_wait: m("अभी रुका हुआ है — मालिक से पूछें", "Ordering is paused — ask the owner"),
  err_blocked_wait: m("पिछला ऑर्डर पक्का नहीं हुआ — रुकिए", "The last order is unconfirmed — please wait"),
  err_lock_retry: m("कोई और ऑर्डर चल रहा है — थोड़ी देर में अपने आप हो जाएगा", "Another order is in progress — yours will go through shortly"),
  err_limit_reask: m("आज की सीमा पूरी — मालिक से फिर पूछ रहे हैं", "Daily limit reached — asking the owner again"),
  err_setup: m("सेटअप पूरा नहीं है — मालिक को बताएं", "Setup is incomplete — tell the owner"),
  err_items_changed: m("सामान बदल गया — दोबारा लिस्ट बनाएं", "Items changed — make the list again"),
  err_price_unread: m("दाम नहीं मिला — मालिक को बताएं", "Couldn't read the price — tell the owner"),
  err_price_up: m("दाम बदल गया — दोबारा पूछें", "The price went up — confirm again"),
  err_address: m("पता ठीक नहीं है — मालिक को बताएं", "Address problem — tell the owner"),
  err_wallet: m("वॉलेट में पैसे नहीं हैं — मालिक को बताया", "The wallet has no money — the owner has been told"),
  err_cod_na: m("कैश ऑर्डर अभी नहीं हो सकता", "Cash on delivery is not possible right now"),
  err_retry_soon: m("थोड़ी देर में अपने आप हो जाएगा", "It will go through automatically shortly"),
  err_login_wait: m("मालिक को भेज दिया ✓ — थोड़ा इंतज़ार", "Sent to the owner ✓ — please wait"),
  err_shop_retry: m("दुकान से जवाब नहीं मिला — थोड़ी देर में फिर कोशिश करें", "The store didn't respond — try again shortly"),
  err_payment: m("पैसे नहीं कट पाए — मालिक को बताया", "Payment failed — the owner has been told"),
  err_not_placed: m("ऑर्डर नहीं हो पाया — थोड़ी देर में फिर कोशिश करें", "The order failed — try again shortly"),
  err_unknown: m("ऑर्डर शायद हो गया — दोबारा मत करना", "The order may have gone through — do NOT order again"),
  err_rejected: m("मालिक ने मना किया", "The owner said no"),
} as const satisfies Record<string, Msg>;

export type MsgKey = keyof typeof MSG;

/** Draft states → cook-facing text. */
export const STATE_MSG: Record<string, Msg> = {
  recorded: m("सुन रहे हैं…", "Listening…"),
  parsed: m("लिस्ट बन रही है…", "Building your list…"),
  matched: m("दाम देख रहे हैं…", "Checking prices…"),
  cart_synced: m("लिस्ट तैयार है", "Your list is ready"),
  awaiting_confirm: m("पक्का करें", "Please confirm"),
  awaiting_approval: m("मालिक से पूछ रहे हैं…", "Asking the owner…"),
  approved: m("ऑर्डर हो रहा है…", "Placing your order…"),
  approved_waiting_login: m("मालिक को भेज दिया ✓ — थोड़ा इंतज़ार", "Sent to the owner ✓ — please wait"),
  placing_swiggypay: m("ऑर्डर हो रहा है…", "Placing your order…"),
  placing_cod: m("ऑर्डर हो रहा है…", "Placing your order…"),
  placed: m("✓ ऑर्डर हो गया", "✓ Order placed"),
  partially_placed: m("कुछ सामान आ रहा है, कुछ नहीं आया", "Some items are coming, some are not"),
  not_placed: m("ऑर्डर नहीं हो पाया", "The order was not placed"),
  unknown: m("ऑर्डर शायद हो गया — दोबारा मत करना", "The order may have gone through — do NOT order again"),
  superseded: m("नई लिस्ट बन गई", "A newer list replaced this one"),
  expired: m("समय निकल गया — फिर से बोलें", "Timed out — please speak again"),
  rejected: m("मालिक ने मना किया", "The owner said no"),
};

/** Resolve a stored key or free text into both languages (unknown text passes through unchanged). */
export function resolveMsg(keyOrText: string | null | undefined, vars?: Record<string, string | number>): Msg | null {
  if (!keyOrText) return null;
  const base = (MSG as Record<string, Msg>)[keyOrText] ?? { hi: keyOrText, en: keyOrText };
  if (!vars) return base;
  const sub = (s: string) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
  return { hi: sub(base.hi), en: sub(base.en) };
}

/** UI strings for the client components. */
export const UI = {
  app_name: m("रसोई", "Rasoi"),
  help: m("मदद सुनें", "Hear help"),
  help_speech: m("बीच का बड़ा बटन दबाकर रखिए, और सामान बोलिए। छोड़ने पर लिस्ट बन जाएगी।", "Press and hold the big button in the middle and say your items. Release and your list will be made."),
  offline: m("इंटरनेट नहीं है — Wi-Fi देखें", "No internet — check the Wi-Fi"),
  paused_banner: m("अभी बंद है — मालिक से पूछें", "Paused — ask the owner"),
  blocked_banner: m("पिछला ऑर्डर पक्का नहीं हुआ — रुकिए", "The last order is unconfirmed — please wait"),
  login_banner: m("मालिक का लॉगिन चाहिए — बता दिया है", "The owner needs to log in to Swiggy — they've been told"),
  demo_banner: m("डेमो मोड — असली ऑर्डर नहीं होगा", "Demo mode — no real orders"),
  making_list: m("लिस्ट बन रही है…", "Building your list…"),
  everyday: m("रोज़ का सामान", "Everyday items"),
  example: m("जैसे: “प्याज़ एक किलो, दो पैकेट दही, धनिया”", "e.g. “one kilo onion, two packs curd, coriander”"),
  generic_error: m("कुछ गड़बड़ हुई — फिर कोशिश करें", "Something went wrong — try again"),
  no_internet: m("इंटरनेट नहीं चल रहा", "No internet connection"),
  server_error: m("सर्वर से बात नहीं हो पाई", "Couldn't reach the server"),
  owner_link: m("मालिक के लिए →", "For the owner →"),
  // mic
  hold_to_speak: m("दबाकर बोलिए", "Hold and speak"),
  listening: m("सुन रहे हैं…", "Listening…"),
  send: m("भेजो ➤", "Send ➤"),
  hold_hint: m("दबाकर रखें और बोलें", "Hold the button and speak"),
  hold_hint_speech: m("दबाकर रखिए और बोलिए", "Hold the button and speak"),
  mic_failed: m("माइक चालू नहीं हुआ — Chrome में इजाज़त दें", "The mic didn't start — allow it in Chrome"),
  mic_aria: m("बोलने के लिए दबाएं", "Press to speak"),
  // list
  your_list: m("आपकी लिस्ट", "Your list"),
  back: m("← वापस", "← Back"),
  back_plain: m("वापस", "Back"),
  checking_prices: m("दाम देख रहे हैं…", "Checking prices…"),
  not_found: m("नहीं मिला", "Not found"),
  say_more: m("🎤 और बोलें", "🎤 Say more"),
  order_now: m("✅ ऑर्डर करो →", "✅ Order →"),
  confirm_q: m("पक्का करें?", "Confirm?"),
  pay_wallet: m("💳 Swiggy Money से कटेंगे", "💳 Paid from Swiggy Money"),
  pay_cod: m("💵 डिलीवरी पर नकद देना है", "💵 Cash on delivery"),
  hold_to_confirm: m("दबाए रखें", "hold to confirm"),
  holding: m("दबाए रखें…", "Keep holding…"),
  ordering_in: m("{n} सेकंड में ऑर्डर होगा…", "Ordering in {n} s…"),
  cancel: m("रद्द करें", "Cancel"),
  cancelled_speech: m("रोक दिया", "Cancelled"),
  keep_open: m("यह पेज खुला रखें", "Keep this page open"),
  try_again: m("↻ फिर कोशिश करें", "↻ Try again"),
  speak_again: m("🎤 फिर से बोलें", "🎤 Speak again"),
  forwarded_title: m("मालिक को भेज दिया ✓", "Sent to the owner ✓"),
  forwarded_body: m("दुकान से अभी जवाब नहीं आया — मालिक लिस्ट देखकर मंगा देंगे।", "The store isn't responding right now — the owner will see your list and order it."),
  home: m("🏠 वापस", "🏠 Home"),
  out_of_stock: m("कुछ चीज़ें खत्म हैं:", "Out of stock:"),
  cash_to_pay: m("नकद देना है", "cash to pay"),
  stores: m("दुकान", "stores"),
  wallet_short: m("💳 Swiggy Money", "💳 Swiggy Money"),
  list_ready_speech: m("लिस्ट तैयार है", "Your list is ready"),
  nothing_found_speech: m("कुछ नहीं मिला — फिर से बोलें", "Nothing found — please speak again"),
  total_speech: m("कुल {n} रुपये", "Total {n} rupees"),
  hear_total: m("कुल सुनें", "Hear the total"),
  decrease: m("कम करें", "Less"),
  increase: m("बढ़ाएं", "More"),
  sending: m("भेज रहे हैं…", "Sending…"),
  list_confirmed_wait: m("लिस्ट पक्की हो चुकी है…", "The list is already confirmed…"),
  prices_changed_check: m("दाम बदल गए — फिर से देखकर पक्का करें", "Prices changed — check and confirm again"),
  prices_changed_speech: m("दाम बदल गए हैं, फिर से देख लीजिए", "Prices have changed, please check again"),
  // status
  demo_no_order: m("डेमो — असली ऑर्डर नहीं हुआ", "Demo — no real order was placed"),
  on_the_way: m("रास्ते में", "On the way"),
  delivered: m("पहुंच गया", "Delivered"),
  minutes: m("मिनट", "min"),
  keep_cash: m("💵 कैश तैयार रखें {amt}", "💵 Keep cash ready: {amt}"),
  change_and_retry: m("बदलकर फिर से बोल सकते हैं", "You can change it and speak again"),
  do_not_reorder: m("दोबारा ऑर्डर मत करना — मालिक देख रहे हैं", "Do not order again — the owner is checking"),
  // pin
  enter_pin: m("पिन डालें", "Enter PIN"),
  wrong_pin_short: m("पिन गलत है", "Wrong PIN"),
  // pair
  pair_title: m("फ़ोन जोड़ें 📱", "Pair this phone 📱"),
  pair_consent: m("आवाज़ Google को जाती है ताकि लिस्ट बन सके।", "Your voice is sent to Google so the list can be made."),
  pair_code_label: m("मालिक से मिला 6-अंकों का कोड", "The 6-digit code from the owner"),
  pair_pin_label: m("नया पिन बनाएं (4 अंक)", "Create a PIN (4 digits)"),
  pair_name_label: m("नाम (जैसे: रसोई का फ़ोन)", "Name (e.g. kitchen phone)"),
  pair_button: m("जोड़ें →", "Pair →"),
  mic_permission: m("माइक की इजाज़त दें", "Allow the microphone"),
  mic_permission_hint: m("Chrome पूछे तो “Allow / हर बार” चुनें", "When Chrome asks, choose “Allow”"),
  mic_denied: m("इजाज़त नहीं मिली — Chrome की सेटिंग में जाकर Allow करें", "Permission denied — allow it in Chrome settings"),
  mic_on: m("माइक चालू करें", "Turn on the mic"),
  voice_check: m("आवाज़ की जांच", "Voice check"),
  hear_hello: m("सुनें: “नमस्ते!”", "Hear: “Hello!”"),
  hello_speech: m("नमस्ते! रसोई तैयार है।", "Hello! Rasoi is ready."),
  heard_ok: m("सुनाई दिया ✓", "I heard it ✓"),
  heard_no: m("सुनाई नहीं दिया, फिर भी आगे बढ़ें", "Didn't hear it, continue anyway"),
  done: m("हो गया!", "Done!"),
  install_hint: m("Chrome के मेन्यू (⋮) से “Add to Home screen / होम स्क्रीन पर जोड़ें” दबाएं ताकि यह ऐप की तरह खुले।", "In Chrome's menu (⋮) tap “Add to Home screen” so it opens like an app."),
  start: m("शुरू करें →", "Start →"),
} as const satisfies Record<string, Msg>;

export type UiKey = keyof typeof UI;

export function ui(key: UiKey, lang: Lang, vars?: Record<string, string | number>): string {
  const s = UI[key][lang];
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`)) : s;
}

/** Pick server-provided text by language, falling back to Hindi, then to the given fallback. */
export function pick(lang: Lang, obj: { hi?: string | null; en?: string | null } | null | undefined, fallback = ""): string {
  if (!obj) return fallback;
  return (lang === "en" ? obj.en || obj.hi : obj.hi || obj.en) || fallback;
}
