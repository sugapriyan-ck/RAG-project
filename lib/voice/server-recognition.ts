import { type BrowserRecognition, MAX_MESSAGE_LENGTH, type RecognitionResult } from "./browser";

/**
 * Server-backed speech recognition. Implements the same `BrowserRecognition`
 * contract the voice session already drives, but records microphone audio with
 * `MediaRecorder`, detects the end of an utterance locally, then sends the
 * audio to `/api/voice/transcribe` (Sarvam) for a code-mixed transcript.
 *
 * Audio lives only for the length of one turn: it is never persisted and the
 * recorder, tracks, analyser and object URLs are released as soon as the turn
 * finishes, fails or is aborted.
 */

export interface ServerRecognitionRequest {
  readonly audio: Blob;
  readonly language: string;
  readonly signal: AbortSignal;
}

/** A transcript plus the language the backend detected for it, if reported. */
export interface ServerTranscript {
  readonly text: string;
  readonly language?: string;
}

export interface ServerRecognitionOptions {
  readonly transcribe: (request: ServerRecognitionRequest) => Promise<string | ServerTranscript>;
  readonly constraints?: MediaStreamConstraints;
  readonly timings?: Partial<ServerVadTimings>;
  readonly frameMs?: number;
  readonly now?: () => number;
}

export interface ServerVadTimings {
  /** RMS amplitude above which a frame counts as speech. */
  readonly threshold: number;
  /** Voiced duration required before an utterance is trusted. */
  readonly minSpeechMs: number;
  /** Trailing silence that ends the utterance. */
  readonly silenceMs: number;
  /** Hard cap so a stuck turn always ends. */
  readonly maxMs: number;
}

export const SERVER_VOICE_TIMINGS: ServerVadTimings = {
  threshold: 0.02,
  minSpeechMs: 350,
  silenceMs: 800,
  maxMs: 20_000,
};

const RECORDER_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
];

/** Pick the first container the browser can record and the server accepts. */
export function chooseRecorderMimeType(supported: (type: string) => boolean): string {
  return RECORDER_MIME_TYPES.find((type) => supported(type)) ?? "";
}

/** Windowed amplitude used to decide loud vs. silent frames. */
export function rootMeanSquare(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let index = 0; index < samples.length; index++) sum += samples[index] * samples[index];
  return Math.sqrt(sum / (samples.length || 1));
}

export type VadDecision = "wait" | "finish" | "no-speech";

export interface VoiceActivityDetector {
  reset(now: number): void;
  observe(now: number, level: number): VadDecision;
}

/** Pure endpointing state machine: avoids stopping on silence before speech. */
export function createVad(timings: ServerVadTimings): VoiceActivityDetector {
  let startedAt = 0;
  let lastVoiceAt = 0;
  let speechSince = 0;
  let hasSpeech = false;
  return {
    reset(now: number) {
      startedAt = now;
      lastVoiceAt = now;
      speechSince = 0;
      hasSpeech = false;
    },
    observe(now: number, level: number): VadDecision {
      if (level >= timings.threshold) {
        lastVoiceAt = now;
        if (!hasSpeech) {
          hasSpeech = true;
          speechSince = now;
        }
      }
      if (hasSpeech && now - speechSince >= timings.minSpeechMs && now - lastVoiceAt >= timings.silenceMs) {
        return "finish";
      }
      if (now - startedAt >= timings.maxMs) return hasSpeech ? "finish" : "no-speech";
      return "wait";
    },
  };
}

/** Shape a server transcript like a final browser recognition result. */
export function finalResults(text: string): { results: RecognitionResult[] } {
  return { results: [{ isFinal: true, length: 1, 0: { transcript: text } }] };
}

function mediaErrorCode(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") return "not-allowed";
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") return "audio-capture";
  }
  return "unknown";
}

