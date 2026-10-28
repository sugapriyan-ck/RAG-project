import assert from "node:assert/strict";
import test from "node:test";
import { chooseRecorderMimeType, createVad, finalResults, rootMeanSquare, SERVER_VOICE_TIMINGS, type ServerVadTimings } from "./server-recognition";

test("recorder MIME prefers the first container both browser and server support", () => {
  assert.equal(chooseRecorderMimeType(() => true), "audio/webm;codecs=opus");
  assert.equal(chooseRecorderMimeType((type) => type === "audio/mp4"), "audio/mp4");
  assert.equal(chooseRecorderMimeType(() => false), "");
});

test("rootMeanSquare separates silence from loud frames and tolerates empty input", () => {
  assert.equal(rootMeanSquare(new Float32Array([0, 0, 0])), 0);
  assert.equal(rootMeanSquare(new Float32Array([1, -1, 1, -1])), 1);
  assert.ok(rootMeanSquare(new Float32Array([0.5, -0.5])) > 0.49);
  assert.equal(rootMeanSquare(new Float32Array()), 0);
});

test("a server transcript is shaped as a single final browser result", () => {
  assert.deepEqual(finalResults("hello world"), {
    results: [{ isFinal: true, length: 1, 0: { transcript: "hello world" } }],
  });
});

const timings: ServerVadTimings = { threshold: 0.02, minSpeechMs: 300, silenceMs: 1000, maxMs: 10_000 };

test("the detector ignores leading silence and ends only after confirmed speech", () => {
  const vad = createVad(timings);
  vad.reset(0);
  assert.equal(vad.observe(500, 0), "wait");
  assert.equal(vad.observe(1500, 0), "wait");
  assert.equal(vad.observe(1600, 0.5), "wait");
  assert.equal(vad.observe(1800, 0.5), "wait");
  assert.equal(vad.observe(2000, 0.5), "wait");
  assert.equal(vad.observe(2100, 0), "wait");
  assert.equal(vad.observe(2900, 0), "wait");
  assert.equal(vad.observe(3000, 0), "finish");
});

test("a quiet turn never finishes and is reported as no-speech at the cap", () => {
  const vad = createVad(timings);
  vad.reset(0);
  assert.equal(vad.observe(5000, 0), "wait");
  assert.equal(vad.observe(9999, 0.01), "wait");
  assert.equal(vad.observe(10_000, 0.01), "no-speech");
});

test("a long utterance ends at the hard cap even without trailing silence", () => {
  const vad = createVad(timings);
  vad.reset(0);
  assert.equal(vad.observe(100, 0.5), "wait");
  assert.equal(vad.observe(10_000, 0.5), "finish");
});

test("server recognition uses an 800ms silence tail by default", () => {
  assert.equal(SERVER_VOICE_TIMINGS.silenceMs, 800);
  const vad = createVad(SERVER_VOICE_TIMINGS);
  vad.reset(0);
  assert.equal(vad.observe(0, 0.5), "wait");
  assert.equal(vad.observe(SERVER_VOICE_TIMINGS.minSpeechMs, 0.5), "wait");
  assert.equal(vad.observe(SERVER_VOICE_TIMINGS.minSpeechMs + 799, 0), "wait");
  assert.equal(vad.observe(SERVER_VOICE_TIMINGS.minSpeechMs + 800, 0), "finish");
});
