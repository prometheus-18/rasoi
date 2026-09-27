// Deterministic grocery-list parser for a Hindi/Hinglish transcript (Latin or Devanagari).
// Used when every LLM path is down: no network, no quota, no surprises. Pure function, unit tested.

import type { Unit, VoiceItem } from "@/lib/types";
import { normalizeItems } from "@/lib/voice/units";

type Lex = { words: string[]; search_en: string; name_hi: string; unit: Unit };

const L = (search_en: string, name_hi: string, unit: Unit, ...words: string[]): Lex => ({ words, search_en, name_hi, unit });

// Default unit = what the cook means when no unit is said ("pyaz" → 1 kg, "dahi" → 1 pack).
export const LEXICON: Lex[] = [
  L("onion", "प्याज़", "kg", "pyaz", "pyaaz", "pyaj", "piyaz", "kanda", "onion", "प्याज", "प्याज़", "प्याज़"),
  L("tomato", "टमाटर", "kg", "tamatar", "tamater", "tomato", "टमाटर"),
  L("potato", "आलू", "kg", "aloo", "alu", "potato", "आलू"),
  L("curd", "दही", "pack", "dahi", "curd", "yogurt", "दही"),
  L("milk", "दूध", "l", "doodh", "dudh", "milk", "दूध"),
  L("coriander leaves", "धनिया", "bunch", "dhaniya", "dhania", "coriander", "धनिया"),
  L("ginger", "अदरक", "g", "adrak", "ginger", "अदरक"),
  L("garlic", "लहसुन", "g", "lehsun", "lahsun", "garlic", "लहसुन"),
  L("green chilli", "हरी मिर्च", "g", "hari mirch", "mirch", "mirchi", "green chilli", "chilli", "हरी मिर्च", "मिर्च"),
  L("lemon", "नींबू", "piece", "nimbu", "nibu", "lemon", "नींबू", "निम्बू"),
  L("paneer", "पनीर", "g", "paneer", "पनीर"),
  L("wheat flour atta", "आटा", "kg", "atta", "aata", "आटा"),
  L("refined flour maida", "मैदा", "kg", "maida", "मैदा"),
  L("rice", "चावल", "kg", "chawal", "chaval", "rice", "चावल"),
  L("okra", "भिंडी", "kg", "bhindi", "okra", "भिंडी"),
  L("bottle gourd", "लौकी", "piece", "lauki", "लौकी"),
  L("capsicum", "शिमला मिर्च", "g", "shimla mirch", "capsicum", "शिमला मिर्च"),
  L("mint leaves", "पुदीना", "bunch", "pudina", "mint", "पुदीना"),
  L("curry leaves", "कड़ी पत्ता", "bunch", "kadi patta", "kari patta", "curry leaves", "कड़ी पत्ता", "करी पत्ता"),
  L("spinach", "पालक", "bunch", "palak", "spinach", "पालक"),
  L("cauliflower", "गोभी", "piece", "gobhi", "gobi", "phool gobhi", "cauliflower", "गोभी", "फूल गोभी"),
  L("cabbage", "पत्ता गोभी", "piece", "patta gobhi", "band gobhi", "cabbage", "पत्ता गोभी", "बंद गोभी"),
  L("green peas", "मटर", "kg", "matar", "peas", "मटर"),
  L("carrot", "गाजर", "kg", "gajar", "carrot", "गाजर"),
  L("cucumber", "खीरा", "kg", "kheera", "khira", "cucumber", "खीरा"),
  L("brinjal", "बैंगन", "kg", "baingan", "baigan", "brinjal", "बैंगन"),
  L("cooking oil", "तेल", "l", "tel", "oil", "तेल"),
  L("ghee", "घी", "pack", "ghee", "घी"),
  L("salt", "नमक", "kg", "namak", "salt", "नमक"),
  L("sugar", "चीनी", "kg", "cheeni", "chini", "shakkar", "sugar", "चीनी", "शक्कर"),
  L("turmeric powder", "हल्दी", "pack", "haldi", "turmeric", "हल्दी"),
  L("cumin seeds", "जीरा", "pack", "jeera", "zeera", "cumin", "जीरा"),
  L("mustard seeds", "राई", "pack", "rai", "sarson", "राई"),
  L("cardamom", "इलायची", "pack", "elaichi", "ilaichi", "cardamom", "इलायची"),
  L("bay leaf", "तेज पत्ता", "pack", "tez patta", "tej patta", "तेज पत्ता"),
  L("gram flour besan", "बेसन", "kg", "besan", "बेसन"),
  L("semolina sooji", "सूजी", "kg", "sooji", "suji", "rava", "सूजी"),
  L("poha", "पोहा", "kg", "poha", "पोहा"),
  L("bread", "ब्रेड", "pack", "bread", "double roti", "ब्रेड", "डबल रोटी"),
  L("eggs", "अंडे", "dozen", "anda", "ande", "andey", "egg", "eggs", "अंडा", "अंडे", "अण्डे"),
  L("butter", "मक्खन", "pack", "makkhan", "butter", "मक्खन"),
  L("toor dal", "अरहर दाल", "kg", "toor dal", "arhar dal", "arhar", "toor", "अरहर दाल", "तूर दाल", "अरहर"),
  L("moong dal", "मूंग दाल", "kg", "moong dal", "moong", "मूंग दाल", "मूंग"),
  L("masoor dal", "मसूर दाल", "kg", "masoor dal", "masoor", "मसूर दाल", "मसूर"),
  L("chana dal", "चना दाल", "kg", "chana dal", "चना दाल"),
  L("dal", "दाल", "kg", "dal", "daal", "दाल"),
  L("banana", "केला", "dozen", "kela", "kele", "banana", "केला", "केले"),
  L("apple", "सेब", "kg", "seb", "apple", "सेब"),
  L("orange", "संतरा", "kg", "santra", "orange", "संतरा"),
  L("tea", "चायपत्ती", "pack", "chai", "chaipatti", "chai patti", "tea", "चाय", "चायपत्ती"),
  L("coffee", "कॉफी", "pack", "coffee", "कॉफी"),
  L("biscuit", "बिस्किट", "pack", "biscuit", "biscuits", "बिस्किट"),
  L("papad", "पापड़", "pack", "papad", "पापड़"),
  L("namkeen", "नमकीन", "pack", "namkeen", "नमकीन"),
  L("noodles", "नूडल्स", "pack", "maggi", "noodles", "मैगी", "नूडल्स"),
  L("tomato ketchup", "केचप", "pack", "ketchup", "sauce", "केचप"),
  L("soap", "साबुन", "piece", "sabun", "soap", "साबुन"),
  L("detergent", "सर्फ", "pack", "surf", "detergent", "सर्फ"),
];

