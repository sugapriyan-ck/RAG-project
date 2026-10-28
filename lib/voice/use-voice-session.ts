"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { matchingVoice, recognitionConstructor } from "./browser";
import { createServerRecognition, type ServerTranscript } from "./server-recognition";
import { createVoiceSession, type VoiceSessionState, type VoiceTurnReply } from "./session";

export type VoiceEngine = "browser" | "server";

export interface VoiceSessionOptions {
  language: string;
  engine: VoiceEngine;
  onTurn: (text: string, signal: AbortSignal, language?: string) => Promise<string | VoiceTurnReply>;
  onTranscript: (text: string) => void;
}

/** Languages the Sarvam server engine can transcribe and speak. */
export const SERVER_VOICE_LANGUAGES = new Set(["en-IN", "hi-IN", "ta-IN", "te-IN", "kn-IN", "ml-IN"]);

async function transcribeAudio(audio: Blob, language: string, signal: AbortSignal): Promise<ServerTranscript> {
  const response = await fetch("/api/voice/transcribe", {
    method: "POST",
    headers: { "Content-Type": audio.type || "audio/webm", "x-voice-language": language },
    body: audio,
    signal,
  });
  if (!response.ok) throw new Error("Transcription request failed");
  const data = await response.json() as { text?: unknown; language?: unknown };
  return {
    text: typeof data.text === "string" ? data.text : "",
    language: typeof data.language === "string" ? data.language : undefined,
  };
}

export function useVoiceSession({ language, engine, onTurn, onTranscript }: VoiceSessionOptions) {
  const handlers = useRef({ onTurn, onTranscript });
  const controller = useRef<ReturnType<typeof createVoiceSession> | null>(null);
  const [state, setState] = useState<VoiceSessionState>({ phase: "idle", active: false, error: "" });
  const [support, setSupport] = useState("Checking voice conversation support…");

  // Commit fresh handlers before any browser event can deliver a new turn.
  useLayoutEffect(() => { handlers.current = { onTurn, onTranscript }; }, [onTurn, onTranscript]);

  useEffect(() => {
    let mounted = true;
    let utterance: SpeechSynthesisUtterance | null = null;
    let audio: HTMLAudioElement | null = null;
    let audioUrl: string | null = null;
    let playback: AbortController | null = null;

    const releaseServerAudio = () => {
      playback?.abort();
      playback = null;
      if (audio) {
        audio.onended = audio.onerror = null;
        audio.pause();
        audio.src = "";
      }
      audio = null;
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = null;
    };

    const browserAvailability = () => {
      if (!window.isSecureContext) return "Voice conversation requires HTTPS or localhost. You can use text chat.";
      if (!recognitionConstructor()) return "Speech recognition is unavailable. Try a supported browser such as Chrome, or use text chat.";
      if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) return "Spoken replies are unavailable in this browser. Please use text chat.";
      if (!matchingVoice(window.speechSynthesis.getVoices(), language)) return "No installed speech voice matches this language. Install a matching system voice or choose another language. Text chat is available.";
      if (document.hidden) return "Voice conversation is paused while this tab is hidden. Return to this tab and start conversation again.";
      return "";
    };
    const serverAvailability = () => {
      if (!window.isSecureContext) return "Voice conversation requires HTTPS or localhost. You can use text chat.";
      if (!navigator.mediaDevices?.getUserMedia) return "Recording audio is unavailable in this browser. Switch to the browser engine or use text chat.";
      if (typeof MediaRecorder === "undefined") return "Recording audio is unavailable in this browser. Switch to the browser engine or use text chat.";
      if (!SERVER_VOICE_LANGUAGES.has(language)) return "This language is not available for server voice. Choose a supported language, switch to the browser engine, or type your question.";
      if (document.hidden) return "Voice conversation is paused while this tab is hidden. Return to this tab and start conversation again.";
      return "";
    };
    const availability = engine === "server" ? serverAvailability : browserAvailability;

    const speakBrowser = (text: string, lang: string, onEnd: () => void, onError: () => void) => {
      const voice = matchingVoice(window.speechSynthesis.getVoices(), lang);
      if (!voice) throw new Error("Matching speech voice unavailable");
      utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang;
      utterance.voice = voice;
      utterance.onend = onEnd;
      utterance.onerror = onError;
      window.speechSynthesis.speak(utterance);
    };
    const speakServer = (text: string, lang: string, onEnd: () => void, onError: () => void) => {
      releaseServerAudio();
      const pending = new AbortController();
      playback = pending;
      fetch("/api/voice/synthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, language: lang }),
        signal: pending.signal,
      })
        .then((response) => {
          if (!response.ok) throw new Error("Synthesis request failed");
          return response.blob();
        })
        .then((blob) => {
          if (pending.signal.aborted) return;
          audioUrl = URL.createObjectURL(blob);
          const element = new Audio(audioUrl);
          audio = element;
          element.onended = () => { releaseServerAudio(); onEnd(); };
          element.onerror = () => { releaseServerAudio(); onError(); };
          void element.play().catch(() => { releaseServerAudio(); onError(); });
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (!pending.signal.aborted) onError();
        });
    };
    const cancelServerSpeech = () => releaseServerAudio();
    const cancelBrowserSpeech = () => {
      if (utterance) utterance.onend = utterance.onerror = null;
      utterance = null;
      window.speechSynthesis?.cancel();
    };

    const session = createVoiceSession({
      language,
      support: availability,
      createRecognition: () => {
        if (engine === "server") {
          return createServerRecognition(language, {
            transcribe: ({ audio: blob, language: lang, signal }) => transcribeAudio(blob, lang, signal),
          });
        }
        const Constructor = recognitionConstructor();
        if (!Constructor) throw new Error("Speech recognition unavailable");
        return new Constructor();
      },
      // Server voice speaks the reply in the language the customer actually
      // used. Browser voice keeps the selected language, since a matching
      // installed system voice is required.
      speak: engine === "server"
        ? speakServer
        : (text, _replyLanguage, onEnd, onError) => speakBrowser(text, language, onEnd, onError),
      cancelSpeech: engine === "server" ? cancelServerSpeech : cancelBrowserSpeech,
      onTurn: (text, signal, language) => handlers.current.onTurn(text, signal, language),
      onTranscript: (text) => handlers.current.onTranscript(text),
      onState: (next) => { if (mounted) setState(next); },
    });
    controller.current = session;
    const update = () => {
      if (!mounted) return;
      const reason = availability();
      setSupport(reason);
      if (reason) session.unavailable(reason);
      setState(session.getState());
    };
    // Discover browser capabilities only after hydration. A voiceschanged event
    // updates delayed voice inventories without ever starting the microphone.
    const timer = setTimeout(update, 0);
    window.speechSynthesis?.addEventListener("voiceschanged", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      mounted = false;
      clearTimeout(timer);
      window.speechSynthesis?.removeEventListener("voiceschanged", update);
      document.removeEventListener("visibilitychange", update);
      session.end();
      releaseServerAudio();
      if (controller.current === session) controller.current = null;
    };
  }, [language, engine]);

  const start = useCallback(() => controller.current?.start(), []);
  const pause = useCallback(() => controller.current?.pause(), []);
  const end = useCallback(() => controller.current?.end(), []);
  const interrupt = useCallback(() => controller.current?.interrupt(), []);
  return { ...state, support, start, pause, end, interrupt };
}
