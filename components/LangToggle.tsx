"use client";

import { useLang } from "@/lib/client/use-lang";

export function LangToggle() {
  const [lang, setLang] = useLang();
  const btn = (l: "hi" | "en", label: string) => (
    <button
      type="button"
      onClick={() => setLang(l)}
      aria-pressed={lang === l}
      className={`h-10 min-h-10 rounded-full px-3 text-base font-bold transition-colors ${lang === l ? "bg-brand text-white" : "text-faint"}`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center rounded-full bg-card p-1 shadow-sm" role="group" aria-label="Language">
      {btn("hi", "हिंदी")}
      {btn("en", "English")}
    </div>
  );
}