const NUM: Record<string, number> = {
  ek: 1, एक: 1, do: 2, दो: 2, teen: 3, तीन: 3, char: 4, chaar: 4, चार: 4, paanch: 5, panch: 5, pach: 5, पांच: 5, पाँच: 5,
  chhe: 6, che: 6, chah: 6, छह: 6, छे: 6, saat: 7, सात: 7, aath: 8, आठ: 8, nau: 9, नौ: 9, das: 10, दस: 10,
  aadha: 0.5, adha: 0.5, aadhi: 0.5, आधा: 0.5, आधी: 0.5, dedh: 1.5, derh: 1.5, डेढ़: 1.5, डेढ: 1.5,
  dhai: 2.5, dhaai: 2.5, ढाई: 2.5, sawa: 1.25, सवा: 1.25, one: 1, two: 2, three: 3, four: 4, five: 5,
};
const PAAV = new Set(["paav", "pao", "पाव"]);
const PAUNE = new Set(["paune", "पौने"]);
const SAU = new Set(["sau", "सौ", "hundred"]);
const DOZEN = new Set(["darjan", "dozen", "दर्जन"]);

const UNIT: Record<string, Unit> = {
  kilo: "kg", kg: "kg", kilogram: "kg", किलो: "kg", केजी: "kg",
  gram: "g", grams: "g", gm: "g", g: "g", ग्राम: "g",
  litre: "l", liter: "l", ltr: "l", l: "l", लीटर: "l",
  ml: "ml", मिली: "ml",
  packet: "pack", packets: "pack", pack: "pack", pkt: "pack", पैकेट: "pack", पैक: "pack", bottle: "pack", बोतल: "pack",
  gaddi: "bunch", bunch: "bunch", गड्डी: "bunch",
  piece: "piece", pieces: "piece", pc: "piece", pcs: "piece", nag: "piece", पीस: "piece", नग: "piece",
};

