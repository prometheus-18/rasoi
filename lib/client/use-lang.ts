"use client";

// Language toggle state (Hindi default). Persisted per device in localStorage; every mounted
// component follows the same value via a window event.

import { useEffect, useState } from "react";
import type { Lang } from "@/lib/i18n";

const KEY = "rasoi_lang";
const EVT = "rasoi:lang";

export function readLang(): Lang {
  try {
    return localStorage.getItem(KEY) === "en" ? "en" : "hi";
  } catch {
    return "hi";
  }
}

export function writeLang(lang: Lang): void {
  try {
    localStorage.setItem(KEY, lang);
  } catch {}
  window.dispatchEvent(new CustomEvent<Lang>(EVT, { detail: lang }));
}

export function useLang(): [Lang, (l: Lang) => void] {
  const [lang, setLang] = useState<Lang>("hi");
  useEffect(() => {
    setLang(readLang());
    const h = (e: Event) => setLang((e as CustomEvent<Lang>).detail);
    window.addEventListener(EVT, h);
    return () => window.removeEventListener(EVT, h);
  }, []);
  return [lang, writeLang];
}
