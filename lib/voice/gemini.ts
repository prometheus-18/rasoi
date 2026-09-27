// Voice → grocery list. Paths, in order (each step only if the previous failed):
//   1. Gemini Flash-Lite AUDIO → JSON  (3.5-flash-lite, then 3.1-flash-lite — separate quotas)
//   2. Groq Whisper → TEXT, then Gemini TEXT → JSON (both models)
//   3. Groq Whisper → TEXT, then the deterministic rules parser (no LLM at all)
// LLM BOUNDARY: the models receive ONLY audio/transcript + the glossary prompt. They never see
// addresses, phone numbers, tokens or Swiggy tools, and their output is zod-validated +
// deterministically normalized before anything uses it.

import { GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";
import { env } from "@/lib/env";
import type { ParseResult, VoiceItem } from "@/lib/types";
import { AUDIO_PROMPT } from "@/lib/voice/glossary";
import { groqTranscribe } from "@/lib/voice/groq";
import { rulesParse } from "@/lib/voice/rules";
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

export type ParsePath = "gemini-audio" | "groq+gemini-text" | "groq+rules" | "demo";

export type VoiceParse = ParseResult & { path: ParsePath; degraded: boolean; errors: string[] };

export class VoiceParseError extends Error {
  quota: boolean;
  errors: string[];
  constructor(errors: string[], quota: boolean) {
    super(errors.join(" | ") || "voice parse failed");
    this.name = "VoiceParseError";
    this.quota = quota;
    this.errors = errors;
  }
}

const isQuota = (msg: string) => /429|quota|resource.?exhausted|rate/i.test(msg);

function client(): GoogleGenAI {
  if (!env.geminiApiKey) throw new Error("GEMINI_API_KEY is not set");
  return new GoogleGenAI({ apiKey: env.geminiApiKey });
}

async function geminiAudio(audio: Uint8Array, mimeType: string, errors: string[]): Promise<ParseResult | null> {
  if (!env.geminiApiKey) {
    errors.push("gemini: GEMINI_API_KEY not set");
    return null;
  }
  const ai = client();
  const data = Buffer.from(audio).toString("base64");
  for (const model of MODELS) {
    const t0 = Date.now();
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ inlineData: { mimeType, data } }, { text: AUDIO_PROMPT }] }],
        config: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA, temperature: 0 },
      });
      const parsed = zParse.parse(JSON.parse(res.text ?? "{}"));
      return { transcript: parsed.transcript, items: normalizeItems(parsed.items as VoiceItem[]), model, ms: Date.now() - t0 };
    } catch (e: any) {
      errors.push(`${model}/audio: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  return null;
}

/** Text → JSON list (typed fallback, Whisper transcripts, later the "type instead" path). */
export async function geminiText(transcript: string, errors: string[] = []): Promise<ParseResult | null> {
  if (!env.geminiApiKey) {
    errors.push("gemini: GEMINI_API_KEY not set");
    return null;
  }
  const ai = client();
  for (const model of MODELS) {
    const t0 = Date.now();
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: `${AUDIO_PROMPT}\n\nThe transcript (already transcribed; copy it verbatim into "transcript"):\n"""${transcript}"""` }] }],
        config: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA, temperature: 0 },
      });
      const parsed = zParse.parse(JSON.parse(res.text ?? "{}"));
      return { transcript: parsed.transcript || transcript, items: normalizeItems(parsed.items as VoiceItem[]), model, ms: Date.now() - t0 };
    } catch (e: any) {
      errors.push(`${model}/text: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  return null;
}

export async function parseGroceryAudio(audio: Uint8Array, mimeType: string): Promise<VoiceParse> {
  const errors: string[] = [];

  if (!env.geminiApiKey && !env.groqApiKey) {
    if (env.isDemo) return { ...demoParse(), path: "demo", degraded: true, errors: ["no GEMINI_API_KEY / GROQ_API_KEY — demo parse"] };
    throw new VoiceParseError(["GEMINI_API_KEY and GROQ_API_KEY are both unset"], false);
  }

  // 1. Gemini audio → JSON
  const direct = await geminiAudio(audio, mimeType, errors);
  if (direct) return { ...direct, path: "gemini-audio", degraded: false, errors };

  // 2./3. need a transcript from Groq Whisper
  if (!env.groqApiKey) {
    errors.push("groq: GROQ_API_KEY not set");
    throw new VoiceParseError(errors, errors.some(isQuota));
  }
  let transcript: string;
  let groqMs = 0;
  try {
    const g = await groqTranscribe(audio, mimeType);
    transcript = g.text;
    groqMs = g.ms;
  } catch (e: any) {
    errors.push(`groq: ${String(e?.message ?? e).slice(0, 200)}`);
    throw new VoiceParseError(errors, errors.some(isQuota));
  }
  if (!transcript) {
    errors.push("groq: empty transcript");
    throw new VoiceParseError(errors, errors.some(isQuota));
  }

  const viaText = await geminiText(transcript, errors);
  if (viaText) return { ...viaText, ms: viaText.ms + groqMs, model: `whisper-large-v3+${viaText.model}`, path: "groq+gemini-text", degraded: true, errors };

  const items = rulesParse(transcript);
  return { transcript, items, model: "whisper-large-v3+rules", ms: groqMs, path: "groq+rules", degraded: true, errors };
}

/** Canned parse for demo mode without any key, so the UI flow is walkable. */
export function demoParse(): ParseResult {
  const items: VoiceItem[] = [
    { spoken: "pyaz ek kilo", name_hi: "प्याज़", search_en: "onion", qty: 1, unit: "kg", confidence: 0.98, needs_clarification: false },
    { spoken: "do packet dahi", name_hi: "दही", search_en: "curd", qty: 2, unit: "pack", confidence: 0.95, needs_clarification: false },
    { spoken: "dhaniya", name_hi: "धनिया", search_en: "coriander leaves", qty: 1, unit: "bunch", confidence: 0.9, needs_clarification: false },
  ];
  return { transcript: "प्याज़ एक किलो, दो पैकेट दही, धनिया (डेमो — कोई API key नहीं)", items, model: "demo", ms: 0 };
}