// \b is ASCII-only in JS regexes, so separator words use whitespace lookarounds instead
const SEPARATORS = /[,;।\n]|(?<!\S)(?:aur|और|phir|फिर|plus)(?!\S)/gi;
const FILLER = new Set(["chahiye", "चाहिए", "le", "lena", "लेना", "aana", "आना", "mangao", "मंगाओ", "bhi", "भी", "ka", "ki", "ke", "का", "की", "के", "de", "दे", "do"]);

function tokenize(s: string): string[] {
  // \p{M} keeps Devanagari vowel signs / nukta (combining marks) attached to their consonants
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s.]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Read a quantity+unit out of a token window. Returns null if no number/unit present. */
function readQty(tokens: string[], fallbackUnit: Unit): { qty: number; unit: Unit } | null {
  let qty: number | null = null;
  let unit: Unit | null = null;
  let paune = false;
  let sawaPending = false;
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i];
    if (/^\d+(\.\d+)?$/.test(w)) qty = (qty ?? 0) + Number(w);
    else if (PAUNE.has(w)) paune = true;
    else if (w === "sawa" || w === "सवा") sawaPending = true;
    else if (PAAV.has(w)) {
      qty = 250; // paav = quarter kilo
      unit = "g";
    } else if (SAU.has(w)) qty = (qty ?? 1) * 100;
    else if (DOZEN.has(w)) {
      qty = qty ?? 1;
      unit = "dozen";
    } else if (w in NUM) {
      const n = NUM[w];
      if (paune) {
        qty = n - 0.25;
        paune = false;
      } else if (sawaPending) {
        qty = n + 0.25;
        sawaPending = false;
      } else if (qty !== null && qty >= 100) qty += n; // "sau paanch" is rare; keep additive
      else qty = n;
    } else if (w in UNIT) unit = unit ?? UNIT[w];
  }
  if (sawaPending && qty === null) qty = 1.25;
  if (qty === null && unit === null) return null;
  qty = qty ?? 1;
  if (!unit) {
    // "do sau" without a unit means grams for weight items
    unit = qty >= 50 ? (fallbackUnit === "l" || fallbackUnit === "ml" ? "ml" : "g") : fallbackUnit;
  }
  if (unit === "kg" && qty >= 50) unit = "g";
  return { qty, unit };
}

/** Find lexicon items in a token list; returns [startIdx, endIdx, lex]. Longest match wins. */
function findItems(tokens: string[]): { start: number; end: number; lex: Lex }[] {
  const out: { start: number; end: number; lex: Lex }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let best: { len: number; lex: Lex } | null = null;
    for (const lex of LEXICON) {
      for (const phrase of lex.words) {
        const parts = phrase.split(" ");
        if (parts.every((p, k) => tokens[i + k] === p)) {
          if (!best || parts.length > best.len) best = { len: parts.length, lex };
        }
      }
    }
    if (best) {
      out.push({ start: i, end: i + best.len, lex: best.lex });
      i += best.len - 1;
    }
  }
  return out;
}

export function rulesParse(transcript: string): VoiceItem[] {
  const items: VoiceItem[] = [];
  const segments = transcript.split(SEPARATORS).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const tokens = tokenize(seg).filter((t) => !FILLER.has(t) || t in NUM);
    const found = findItems(tokens);
    for (let k = 0; k < found.length; k++) {
      const f = found[k];
      const after = tokens.slice(f.end, found[k + 1]?.start ?? tokens.length);
      const before = tokens.slice(found[k - 1]?.end ?? 0, f.start);
      const q = readQty(after, f.lex.unit) ?? readQty(before, f.lex.unit) ?? { qty: 1, unit: f.lex.unit };
      items.push({
        spoken: tokens.slice(f.start, f.end).join(" "),
        name_hi: f.lex.name_hi,
        search_en: f.lex.search_en,
        qty: q.qty,
        unit: q.unit,
        confidence: 0.6,
        needs_clarification: false,
        note: "rules",
      });
    }
  }
  return normalizeItems(items);
}
