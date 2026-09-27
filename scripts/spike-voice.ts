/**
 * Phase 0 voice spike — sends audio clips to Gemini Flash-Lite and prints the parsed grocery list.
 *
 * Usage:
 *   GEMINI_API_KEY=... npx tsx scripts/spike-voice.ts eval/clips            # every audio file in the folder
 *   GEMINI_API_KEY=... npx tsx scripts/spike-voice.ts eval/clips --model=gemini-3.1-flash-lite
 *   Optional scoring: put eval/clips/expected.json = { "<file>": [{ "search_en": "onion", "qty": 1, "unit": "kg" }, ...] }
 *
 * Accepted: .webm .ogg .opus .mp3 .wav .m4a .aac .flac (WhatsApp voice notes are .opus/.ogg — Gemini accepts them directly).
 */
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { GoogleGenAI, Type } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("Set GEMINI_API_KEY (from the rasoi-prod Google Cloud project).");
  process.exit(1);
}
const dir = process.argv[2] ?? "eval/clips";
const modelArg = process.argv.find((a) => a.startsWith("--model="))?.slice(8);
const MODELS = modelArg ? [modelArg] : ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
const MIME: Record<string, string> = {
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".mp3": "audio/mp3",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
};

const UNITS = ["g", "kg", "ml", "l", "pack", "piece", "dozen", "bunch"];
const schema = {
  type: Type.OBJECT,
  properties: {
    transcript: {
      type: Type.STRING,
      description: "Verbatim transcript of what was said, in the script it was spoken (Devanagari for Hindi words, Latin for English words). Do not correct or complete it.",
    },
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          spoken: { type: Type.STRING, description: "The words used for this item, as spoken" },
          name_hi: { type: Type.STRING, description: "Colloquial Hindi name in Devanagari, e.g. प्याज़, दही, धनिया" },
          search_en: { type: Type.STRING, description: "English product search term as used on Indian grocery apps, e.g. 'onion', 'curd', 'coriander leaves', 'green chilli'" },
          qty: { type: Type.NUMBER, description: "Numeric quantity. aadha=0.5, paav=0.25 kg (=250 g), sawa=1.25, dedh=1.5, dhai=2.5, saadhe teen=3.5, paune do=1.75, darjan=12. If not said, use 1." },
          unit: { type: Type.STRING, enum: UNITS, description: "kg/g for weight, l/ml for liquids, pack for packets, piece, dozen, bunch (gaddi)" },
          confidence: { type: Type.NUMBER, description: "0-1, how sure you are about item AND quantity" },
          needs_clarification: { type: Type.BOOLEAN, description: "true if the item or quantity is ambiguous (e.g. dhaniya leaves vs powder, mirch green vs red)" },
          note: { type: Type.STRING, description: "Short note for ambiguity or brand mention, else empty" },
        },
        required: ["spoken", "name_hi", "search_en", "qty", "unit", "confidence", "needs_clarification"],
      },
    },
  },
  required: ["transcript", "items"],
};

const PROMPT = `You are transcribing a household cook in Delhi speaking a grocery list in Hindi / Hinglish, possibly with kitchen noise.
Return JSON only, following the schema.
Rules:
- Transcribe verbatim first. Then extract every grocery item with quantity and unit.
- Vernacular: pyaz/pyaaz/kanda=onion, tamatar=tomato, aloo=potato, dhaniya=coriander leaves (unless "dhaniya powder"/"sabut dhaniya"), adrak=ginger, lehsun=garlic, hari mirch=green chilli, lal mirch powder=red chilli powder, nimbu=lemon, dahi=curd, doodh=milk, paneer=paneer, atta=wheat flour (atta), maida=refined flour, chawal=rice, dal (toor/arhar, moong, masoor, chana, urad), bhindi=okra (ladies finger), lauki=bottle gourd, shimla mirch=capsicum, pudina=mint leaves, kadi patta=curry leaves, palak=spinach, gobhi=cauliflower (phool gobhi) / cabbage (patta gobhi / band gobhi), matar=green peas, gajar=carrot, kheera=cucumber, baingan=brinjal, tel=cooking oil, ghee=ghee, namak=salt, cheeni/shakkar=sugar, haldi=turmeric, jeera=cumin, rai=mustard seeds, elaichi=cardamom, tez patta=bay leaf, besan=gram flour, sooji=semolina, poha=flattened rice, bread=bread, anda=eggs, makkhan=butter.
- Units: "ek kilo"=1 kg, "aadha kilo"=0.5 kg, "paav"/"paav bhar"/"250 gram"=250 g, "dhai sau gram"=250 g, "do packet"=2 pack, "ek darjan"=1 dozen, "ek gaddi"=1 bunch, "do litre"=2 l, "ek bottle" -> 1 pack with note "bottle".
- "do" can mean "two" or "give"; use context. "pav" (bread) vs "paav" (quarter kilo): decide from context.
- Do not invent items that were not spoken. If unsure, keep the item with needs_clarification=true.`;

async function main() {
  const files = readdirSync(dir).filter((f) => MIME[extname(f).toLowerCase()]);
  if (!files.length) {
    console.error(`No audio files in ${dir}`);
    process.exit(1);
  }
  const expectedPath = join(dir, "expected.json");
  const expected: Record<string, Array<{ search_en: string; qty: number; unit: string }>> = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, "utf8")) : {};
  const ai = new GoogleGenAI({ apiKey });
  const out: unknown[] = [];
  let hit = 0;
  let totalExpected = 0;

  for (const f of files) {
    const data = readFileSync(join(dir, f)).toString("base64");
    const mimeType = MIME[extname(f).toLowerCase()];
    let parsed: any = null;
    let used = "";
    let ms = 0;
    let err = "";
    for (const model of MODELS) {
      const t0 = Date.now();
      try {
        const res = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ inlineData: { mimeType, data } }, { text: PROMPT }] }],
          config: { responseMimeType: "application/json", responseSchema: schema, temperature: 0 },
        });
        ms = Date.now() - t0;
        parsed = JSON.parse(res.text ?? "{}");
        used = model;
        break;
      } catch (e: any) {
        err = `${model}: ${e?.message ?? e}`;
        console.error(`  ${f}: ${err}`);
      }
    }
    console.log(`\n=== ${f}  (${used || "FAILED"}, ${ms} ms)`);
    if (!parsed) {
      out.push({ file: f, error: err });
      continue;
    }
    console.log(`transcript: ${parsed.transcript}`);
    for (const it of parsed.items ?? []) {
      console.log(`  - ${it.name_hi} | ${it.search_en} | ${it.qty} ${it.unit} | conf ${it.confidence}${it.needs_clarification ? " | ?" : ""}${it.note ? " | " + it.note : ""}`);
    }
    const exp = expected[f];
    if (exp) {
      totalExpected += exp.length;
      for (const e of exp) {
        const ok = (parsed.items ?? []).some((it: any) => String(it.search_en).toLowerCase().includes(e.search_en.toLowerCase()) && Number(it.qty) === e.qty && it.unit === e.unit);
        if (ok) hit++;
        else console.log(`  MISS: expected ${e.search_en} ${e.qty} ${e.unit}`);
      }
    }
    out.push({ file: f, model: used, ms, ...parsed });
  }
  if (totalExpected) console.log(`\nAccuracy (item+qty+unit): ${hit}/${totalExpected} = ${((100 * hit) / totalExpected).toFixed(0)}%`);
  mkdirSync("spike-results", { recursive: true });
  const outFile = `spike-results/voice-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`Saved ${outFile}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
