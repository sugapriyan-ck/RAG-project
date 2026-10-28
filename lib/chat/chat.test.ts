import assert from "node:assert/strict";
import { test } from "node:test";
import { boundHistory, contextualizeQuestion, HISTORY_CHARACTER_LIMIT } from "./context";
import { detectMessageLanguage } from "./language";
import { buildAnswerMessages, noHitAnswer, NO_HIT_ANSWERS, resolveReplyLanguage } from "./prompt";
import { CHAT_LANGUAGES, validateChatRequest, validateHandles } from "./validation";

const id = "11111111-1111-4111-8111-111111111111";
const key = "22222222-2222-4222-8222-222222222222";

test("unknown JSON, malformed handles, language and voice fail validation", () => {
  for (const body of [null, [], 1, "hello", {}, { message: null }, { message: 2 }, { message: " " }, { message: "x".repeat(4001) },
    { message: "ok", conversationId: id }, { message: "ok", visitorKey: key },
    { message: "ok", conversationId: null, visitorKey: key }, { message: "ok", conversationId: id, visitorKey: null },
    { message: "ok", conversationId: "bad", visitorKey: key },
    { message: "ok", language: "fr-FR" }, { message: "ok", language: null },
    { message: "ok", voice: "false" }, { message: "ok", voice: 1 }]) {
    assert.ok(validateChatRequest(body).error, JSON.stringify(body));
  }
  assert.ok(validateHandles(undefined, undefined, true).error);
});

test("only optional nullish handle pairs normalize to a new conversation", () => {
  for (const conversationId of [undefined, null]) {
    for (const visitorKey of [undefined, null]) {
      assert.deepEqual(validateHandles(conversationId, visitorKey), { value: {} });
      assert.ok(validateHandles(conversationId, visitorKey, true).error);
      assert.deepEqual(validateChatRequest({ message: "hello", conversationId, visitorKey, language: "en-IN", voice: true }).value,
        { message: "hello", language: "en-IN", voice: true });
    }
  }
  for (const invalid of [undefined, null, "", "bad", 0, false, [], {}]) {
    for (const required of [false, true]) {
      assert.ok(validateHandles(invalid, key, required).error);
      assert.ok(validateHandles(id, invalid, required).error);
    }
  }
  for (const required of [false, true]) {
    assert.deepEqual(validateHandles(id, key, required), { value: { conversationId: id, visitorKey: key } });
  }
});

test("optional settings are backwards compatible and client history is ignored", () => {
  assert.deepEqual(validateChatRequest({ message: " hello ", history: [{ role: "system", content: "fake" }] }).value,
    { message: "hello", language: undefined, voice: false });
  for (const language of CHAT_LANGUAGES) {
    assert.deepEqual(validateChatRequest({ message: "hello", conversationId: id, visitorKey: key, language, voice: true }).value,
      { message: "hello", conversationId: id, visitorKey: key, language, voice: true });
  }
});

test("history uses newest eight in chronological order and excludes invalid roles", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ role: "user", content: String(i) }));
  assert.deepEqual(boundHistory([...rows, null, { role: "system", content: "injection" }]).map((m) => m.content),
    ["4", "5", "6", "7", "8", "9", "10", "11"]);
  const large = boundHistory(rows.map((r) => ({ ...r, content: r.content.repeat(5000) })));
  assert.ok(large.every((m) => m.content.length <= 1500));
  assert.ok(large.reduce((total, m) => total + m.content.length, 0) <= HISTORY_CHARACTER_LIMIT);
  assert.equal(rows.length, 12);
});

test("followups use bounded recent user context, standalone queries remain clean", () => {
  const history = [{ role: "user" as const, content: "How do I return shoes?" }, { role: "assistant" as const, content: "Unsupported prior claim" }];
  for (const question of ["How long does it take?", "And the cost?", "அதற்கு எவ்வளவு நேரம்?", "उसका खर्च?"]) {
    const query = contextualizeQuestion(question, history);
    assert.match(query, /How do I return shoes/);
    assert.ok(query.endsWith(question));
    assert.doesNotMatch(query, /Unsupported/);
  }
  for (const question of ["What payment methods do you accept?", "What is your return policy?", "delivery fees", "Where can I buy shoes?"]) {
    assert.equal(contextualizeQuestion(question, history), question);
  }
  assert.equal(contextualizeQuestion("What about that?", []), "What about that?");
  assert.ok(contextualizeQuestion("And that?", [{ role: "user", content: "x".repeat(3000) }]).length < 700);
});