export function createServerRecognition(language: string, options: ServerRecognitionOptions): BrowserRecognition {
  const timings: ServerVadTimings = { ...SERVER_VOICE_TIMINGS, ...options.timings };
  const now = options.now ?? (() => Date.now());
  const frameMs = options.frameMs ?? 120;

  let phase: "idle" | "recording" | "finishing" | "closed" = "idle";
  let aborted = false;
  let settled = false;
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let context: AudioContext | null = null;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let guard: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  let chunks: Blob[] = [];
  let mimeType = "";

  const recognition: BrowserRecognition = {
    lang: language,
    continuous: false,
    interimResults: false,
    onresult: null,
    onerror: null,
    onend: null,
    start,
    stop,
    abort,
  };

  function releaseAudio() {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    const active = context;
    context = null;
    if (active) void active.close().catch(() => { /* Already closed. */ });
  }

  function clearTimers() {
    if (ticker !== undefined) clearInterval(ticker);
    ticker = undefined;
    if (guard !== undefined) clearTimeout(guard);
    guard = undefined;
  }

  function stopRecorder() {
    const active = recorder;
    if (active && active.state !== "inactive") {
      try { active.stop(); } catch { /* Browser may have stopped it already. */ }
    }
  }

  function emitEnd() {
    recognition.onend?.();
  }

  function fail(code: string) {
    if (settled || aborted) return;
    settled = true;
    phase = "closed";
    clearTimers();
    releaseAudio();
    recognition.onerror?.({ error: code });
  }

  async function transcribe() {
    if (settled || aborted) return;
    const audio = new Blob(chunks, { type: mimeType || "audio/webm" });
    chunks = [];
    if (!audio.size) {
      settled = true;
      phase = "closed";
      emitEnd();
      return;
    }
    try {
      const signal = controller?.signal ?? new AbortController().signal;
      const result = await options.transcribe({ audio, language: recognition.lang, signal });
      if (settled || aborted) return;
      settled = true;
      phase = "closed";
      const text = typeof result === "string" ? result : result.text;
      const detected = typeof result === "string" ? undefined : result.language;
      const trimmed = text.trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!trimmed) {
        emitEnd();
        return;
      }
      if (detected) recognition.detectedLanguage = detected;
      recognition.onresult?.(finalResults(trimmed));
      emitEnd();
    } catch (error) {
      if (aborted || settled) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      fail("server-error");
    }
  }

  function listenForSilence(media: MediaStream) {
    const vad = createVad(timings);
    vad.reset(now());
    const Context = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Context) {
      try {
        const audioContext = new Context();
        context = audioContext;
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        audioContext.createMediaStreamSource(media).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        ticker = setInterval(() => {
          analyser.getFloatTimeDomainData(samples);
          const decision = vad.observe(now(), rootMeanSquare(samples));
          if (decision === "finish") stop();
          else if (decision === "no-speech") finishEmpty();
        }, frameMs);
      } catch {
        // No analyser: fall back to the max-duration guard below.
      }
    }
    guard = setTimeout(() => {
      if (phase !== "recording") return;
      if (vad.observe(now(), 0) === "no-speech") finishEmpty();
      else stop();
    }, timings.maxMs + 1000);
  }

  function begin(media: MediaStream) {
    if (phase !== "recording") {
      media.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = media;
    mimeType = chooseRecorderMimeType((type) =>
      typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type));
    try {
      const active = mimeType ? new MediaRecorder(media, { mimeType }) : new MediaRecorder(media);
      recorder = active;
      active.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      active.onstop = () => { void transcribe(); };
      active.start();
    } catch {
      fail("unknown");
      return;
    }
    listenForSilence(media);
  }

  function finishEmpty() {
    if (phase !== "recording") return;
    settled = true;
    phase = "closed";
    clearTimers();
    stopRecorder();
    releaseAudio();
    emitEnd();
  }

  function start() {
    if (phase !== "idle") return;
    phase = "recording";
    controller = new AbortController();
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      fail("unknown");
      return;
    }
    navigator.mediaDevices.getUserMedia(options.constraints ?? { audio: true })
      .then((media) => begin(media))
      .catch((error: unknown) => fail(mediaErrorCode(error)));
  }

  function stop() {
    if (phase !== "recording") return;
    phase = "finishing";
    clearTimers();
    stopRecorder();
    releaseAudio();
  }

  function abort() {
    aborted = true;
    settled = true;
    phase = "closed";
    controller?.abort();
    controller = null;
    clearTimers();
    stopRecorder();
    releaseAudio();
    recognition.onresult = recognition.onerror = recognition.onend = null;
  }

  return recognition;
}
