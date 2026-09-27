// Voice → grocery list via Gemini Flash-Lite (audio in, JSON out, one call).
// LLM BOUNDARY: the model receives ONLY the audio bytes and the glossary prompt.
// It never sees addresses, phone numbers, tokens, or Swiggy tool access, and its
// output is zod-validated + deterministically normalized before anything uses it.

import { GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";
import { env } from "@/lib/env";
import type { ParseResult, VoiceItem } from "@/lib/types";
import { AUDIO_PROMPT } from "@/lib/voice/glossary";
import { normalizeItems } from "@/lib/voice/units";

// Pinned model ids (never "-latest"): primary + fallback have separate free-tier quotas.
const MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    transcript: { type: Type.STRING, description: "Verbatim transcript in the script spoken (Devanagari for Hindi, Latin for English). Do not correct it." },
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          spoken: { type: Type.STRING, description: "The words used for this item, as spoken" },
          name_hi: { type: Type.STRING, description: "Colloquial Hindi name in Devanagari, e.g. प्याज़, दही, धनिया" },
          search_en: { type: Type.STRING, description: "English product search term for Indian grocery apps, e.g. 'onion', 'curd', 'coriander leaves'" },
          qty: { type: Type.NUMBER, description: "Numeric quantity; 1 if not said" },
          unit: { type: Type.STRING, enum: ["g", "kg", "ml", "l", "pack", "piece", "dozen", "bunch"] },
          confidence: { type: Type.NUMBER, description: "0-1, how sure about item AND quantity" },
          needs_clarification: { type: Type.BOOLEAN },
          note: { type: Type.STRING, description: "Short note for ambiguity or brand mention, else empty" },
        },
        required: ["spoken", "name_hi", "search_en", "qty", "unit", "confidence", "needs_clarification"],
      },
    },
  },
  required: ["transcript", "items"],
};

const zItem = z.object({
  spoken: z.string(),
  name_hi: z.string(),
  search_en: z.string().min(1),
  qty: z.number(),
  unit: z.enum(["g", "kg", "ml", "l", "pack", "piece", "dozen", "bunch"]),
  confidence: z.number().min(0).max(1).catch(0.5),
  needs_clarification: z.boolean(),
  note: z.string().optional(),
});
const zParse = z.object({ transcript: z.string(), items: z.array(zItem) });

export class VoiceParseError extends Error {
  quota: boolean;
  constructor(message: string, quota: boolean) {
    super(message);
    this.name = "VoiceParseError";
    this.quota = quota;
  }
}

export async function parseGroceryAudio(audio: Uint8Array, mimeType: string): Promise<ParseResult> {
  if (!env.geminiApiKey) {
    if (env.isDemo) return demoParse();
    throw new VoiceParseError("GEMINI_API_KEY is not set", false);
  }
  const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });
  const data = Buffer.from(audio).toString("base64");
  let lastErr = "";
  let quota = false;
  for (const model of MODELS) {
    const t0 = Date.now();
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ inlineData: { mimeType, data } }, { text: AUDIO_PROMPT }] }],
        config: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA, temperature: 0 },
      });
      const parsed = zParse.parse(JSON.parse(res.text ?? "{}"));
      return {
        transcript: parsed.transcript,
        items: normalizeItems(parsed.items as VoiceItem[]),
        model,
        ms: Date.now() - t0,
      };
    } catch (e: any) {
      lastErr = `${model}: ${String(e?.message ?? e).slice(0, 300)}`;
      if (/429|quota|resource.?exhausted|rate/i.test(lastErr)) quota = true;
      console.error("voice parse failed", lastErr);
    }
  }
  throw new VoiceParseError(lastErr, quota);
}

/** Canned parse for demo mode without a Gemini key, so the UI flow is walkable. */
export function demoParse(): ParseResult {
  const items: VoiceItem[] = [
    { spoken: "pyaz ek kilo", name_hi: "प्याज़", search_en: "onion", qty: 1, unit: "kg", confidence: 0.98, needs_clarification: false },
    { spoken: "do packet dahi", name_hi: "दही", search_en: "curd", qty: 2, unit: "pack", confidence: 0.95, needs_clarification: false },
    { spoken: "dhaniya", name_hi: "धनिया", search_en: "coriander leaves", qty: 1, unit: "bunch", confidence: 0.9, needs_clarification: false },
  ];
  return { transcript: "प्याज़ एक किलो, दो पैकेट दही, धनिया (डेमो)", items, model: "demo", ms: 0 };
}
