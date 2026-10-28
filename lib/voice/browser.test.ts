import assert from "node:assert/strict";
import test from "node:test";
import { matchingVoice, recognitionError, transcripts } from "./browser";

test("interim words never become a final auto-send transcript", () => {
  assert.deepEqual(transcripts({
    0: { isFinal: true, length: 1, 0: { transcript: "मेरे ऑर्डर" } },
    1: { isFinal: false, length: 1, 0: { transcript: "का क्या" } },
    length: 2,
  }), { final: "मेरे ऑर्डर", interim: "का क्या" });
});

test("recognition snapshots replace revised interim results instead of duplicating them", () => {
  const first = transcripts([{ isFinal: false, length: 1, 0: { transcript: "my older" } }]);
  const next = transcripts([{ isFinal: true, length: 1, 0: { transcript: "my order" } }]);
  assert.equal(first.final, "");
  assert.equal(next.final, "my order");
  assert.equal(next.interim, "");
});

test("voice selection prefers exact locale then same language, never unrelated fallback", () => {
  const voices = [{ lang: "en-US" }, { lang: "en_IN" }, { lang: "ta-LK" }];
  assert.equal(matchingVoice(voices, "en-IN"), voices[1]);
  assert.equal(matchingVoice(voices, "ta-IN"), voices[2]);
  assert.equal(matchingVoice(voices, "hi-IN"), undefined);
  assert.equal(matchingVoice([], "en-IN"), undefined);
});

test("permission, network and language failures offer actionable text fallback", () => {
  assert.match(recognitionError("not-allowed"), /site settings/);
  assert.match(recognitionError("network"), /connection/);
  assert.match(recognitionError("language-not-supported"), /type/);
  assert.match(recognitionError("server-error"), /type/);
  assert.match(recognitionError("future-error"), /type/);
});