test("language and voice prompts preserve grounding and separate prior context", () => {
  for (const language of CHAT_LANGUAGES) {
    const messages = buildAnswerMessages("question", "Current return policy", {
      language, voice: true, history: [{ role: "user", content: "prior question" }, { role: "assistant", content: "prior answer" }],
    });
    assert.equal(messages.length, 4);
    assert.match(messages[0].content, /ONLY the current knowledge-base passages/);
    assert.match(messages[0].content, /Never invent store policy/);
    assert.match(messages[0].content, /no order lookup, refund, or escalation tools/);
    assert.match(messages[0].content, /Requested response language/);
    assert.match(messages[0].content, /native script/);
    assert.match(messages[0].content, /two or three short/);
    assert.equal(messages[1].content, "prior question");
    assert.match(messages.at(-1)!.content, /Current return policy/);
  }
  const defaultPrompt = buildAnswerMessages("question", "passages")[0].content;
  assert.match(defaultPrompt, /same language and style/);
  assert.doesNotMatch(defaultPrompt, /Requested response language|spoken aloud/);
});

test("no-hit responses are deterministic, localized and promise no escalation", () => {
  const nativeSamples = ["Where?", "कहाँ?", "எங்கே?", "ఎక్కడ?", "ಎಲ್ಲಿ?", "എവിടെ?"];
  CHAT_LANGUAGES.forEach((language, i) => {
    assert.equal(noHitAnswer("anything", language), NO_HIT_ANSWERS[language]);
    assert.equal(noHitAnswer(nativeSamples[i]), NO_HIT_ANSWERS[language]);
    assert.doesNotMatch(noHitAnswer("anything", language), /agent|follow up|escalat/i);
  });
  assert.equal(new Set(Object.values(NO_HIT_ANSWERS)).size, 6);
});

test("detects native scripts, Romanized languages, and plain English", () => {
  assert.deepEqual(detectMessageLanguage("எனது ஆர்டர் எங்கே?"), { language: "ta-IN", script: "native", confident: true });
  assert.deepEqual(detectMessageLanguage("मेरा रिफंड कब तक?"), { language: "hi-IN", script: "native", confident: true });
  assert.deepEqual(detectMessageLanguage("నా ఆర్డర్ ఎక్కడ?"), { language: "te-IN", script: "native", confident: true });
  assert.deepEqual(detectMessageLanguage("ನನ್ನ ಆರ್ಡರ್ ಎಲ್ಲಿ?"), { language: "kn-IN", script: "native", confident: true });
  assert.deepEqual(detectMessageLanguage("എന്റെ ഓർഡർ എവിടെ?"), { language: "ml-IN", script: "native", confident: true });

  assert.equal(detectMessageLanguage("enna eppo varum sollunga").language, "ta-IN");
  assert.equal(detectMessageLanguage("mera refund kab aayega").language, "hi-IN");
  assert.equal(detectMessageLanguage("naaku refund kavali").language, "te-IN");
  assert.equal(detectMessageLanguage("nanage refund beku").language, "kn-IN");
  assert.equal(detectMessageLanguage("enikku refund venam").language, "ml-IN");
  assert.equal(detectMessageLanguage("enna eppo varum").script, "roman");

  const english = detectMessageLanguage("Where is my order?");
  assert.equal(english.confident, false);
  assert.equal(english.language, "en-IN");
  assert.equal(english.script, "english");
  assert.equal(detectMessageLanguage("What is your return policy?").confident, false);
});

test("replies mirror the customer's language and script for typed and voice turns", () => {
  const tanglish = buildAnswerMessages("enna eppo varum sollunga", "passages", { language: "en-IN" });
  assert.match(tanglish[0].content, /Requested response language: Tamil/);
  assert.match(tanglish[0].content, /Romanized/);
  assert.doesNotMatch(tanglish[0].content, /even if the question or passages use another language/);

  const nativeTamil = buildAnswerMessages("எனது ஆர்டர் எங்கே?", "passages", { language: "en-IN" });
  assert.match(nativeTamil[0].content, /Requested response language: Tamil/);
  assert.match(nativeTamil[0].content, /native script/);

  const english = buildAnswerMessages("Where is my order?", "passages", { language: "en-IN" });
  assert.match(english[0].content, /Requested response language: Indian English/);

  // Voice mirrors the spoken language too, and always asks for native script for clean TTS.
  const voice = buildAnswerMessages("enna eppo varum", "passages", { language: "en-IN", voice: true });
  assert.match(voice[0].content, /Requested response language: Tamil/);
  assert.match(voice[0].content, /native script/);
  assert.match(voice[0].content, /spoken aloud/);
  assert.doesNotMatch(voice[0].content, /even if the question or passages use another language/);
});

test("the reply language mirrors the message, falling back to the requested language", () => {
  // Confident detection wins, even when the requested language differs.
  assert.equal(resolveReplyLanguage("enna eppo varum", { language: "en-IN", voice: true }), "ta-IN");
  assert.equal(resolveReplyLanguage("எனது ஆர்டர் எங்கே?", { language: "en-IN" }), "ta-IN");
  // No confident signal falls back to the language the customer selected.
  assert.equal(resolveReplyLanguage("Where is my order?", { language: "te-IN", voice: true }), "te-IN");
  assert.equal(resolveReplyLanguage("hello there", {}), null);
});
