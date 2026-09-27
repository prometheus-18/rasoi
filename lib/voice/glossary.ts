// Household vernacular glossary shared by the audio prompt and the matcher.
// The prompt contains ONLY the glossary and instructions — never addresses, phones or tokens.

export const VERNACULAR: Record<string, string> = {
  pyaz: "onion",
  pyaaz: "onion",
  kanda: "onion",
  tamatar: "tomato",
  aloo: "potato",
  dhaniya: "coriander leaves",
  adrak: "ginger",
  lehsun: "garlic",
  "hari mirch": "green chilli",
  nimbu: "lemon",
  dahi: "curd",
  doodh: "milk",
  paneer: "paneer",
  atta: "wheat flour atta",
  maida: "refined flour maida",
  chawal: "rice",
  bhindi: "okra ladies finger",
  lauki: "bottle gourd",
  "shimla mirch": "capsicum",
  pudina: "mint leaves",
  "kadi patta": "curry leaves",
  palak: "spinach",
  gobhi: "cauliflower",
  matar: "green peas",
  gajar: "carrot",
  kheera: "cucumber",
  baingan: "brinjal",
  tel: "cooking oil",
  ghee: "ghee",
  namak: "salt",
  cheeni: "sugar",
  shakkar: "sugar",
  haldi: "turmeric powder",
  jeera: "cumin seeds",
  rai: "mustard seeds",
  elaichi: "cardamom",
  "tez patta": "bay leaf",
  besan: "gram flour besan",
  sooji: "semolina sooji",
  poha: "poha flattened rice",
  anda: "eggs",
  makkhan: "butter",
};

export const AUDIO_PROMPT = `You are transcribing a household cook in Delhi speaking a grocery list in Hindi / Hinglish, possibly with kitchen noise.
Return JSON only, following the schema.
Rules:
- Transcribe verbatim first. Then extract every grocery item with quantity and unit.
- Vernacular: pyaz/pyaaz/kanda=onion, tamatar=tomato, aloo=potato, dhaniya=coriander leaves (unless "dhaniya powder"/"sabut dhaniya"), adrak=ginger, lehsun=garlic, hari mirch=green chilli, lal mirch powder=red chilli powder, nimbu=lemon, dahi=curd, doodh=milk, paneer=paneer, atta=wheat flour (atta), maida=refined flour, chawal=rice, dal (toor/arhar, moong, masoor, chana, urad), bhindi=okra (ladies finger), lauki=bottle gourd, shimla mirch=capsicum, pudina=mint leaves, kadi patta=curry leaves, palak=spinach, gobhi=cauliflower (phool gobhi) / cabbage (patta gobhi / band gobhi), matar=green peas, gajar=carrot, kheera=cucumber, baingan=brinjal, tel=cooking oil, ghee=ghee, namak=salt, cheeni/shakkar=sugar, haldi=turmeric, jeera=cumin, rai=mustard seeds, elaichi=cardamom, tez patta=bay leaf, besan=gram flour, sooji=semolina, poha=flattened rice, bread=bread, anda=eggs, makkhan=butter.
- Units: "ek kilo"=1 kg, "aadha kilo"=0.5 kg, "paav"/"paav bhar"/"250 gram"=250 g, "dhai sau gram"=250 g, "do packet"=2 pack, "ek darjan"=1 dozen, "ek gaddi"=1 bunch, "do litre"=2 l, "ek bottle" -> 1 pack with note "bottle".
- Numbers: aadha=0.5, paav=0.25 kg (=250 g), sawa=1.25, dedh=1.5, dhai=2.5, saadhe teen=3.5, paune do=1.75, darjan=12.
- "do" can mean "two" or "give"; use context. "pav" (bread) vs "paav" (quarter kilo): decide from context.
- Do not invent items that were not spoken. If unsure, keep the item with needs_clarification=true.`;
