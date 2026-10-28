import { BrowserRecognition, MAX_MESSAGE_LENGTH, recognitionError, transcripts } from "./browser";
import { isRequestAbort, requestErrorMessage } from "./request-error";

export type VoicePhase = "idle" | "listening" | "thinking" | "speaking" | "paused";
export interface VoiceSessionState { phase: VoicePhase; active: boolean; error: string }

/** A completed assistant turn. `language` lets the reply be spoken in the
 *  language the customer actually used, rather than the session default. */
export interface VoiceTurnReply {
  readonly text: string;
  readonly language?: string;
}

export interface VoiceSessionDependencies {
  language: string;
  support: () => string;
  createRecognition: () => BrowserRecognition;
  speak: (text: string, language: string, onEnd: () => void, onError: () => void) => void;
  cancelSpeech: () => void;
  onTurn: (text: string, signal: AbortSignal, language?: string) => Promise<string | VoiceTurnReply>;
  onTranscript: (text: string) => void;
  onState: (state: VoiceSessionState) => void;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export const VOICE_TIMING = {
  echoCooldown: 350,
  emptyRetry: 900,
  listening: 30_000,
  recognitionEnd: 4_000,
  reply: 90_000,
  playback: 180_000,
  maxEmptyTurns: 3,
} as const;

/** Half-duplex session. Every resource callback belongs to exactly one epoch. */
export function createVoiceSession(deps: VoiceSessionDependencies) {
  let state: VoiceSessionState = { phase: "idle", active: false, error: "" };
  let epoch = 0;
  let emptyTurns = 0;
  let recognition: BrowserRecognition | null = null;
  let request: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = deps.setTimer ?? setTimeout;
  const cancelTimer = deps.clearTimer ?? clearTimeout;

  function clearTimer() {
    if (timer !== undefined) cancelTimer(timer);
    timer = undefined;
  }
  function publish(phase: VoicePhase, error = "") {
    state = { phase, active: phase !== "idle" && phase !== "paused", error };
    deps.onState(state);
  }
  function valid(token: number) { return token === epoch && state.active; }
  function wait(delay: number, callback: () => void) {
    clearTimer();
    const token = epoch;
    timer = schedule(() => {
      if (!valid(token)) return;
      timer = undefined;
      callback();
    }, delay);
  }
  function invalidate() {
    ++epoch; // Invalidate before abort/cancel, which may synchronously emit events.
    clearTimer();
    const old = recognition;
    recognition = null;
    if (old) {
      old.onend = old.onerror = old.onresult = null;
      try { old.abort(); } catch { /* Browser may already have ended. */ }
    }
    request?.abort();
    request = null;
    try { deps.cancelSpeech(); } catch { /* Still invalidate all speech callbacks. */ }
  }
  function pause(error = "") {
    invalidate();
    publish("paused", error);
  }
  function end() {
    invalidate();
    emptyTurns = 0;
    publish("idle");
  }
  function empty() {
    invalidate();
    if (++emptyTurns >= VOICE_TIMING.maxEmptyTurns) {
      pause("No speech was captured after three attempts. Start conversation to try again, or type your question.");
      return;
    }
    publish("listening");
    wait(VOICE_TIMING.emptyRetry, listen);
  }
  function playback(text: string, language?: string) {
    const unavailable = deps.support();
    if (unavailable) { pause(unavailable); return; }
    ++epoch;
    clearTimer();
    request = null;
    const token = epoch;
    publish("speaking");
    wait(VOICE_TIMING.playback, () => pause("Audio playback timed out. Read the text reply, then start again."));
    try {
      deps.speak(text, language ?? deps.language, () => {
        if (!valid(token)) return;
        invalidate();
        // Leave the mic off while the last audible sound dissipates.
        wait(VOICE_TIMING.echoCooldown, listen);
      }, () => {
        if (valid(token)) pause("Audio playback failed. Read the text reply, or check your system voice and start again.");
      });
    } catch {
      if (valid(token)) pause("Audio playback is unavailable. Read the text reply and try again.");
    }
  }
  function submit(text: string, language?: string) {
    ++epoch;
    clearTimer();
    const token = epoch;
    const pending = new AbortController();
    request = pending;
    publish("thinking");
    wait(VOICE_TIMING.reply, () => pause("The reply timed out. Please try again or use text chat."));
    // Capture both synchronous callback throws and asynchronous request failures.
    void (async () => {
      try {
        const reply = await deps.onTurn(text, pending.signal, language);
        if (!valid(token)) return;
        const replyText = typeof reply === "string" ? reply : reply.text;
        const replyLanguage = typeof reply === "string" ? undefined : reply.language;
        if (!replyText.trim()) { pause("No reply was returned. Please try again or use text chat."); return; }
        playback(replyText, replyLanguage);
      } catch (error) {
        if (valid(token)) pause(isRequestAbort(error) ? "" : requestErrorMessage(error));
      }
    })();
  }
  function listen() {
    if (!state.active) return;
    const unavailable = deps.support();
    if (unavailable) { pause(unavailable); return; }
    invalidate();
    const token = epoch;
    let final = "";
    let stopping = false;
    let noSpeech = false;
    try {
      const mic = deps.createRecognition();
      recognition = mic;
      mic.lang = deps.language;
      mic.continuous = false;
      mic.interimResults = true;
      mic.onresult = (event) => {
        if (!valid(token) || stopping || noSpeech) return;
        const result = transcripts(event.results);
        final = result.final;
        const live = [final, result.interim].filter(Boolean).join(" ");
        deps.onTranscript(live.slice(0, MAX_MESSAGE_LENGTH));
        if (live.length > MAX_MESSAGE_LENGTH) {
          pause("Speech exceeded the 4,000-character limit. Shorten your question and start again, or use text chat.");
          return;
        }
        if (final) {
          stopping = true;
          wait(VOICE_TIMING.recognitionEnd, () => pause("The microphone did not stop. Please start again or use text chat."));
          try { mic.stop(); } catch { pause("The microphone could not stop. Please use text chat or start again."); }
        }
      };
      mic.onerror = ({ error }) => {
        if (!valid(token)) return;
        if (error === "no-speech") {
          if (noSpeech) return;
          noSpeech = true;
          // Wait for end before retrying: never overlap recognition instances.
          wait(VOICE_TIMING.recognitionEnd, () => pause("The microphone did not stop. Please start again or use text chat."));
        } else pause(recognitionError(error));
      };
      mic.onend = () => {
        if (!valid(token)) return;
        ++epoch;
        clearTimer();
        const detected = mic.detectedLanguage;
        recognition = null;
        mic.onend = mic.onerror = mic.onresult = null;
        if (noSpeech || !final) { empty(); return; }
        emptyTurns = 0;
        deps.onTranscript(final);
        submit(final, detected);
      };
      publish("listening");
      deps.onTranscript("");
      wait(VOICE_TIMING.listening, () => pause("Listening timed out. Start conversation when you are ready, or type your question."));
      mic.start();
    } catch {
      if (valid(token)) pause("Could not start the microphone. Check microphone permissions and try again, or type your question.");
    }
  }
  return {
    getState: () => state,
    start() {
      if (state.active) return;
      emptyTurns = 0;
      publish("listening");
      listen();
    },
    pause: () => pause(),
    end,
    interrupt() {
      if (!state.active || state.phase !== "speaking") return;
      invalidate();
      publish("listening");
      wait(VOICE_TIMING.echoCooldown, listen);
    },
    /** Used by lifecycle/capability changes; never automatically resumes. */
    unavailable: (reason: string) => { if (state.active) pause(reason); },
  };
}
