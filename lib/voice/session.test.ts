import assert from "node:assert/strict";
import test from "node:test";
import { BrowserRecognition } from "./browser";
import { createVoiceSession, VOICE_TIMING, VoiceSessionState, type VoiceTurnReply } from "./session";
import { ChatRequestError, httpRequestError, requestErrorMessage } from "./request-error";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function harness() {
  const liveMics = new Set<Mic>();
  let speaking = false;
  let support = "";
  let startThrows = false;
  let playbackThrows = false;
  let clock = 0;
  let nextTimer = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const mics: Mic[] = [];
  const speeches: { text: string; language: string; end: () => void; error: () => void }[] = [];
  const requests: { text: string; language: string | undefined; signal: AbortSignal; reply: ReturnType<typeof deferred<string | VoiceTurnReply>> }[] = [];
  const drafts: string[] = [];
  const states: VoiceSessionState[] = [];
  class Mic implements BrowserRecognition {
    lang = "";
    continuous = false;
    interimResults = false;
    detectedLanguage: string | undefined = undefined;
    onresult: BrowserRecognition["onresult"] = null;
    onerror: BrowserRecognition["onerror"] = null;
    onend: BrowserRecognition["onend"] = null;
    stopped = false;
    aborted = false;
    start() {
      if (startThrows) throw new Error("start failed");
      assert.equal(speaking, false, "microphone must never overlap playback");
      assert.equal(liveMics.size, 0, "recognition instances must never overlap");
      liveMics.add(this);
    }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; liveMics.delete(this); }
    result(text: string, isFinal = true) {
      this.onresult?.({ results: [{ isFinal, length: 1, 0: { transcript: text } }] });
    }
    end() { liveMics.delete(this); this.onend?.(); }
    error(code: string) { this.onerror?.({ error: code }); }
  }
  const session = createVoiceSession({
    language: "en-US",
    support: () => support,
    createRecognition: () => { const mic = new Mic(); mics.push(mic); return mic; },
    speak: (text, language, end, error) => {
      assert.equal(liveMics.size, 0, "playback must wait for microphone end");
      if (playbackThrows) throw new Error("playback failed");
      speaking = true;
      speeches.push({ text, language, end: () => { speaking = false; end(); }, error });
    },
    cancelSpeech: () => { speaking = false; },
    onTurn: (text, signal, language) => {
      assert.equal(liveMics.size, 0, "request must wait for final recognition end");
      const reply = deferred<string | VoiceTurnReply>();
      requests.push({ text, language, signal, reply });
      return reply.promise;
    },
    onTranscript: (text) => drafts.push(text),
    onState: (state) => states.push(state),
    setTimer: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, at: clock + delay });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (id) => { timers.delete(id as unknown as number); },
  });
  function advance(delay: number) {
    const until = clock + delay;
    for (;;) {
      const next = [...timers.entries()].filter(([, item]) => item.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      clock = next[1].at;
      next[1].callback();
    }
    clock = until;
  }
  function final(text = "question") { mics.at(-1)!.result(text); mics.at(-1)!.end(); }
  return {
    session, mics, speeches, requests, drafts, states, timers, advance, final,
    support: (reason: string) => { support = reason; },
    failStart: () => { startThrows = true; },
    failPlayback: () => { playbackThrows = true; },
  };
}

test("one start runs two half-duplex turns, final only, and clears each draft", async () => {
  const h = harness();
  h.session.start();
  h.session.start();
  assert.equal(h.mics.length, 1);
  assert.equal(h.mics[0].lang, "en-US");
  h.mics[0].result("interim", false);
  assert.equal(h.requests.length, 0);
  h.mics[0].result("first question");
  assert.equal(h.mics[0].stopped, true);
  assert.equal(h.requests.length, 0);
  h.mics[0].end();
  assert.equal(h.session.getState().phase, "thinking");
  assert.equal(h.requests[0].text, "first question");
  h.requests[0].reply.resolve("first answer");
  await flush();
  assert.equal(h.session.getState().phase, "speaking");
  assert.equal(h.mics.length, 1);
  h.speeches[0].end();
  h.advance(VOICE_TIMING.echoCooldown - 1);
  assert.equal(h.mics.length, 1);
  h.advance(1);
  assert.equal(h.mics.length, 2);
  assert.equal(h.drafts.at(-1), "");
  h.final("second question");
  h.requests[1].reply.resolve("second answer");
  await flush();
  h.speeches[1].end();
  h.advance(VOICE_TIMING.echoCooldown);
  assert.equal(h.mics.length, 3);
  assert.deepEqual(h.requests.map((r) => r.text), ["first question", "second question"]);
  assert.deepEqual(h.speeches.map((s) => s.text), ["first answer", "second answer"]);
  assert.deepEqual(h.speeches.map((s) => s.language), ["en-US", "en-US"]);
  h.session.end();
  assert.deepEqual(h.session.getState(), { phase: "idle", active: false, error: "" });
  assert.equal(h.timers.size, 0);
});

