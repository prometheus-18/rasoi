"use client";

// Product emoji fallback when there is no photo (mock catalog / missing images).

const MAP: [RegExp, string][] = [
  [/onion|pyaz/i, "🧅"],
  [/tomato/i, "🍅"],
  [/potato|aloo/i, "🥔"],
  [/curd|dahi|yogurt/i, "🥛"],
  [/milk|doodh/i, "🥛"],
  [/coriander|dhaniya|mint|pudina|curry leaves/i, "🌿"],
  [/ginger|adrak/i, "🫚"],
  [/garlic|lehsun/i, "🧄"],
  [/chilli|mirch/i, "🌶️"],
  [/lemon|nimbu|lime/i, "🍋"],
  [/paneer|cheese/i, "🧀"],
  [/bread|pav/i, "🍞"],
  [/egg|anda/i, "🥚"],
  [/atta|flour|maida|besan|sooji/i, "🌾"],
  [/rice|chawal|poha/i, "🍚"],
  [/oil|tel|ghee/i, "🛢️"],
  [/salt|namak/i, "🧂"],
  [/sugar|cheeni|shakkar/i, "🍬"],
  [/capsicum|pepper/i, "🫑"],
  [/cucumber|kheera/i, "🥒"],
  [/spinach|palak|cabbage|patta/i, "🥬"],
  [/cauliflower|gobhi|broccoli/i, "🥦"],
  [/dal|lentil|rajma|chana/i, "🫘"],
  [/butter|makkhan/i, "🧈"],
  [/banana|kela/i, "🍌"],
  [/apple|seb/i, "🍎"],
  [/carrot|gajar/i, "🥕"],
  [/peas|matar/i, "🫛"],
  [/brinjal|baingan/i, "🍆"],
];

export function productEmoji(name: string): string {
  for (const [re, emoji] of MAP) if (re.test(name)) return emoji;
  return "🛒";
}
