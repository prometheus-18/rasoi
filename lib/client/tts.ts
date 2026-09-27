"use client";

// Speech output in the chosen language (comfort, never a safety control). Waits for voiceschanged.

import type { Lang } from "@/lib/i18n";

let voicesReady: Promise<SpeechSynthesisVoice[]> | null = null;

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!("speechSynthesis" in window)) return Promise.resolve([]);
  if (!voicesReady) {
    voicesReady = new Promise((resolve) => {
      const got = speechSynthesis.getVoices();
      if (got.length) {
        resolve(got);
        return;
      }
      const timer = setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
      speechSynthesis.addEventListener(
        "voiceschanged",
        () => {
          clearTimeout(timer);
          resolve(speechSynthesis.getVoices());
        },
        { once: true },
      );
    });
  }
  return voicesReady;
}

export async function hindiVoiceAvailable(): Promise<boolean> {
  const voices = await loadVoices();
  return voices.some((v) => v.lang.toLowerCase().startsWith("hi"));
}

export async function speak(text: string, lang: Lang = "hi"): Promise<void> {
  if (!("speechSynthesis" in window) || !text) return;
  const voices = await loadVoices();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const tag = lang === "en" ? "en-IN" : "hi-IN";
  u.lang = tag;
  const voice =
    voices.find((v) => v.lang.toLowerCase() === tag.toLowerCase()) ?? voices.find((v) => v.lang.toLowerCase().startsWith(lang === "en" ? "en" : "hi"));
  if (voice) u.voice = voice;
  u.rate = 0.95;
  speechSynthesis.speak(u);
}

/** Back-compat helper used by /check. */
export const speakHi = (text: string) => speak(text, "hi");