test("a reply's language selects the spoken language; string replies keep the session language", async () => {
  const h = harness();
  h.session.start();
  h.final("enna eppo varum");
  assert.equal(h.requests[0].language, undefined);
  h.requests[0].reply.resolve({ text: "வணக்கம்", language: "ta-IN" });
  await flush();
  assert.equal(h.speeches.length, 1);
  assert.equal(h.speeches[0].text, "வணக்கம்");
  assert.equal(h.speeches[0].language, "ta-IN");
});

test("the recognizer's detected language is forwarded to the turn handler", async () => {
  const h = harness();
  h.session.start();
  h.mics[0].detectedLanguage = "ta-IN";
  h.final("spoken audio");
  assert.equal(h.requests[0].language, "ta-IN");
  h.requests[0].reply.resolve("ok");
  await flush();
});

for (const action of ["pause", "end"] as const) {
  test(`${action} aborts pending request and ignores late completion, even after restart`, async () => {
    const h = harness();
    h.session.start(); h.final();
    h.session[action]();
    assert.equal(h.requests[0].signal.aborted, true);
    assert.equal(h.session.getState().active, false);
    h.session.start();
    h.requests[0].reply.resolve("stale answer");
    await flush();
    assert.equal(h.speeches.length, 0);
    assert.equal(h.session.getState().phase, "listening");
    assert.equal(h.mics.length, 2);
    h.session.end();
  });
}

test("duplicate ends/results and saved callbacks cannot send twice or affect a new turn", async () => {
  const h = harness();
  h.session.start();
  const mic = h.mics[0];
  const oldEnd = mic.onend!;
  const oldResult = mic.onresult!;
  const oldError = mic.onerror!;
  h.final();
  oldEnd(); oldEnd(); oldError({ error: "network" });
  oldResult({ results: [{ isFinal: true, length: 1, 0: { transcript: "duplicate" } }] });
  assert.equal(h.requests.length, 1);
  h.requests[0].reply.resolve("answer"); await flush();
  const speechEnd = h.speeches[0].end;
  speechEnd(); speechEnd();
  h.advance(VOICE_TIMING.echoCooldown);
  oldEnd(); oldError({ error: "not-allowed" }); speechEnd();
  assert.equal(h.session.getState().phase, "listening");
  assert.equal(h.mics.length, 2);
  h.session.end();
});

test("interrupt cancels speech and waits for echo cooldown; stale speech end cannot restart mic", async () => {
  const h = harness();
  h.session.start();
  h.session.interrupt();
  assert.equal(h.mics.length, 1);
  h.final(); h.requests[0].reply.resolve("answer"); await flush();
  h.session.interrupt();
  h.speeches[0].end(); h.speeches[0].error();
  assert.equal(h.session.getState().phase, "listening");
  assert.equal(h.mics.length, 1);
  h.advance(VOICE_TIMING.echoCooldown);
  assert.equal(h.mics.length, 2);
  h.speeches[0].end(); h.advance(VOICE_TIMING.echoCooldown);
  assert.equal(h.mics.length, 2);
  h.session.end();
});

