import type {
  ProviderCapabilities,
  SpeechToTextProvider,
  SpeechToTextRequest,
  SpeechToTextResult,
  TextToSpeechProvider,
  TextToSpeechRequest,
  TextToSpeechResult,
} from "./providers";

const API_ORIGIN = "https://api.sarvam.ai";
const STT_MODEL = process.env.SARVAM_STT_MODEL || "saaras:v4";
const TTS_MODEL = process.env.SARVAM_TTS_MODEL || "bulbul:v4-flash";
const DEFAULT_SPEAKER = process.env.SARVAM_TTS_SPEAKER || "simran_en_customer";
const MAX_STT_BYTES = 16 * 1024 * 1024;
const MAX_TTS_CHARACTERS = 2500;
const SUPPORTED_LANGUAGES = new Set(["en-IN", "hi-IN", "ta-IN", "te-IN", "kn-IN", "ml-IN"]);

function key(): string {
  const value = process.env.SARVAM_API_KEY;
  if (!value) throw new SarvamError("Sarvam is not configured", 503);
  return value;
}

export class SarvamError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SarvamError";
  }
}

function language(value: string): string {
  if (!SUPPORTED_LANGUAGES.has(value)) throw new SarvamError("Unsupported voice language", 400);
  return value;
}

async function responseError(response: Response): Promise<never> {
  // Keep provider payloads out of logs and client responses.
  throw new SarvamError(
    response.status === 401 || response.status === 403 ? "Sarvam authentication failed" :
      response.status === 429 ? "Sarvam rate limit reached" : "Sarvam voice request failed",
    response.status,
  );
}

function capabilities(): ProviderCapabilities {
  return process.env.SARVAM_API_KEY
    ? { available: true }
    : { available: false, reason: "SARVAM_API_KEY is not configured on the server." };
}

/** Documented Sarvam Saaras v4 REST adapter. Audio is transient and never stored. */
export function createSarvamSpeechToText(): SpeechToTextProvider {
  return {
    capabilities: capabilities(),
    async execute(request: SpeechToTextRequest): Promise<SpeechToTextResult> {
      if (!request.audio?.byteLength || request.audio.byteLength > MAX_STT_BYTES) {
        throw new SarvamError("Audio is empty or exceeds the server limit", 413);
      }
      const form = new FormData();
      form.append("model", STT_MODEL);
      form.append("mode", "codemix");
      if (request.language) form.append("language_code", language(request.language));
      // Copy into a plain ArrayBuffer-backed view for Node's Blob typings and
      // to avoid retaining a caller-owned buffer while the request is sent.
      const audio = new Uint8Array(request.audio);
      form.append("file", new Blob([audio.buffer]), "voice-input");
      const response = await fetch(`${API_ORIGIN}/speech-to-text`, {
        method: "POST",
        headers: { "api-subscription-key": key() },
        body: form,
        signal: request.signal ?? AbortSignal.timeout(35_000),
      });
      if (!response.ok) await responseError(response);
      const data = await response.json() as { transcript?: unknown; language_code?: unknown };
      if (typeof data.transcript !== "string" || !data.transcript.trim()) {
        throw new SarvamError("Sarvam returned no transcript", 502);
      }
      return {
        text: data.transcript.trim(),
        language: typeof data.language_code === "string" ? data.language_code : request.language,
      };
    },
  };
}

/** Documented Sarvam Bulbul v4 Flash REST adapter. Returns transient WAV bytes. */
export function createSarvamTextToSpeech(): TextToSpeechProvider {
  return {
    capabilities: capabilities(),
    async execute(request: TextToSpeechRequest): Promise<TextToSpeechResult> {
      if (!request.text.trim() || request.text.length > MAX_TTS_CHARACTERS) {
        throw new SarvamError("Speech text is empty or too long", 400);
      }
      const response = await fetch(`${API_ORIGIN}/text-to-speech`, {
        method: "POST",
        headers: { "api-subscription-key": key(), "Content-Type": "application/json" },
        body: JSON.stringify({
          text: request.text,
          model: TTS_MODEL,
          speaker: process.env.SARVAM_TTS_SPEAKER || DEFAULT_SPEAKER,
          language_code: language(request.language),
        }),
        signal: request.signal ?? AbortSignal.timeout(35_000),
      });
      if (!response.ok) await responseError(response);
      const data = await response.json() as { audios?: unknown };
      const encoded = Array.isArray(data.audios) && typeof data.audios[0] === "string" ? data.audios.join("") : "";
      if (!encoded) throw new SarvamError("Sarvam returned no audio", 502);
      const bytes = Uint8Array.from(Buffer.from(encoded, "base64"));
      return { audio: bytes, mimeType: "audio/wav" };
    },
  };
}
