// Groq Whisper (whisper-large-v3, free tier) — speech-to-TEXT fallback when Gemini audio fails.
// Text only; the item list is then produced by Gemini text parsing or the rules parser.

import { env } from "@/lib/env";

const EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
};

const GROCERY_PROMPT = "Hindi grocery list: pyaz, tamatar, aloo, dahi, doodh, dhaniya, adrak, lehsun, hari mirch, nimbu, paneer, atta, chawal, dal, tel, ghee, namak, cheeni, anda, bread; kilo, gram, paav, aadha, dedh, dhai sau, packet, darjan, gaddi.";

export async function groqTranscribe(audio: Uint8Array, mimeType: string): Promise<{ text: string; ms: number }> {
  if (!env.groqApiKey) throw new Error("GROQ_API_KEY is not set");
  const t0 = Date.now();
  const form = new FormData();
  form.append("file", new Blob([audio as BlobPart], { type: mimeType }), `audio.${EXT[mimeType] ?? "webm"}`);
  form.append("model", "whisper-large-v3");
  form.append("language", "hi");
  form.append("temperature", "0");
  form.append("response_format", "json");
  form.append("prompt", GROCERY_PROMPT);
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.groqApiKey}` },
    body: form,
    signal: AbortSignal.timeout(25_000),
  });
  const body = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string } };
  if (!res.ok || typeof body.text !== "string") throw new Error(`groq ${res.status}: ${body.error?.message ?? "no text"}`);
  return { text: body.text.trim(), ms: Date.now() - t0 };
}