test("three empty turns pause; no-speech waits for end and retries with delay", () => {
  const h = harness();
  h.session.start();
  for (let i = 0; i < 3; i++) {
    const mic = h.mics[i];
    mic.result("interim only", false);
    mic.error("no-speech");
    assert.equal(h.mics.length, i + 1);
    mic.end();
    if (i < 2) {
      h.advance(VOICE_TIMING.emptyRetry - 1);
      assert.equal(h.mics.length, i + 1);
      h.advance(1);
    }
  }
  assert.equal(h.session.getState().phase, "paused");
  assert.match(h.session.getState().error, /three attempts/);
  h.advance(1_000_000);
  assert.equal(h.mics.length, 3);
  assert.equal(h.requests.length, 0);
  h.session.start();
  assert.equal(h.mics.length, 4);
  h.session.end();
});

test("pause invalidates retry timers, pending microphone events and recognition", () => {
  const h = harness();
  h.session.start();
  const old = h.mics[0].onend!;
  h.mics[0].end();
  const queued = [...h.timers.values()][0].callback;
  h.session.pause();
  queued(); old(); h.advance(1_000_000);
  assert.equal(h.mics.length, 1);
  h.session.start();
  const lastEnd = h.mics[1].onend!;
  h.session.end(); lastEnd();
  assert.equal(h.mics[1].aborted, true);
  assert.equal(h.session.getState().phase, "idle");
});

for (const code of ["not-allowed", "service-not-allowed", "audio-capture", "network", "language-not-supported", "aborted", "unknown"]) {
  test(`recognition ${code} pauses without retrying`, () => {
    const h = harness(); h.session.start();
    h.mics[0].error(code);
    assert.equal(h.session.getState().phase, "paused");
    assert.ok(h.session.getState().error);
    assert.equal(h.mics[0].aborted, true);
    h.advance(1_000_000);
    assert.equal(h.mics.length, 1);
  });
}

test("unsupported/missing voice, startup failure and overflow pause with text fallback", () => {
  const h = harness();
  h.support("Install a matching voice or use text chat."); h.session.start();
  assert.equal(h.mics.length, 0);
  assert.match(h.session.getState().error, /text chat/);
  h.support(""); h.failStart(); h.session.start();
  assert.equal(h.session.getState().phase, "paused");
  const other = harness(); other.session.start(); other.mics[0].result("x".repeat(4001));
  assert.equal(other.session.getState().phase, "paused");
  assert.equal(other.drafts.at(-1)!.length, 4000);
  assert.equal(other.requests.length, 0);
});

test("request rejection, empty answer and playback errors pause", async () => {
  for (const failure of ["request", "empty", "playback", "throw"] as const) {
    const h = harness(); h.session.start(); h.final();
    if (failure === "request") h.requests[0].reply.reject(new Error("offline"));
    else {
      if (failure === "throw") h.failPlayback();
      h.requests[0].reply.resolve(failure === "empty" ? "  " : "answer");
    }
    await flush();
    if (failure === "playback") h.speeches[0].error();
    assert.equal(h.session.getState().phase, "paused", failure);
    assert.equal(h.session.getState().active, false);
    h.advance(1_000_000);
    assert.equal(h.mics.length, 1);
  }
});

for (const [status, expected] of [
  [400, /Invalid chat request.*new chat/],
  [403, /conversation is unavailable.*new chat/],
  [429, /Please wait/],
  [500, /backend is unavailable.*text chat may also fail/],
  [503, /backend is unavailable.*text chat may also fail/],
] as const) {
  test(`HTTP ${status} public guidance reaches voice and pauses without retry`, async () => {
    const h = harness(); h.session.start(); h.final();
    h.requests[0].reply.reject(httpRequestError(status));
    await flush();
    assert.match(h.session.getState().error, expected);
    assert.equal(h.session.getState().phase, "paused");
    assert.equal(h.session.getState().active, false);
    assert.equal(h.timers.size, 0);
    h.advance(1_000_000);
    assert.equal(h.requests.length, 1);
    assert.equal(h.mics.length, 1);
    assert.equal(h.speeches.length, 0);
  });
}

