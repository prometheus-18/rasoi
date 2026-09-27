"use client";

// Hindi TTS (comfort, never a safety control). Waits for voiceschanged, always lang hi-IN.

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

export async function speakHi(text: string): Promise<void> {
  if (!("speechSynthesis" in window)) return;
  const voices = await loadVoices();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "hi-IN";
  const hi = voices.find((v) => v.lang.toLowerCase().startsWith("hi"));
  if (hi) u.voice = hi;
  u.rate = 0.95;
  speechSynthesis.speak(u);
}
