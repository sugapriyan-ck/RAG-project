import type { ChatLanguage } from "./validation";

// Best-effort detection of the language (and script) a customer used, so the
// reply can mirror them. Indian-language inputs arrive either in a native
// script or Romanized ("Tanglish"/"Hinglish"/...); both need to be recognized.
//
// Detection is intentionally conservative: it only reports `confident: true`
// when it finds native-script characters or a clear Romanized-language marker,
// so ordinary English questions keep their existing behavior.

export type MessageScript = "native" | "roman" | "english";

export interface DetectedLanguage {
  language: ChatLanguage;
  script: MessageScript;
  confident: boolean;
}

const NATIVE_SCRIPTS: { language: ChatLanguage; test: RegExp }[] = [
  { language: "hi-IN", test: /[\u0900-\u097f]/u },
  { language: "ta-IN", test: /[\u0b80-\u0bff]/u },
  { language: "te-IN", test: /[\u0c00-\u0c7f]/u },
  { language: "kn-IN", test: /[\u0c80-\u0cff]/u },
  { language: "ml-IN", test: /[\u0d00-\u0d7f]/u },
];

// Distinctive Romanized markers per language. Ambiguous shared words
// (illa, varum, entha, nalla, ...) are deliberately omitted or left to the
// scoring tie-break so they don't misclassify one language as another.
const ROMAN_MARKERS: Record<Exclude<ChatLanguage, "en-IN">, RegExp> = {
  "hi-IN":
    /\b(?:kahan|kab|kaise|kaisa|kaisi|kya|kyaa|nahi|nahin|nehi|mera|meri|mere|mujhe|muje|chahiye|chaiye|kitna|kitne|kitni|bhejo|batao|bata|milega|milegi|jaldi|karo|karna|hoga|hogi|theek|thik|accha|acha|paisa|paise|wapas|wapis|chalu|tum|aap|hum|yeh|woh|hai|hain|kuch|bahut|bahot|kabhi|dena|lena|matlab|samajh|chalta)\b/gi,
  "ta-IN":
    /\b(?:eppo|eppadi|epdi|enna|ennaa|engae|enga|enge|irukku|iruku|venum|vena|pannunga|pannu|romba|sollunga|sollu|kudunga|vanakkam|nandri|mudiyuma|theriyuma|ethana|evlo|yaaru|yaen|anuppu|varuma|podu|seriya|poi)\b/gi,
  "te-IN":
    /\b(?:ela|enti|ekkada|epudu|cheyandi|kavali|undi|ledu|naaku|meeru|cheppandi|entha|enduku|endhuku|vastundi|avunu|kaadu|cheyi|chudu|bagunundi|emaina)\b/gi,
  "kn-IN":
    /\b(?:hege|enu|elli|yaavaga|yavaga|beku|nanage|nimma|heli|eshtu|yaake|barthe|aaguttade|hodaru|maadi|kodu|chennagide)\b/gi,
  "ml-IN":
    /\b(?:engane|enthu|evide|eppol|venam|enikku|ningal|paranju|ethra|pattilla|aano|undo|cheyyu|tharu|njan)\b/gi,
};

export function detectMessageLanguage(text: string): DetectedLanguage {
  for (const { language, test } of NATIVE_SCRIPTS) {
    if (test.test(text)) return { language, script: "native", confident: true };
  }

  const scores: { language: ChatLanguage; count: number }[] = [];
  for (const [language, regex] of Object.entries(ROMAN_MARKERS) as [ChatLanguage, RegExp][]) {
    const matches = text.match(regex);
    const count = matches ? new Set(matches.map((match) => match.toLowerCase())).size : 0;
    if (count > 0) scores.push({ language, count });
  }
  scores.sort((a, b) => b.count - a.count);

  // Only trust Roman detection when one language clearly leads; a tie is
  // ambiguous and falls back to the caller's default (usually English).
  if (scores.length > 0 && (scores.length === 1 || scores[0].count > scores[1].count)) {
    return { language: scores[0].language, script: "roman", confident: true };
  }

  return { language: "en-IN", script: "english", confident: false };
}