test("connection guidance is safe; arbitrary errors and forged public errors stay generic", async () => {
  const privateMessage = "provider secret=private-key internal database host";
  for (const error of [new Error(privateMessage), privateMessage, { name: "ChatRequestError", message: privateMessage, code: "backend" }, httpRequestError(401), new ChatRequestError("connection")]) {
    const h = harness(); h.session.start(); h.final();
    h.requests[0].reply.reject(error); await flush();
    assert.equal(h.session.getState().error, error instanceof ChatRequestError && error.code === "connection"
      ? "Could not connect to chat. Check your connection and try again."
      : "The chat request failed. Please try again later.");
    assert.equal(h.session.getState().phase, "paused");
    assert.equal(h.session.getState().active, false);
    assert.equal(h.timers.size, 0);
    h.advance(1_000_000);
    assert.equal(h.requests.length, 1);
    assert.equal(h.mics.length, 1);
    assert.equal(h.speeches.length, 0);
  }
  const modified = httpRequestError(500);
  modified.message = privateMessage;
  assert.doesNotMatch(requestErrorMessage(modified), /private-key/);
});

test("request abort stays silent and cannot restart or leave a timeout behind", async () => {
  const h = harness(); h.session.start(); h.final();
  h.requests[0].reply.reject(new DOMException("private abort details", "AbortError"));
  await flush();
  assert.deepEqual(h.session.getState(), { phase: "paused", active: false, error: "" });
  assert.equal(h.timers.size, 0);
  h.advance(1_000_000);
  assert.equal(h.mics.length, 1);
  assert.equal(h.requests.length, 1);
});

test("watchdogs bound stalled microphone, end, request and playback", async () => {
  for (const phase of ["listening", "recognitionEnd", "reply", "playback"] as const) {
    const h = harness(); h.session.start();
    if (phase === "recognitionEnd") h.mics[0].result("final");
    if (phase === "reply" || phase === "playback") h.final();
    if (phase === "playback") { h.requests[0].reply.resolve("answer"); await flush(); }
    h.advance(VOICE_TIMING[phase]);
    assert.equal(h.session.getState().phase, "paused", phase);
    assert.equal(h.timers.size, 0);
    if (phase === "reply") assert.equal(h.requests[0].signal.aborted, true);
  }
});

test("hidden/capability loss invalidates late callbacks and never auto-resumes", async () => {
  const h = harness(); h.session.start(); h.final();
  h.session.unavailable("Tab hidden. Start again when ready.");
  assert.equal(h.requests[0].signal.aborted, true);
  h.requests[0].reply.resolve("late answer"); await flush();
  h.advance(1_000_000);
  assert.equal(h.speeches.length, 0);
  assert.equal(h.session.getState().phase, "paused");
  h.session.start();
  assert.equal(h.mics.length, 2);
  h.session.end();
});

test("successful final resets the consecutive empty-turn budget; natural empty ends are bounded", async () => {
  const h = harness(); h.session.start();
  for (let i = 0; i < 2; i++) {
    h.mics.at(-1)!.end(); h.advance(VOICE_TIMING.emptyRetry);
  }
  h.final("x".repeat(4000));
  assert.equal(h.requests[0].text.length, 4000);
  h.requests[0].reply.resolve("answer"); await flush();
  h.speeches[0].end(); h.advance(VOICE_TIMING.echoCooldown);
  h.mics.at(-1)!.end(); h.advance(VOICE_TIMING.emptyRetry);
  assert.equal(h.session.getState().phase, "listening");
  h.mics.at(-1)!.end(); h.advance(VOICE_TIMING.emptyRetry);
  h.mics.at(-1)!.end();
  assert.equal(h.session.getState().phase, "paused");
});

test("duplicate no-speech errors cannot keep a stalled microphone alive", () => {
  const h = harness(); h.session.start();
  h.mics[0].error("no-speech");
  h.advance(VOICE_TIMING.recognitionEnd - 1);
  h.mics[0].error("no-speech");
  h.advance(1);
  assert.equal(h.session.getState().phase, "paused");
  assert.equal(h.mics[0].aborted, true);
  assert.equal(h.mics.length, 1);
});

test("end during playback cancels speech and invalidates both speech and cooldown callbacks", async () => {
  const h = harness(); h.session.start(); h.final();
  h.requests[0].reply.resolve("answer"); await flush();
  h.speeches[0].end();
  const cooldown = [...h.timers.values()][0].callback;
  h.session.end();
  h.speeches[0].end(); h.speeches[0].error(); cooldown();
  h.advance(1_000_000);
  assert.equal(h.session.getState().phase, "idle");
  assert.equal(h.mics.length, 1);
});
