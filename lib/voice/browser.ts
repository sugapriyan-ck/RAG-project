export const MAX_MESSAGE_LENGTH = 4000;

export interface RecognitionResult {
  isFinal: boolean;
  readonly length: number;
  [index: number]: { transcript: string };
}

export interface BrowserRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  // Language the recognizer actually detected for the last transcript, when the
  // backend reports one (e.g. Sarvam). Undefined for on-device recognition.
  detectedLanguage?: string;
  onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export function recognitionConstructor() {
  const browser = window as Window & {
    SpeechRecognition?: new () => BrowserRecognition;
    webkitSpeechRecognition?: new () => BrowserRecognition;
  };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}

export function transcripts(results: ArrayLike<RecognitionResult>) {
  const final: string[] = [];
  const interim: string[] = [];
  Array.from(results).forEach((result) => {
    (result.isFinal ? final : interim).push(result[0]?.transcript ?? "");
  });
  return { final: final.join(" ").trim(), interim: interim.join(" ").trim() };
}

export function matchingVoice<T extends { lang: string }>(voices: T[], language: string) {
  const normalize = (value: string) => value.replaceAll("_", "-").toLowerCase();
  const target = normalize(language);
  return voices.find((voice) => normalize(voice.lang) === target)
    ?? voices.find((voice) => normalize(voice.lang).split("-")[0] === target.split("-")[0]);
}

export function recognitionError(code: string) {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was denied. Allow microphone access in your browser’s site settings, then try again. You can always type.";
    case "audio-capture": return "No microphone is available. Connect a microphone or type your question.";
    case "network": return "The browser’s speech service could not connect. Check your connection or type instead.";
    case "no-speech": return "No speech was detected. Start the microphone again or type your question.";
    case "language-not-supported": return "Your browser’s recognition service does not support this language. Please type instead.";
    case "server-error": return "The voice service could not process your audio. Please try again or type your question.";
    case "aborted": return "Listening cancelled. You can type or start another microphone turn.";
    default: return "Speech recognition stopped unexpectedly. Please try again or type your question.";
  }
}
