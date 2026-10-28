import assert from "node:assert/strict";
import test from "node:test";
import { createSarvamSpeechToText, createSarvamTextToSpeech, SarvamError } from "./sarvam";

test("Sarvam adapters fail clearly when the server key is not configured", async () => {
  const saved = process.env.SARVAM_API_KEY;
  delete process.env.SARVAM_API_KEY;
  try {
    await assert.rejects(
      createSarvamSpeechToText().execute({ language: "en-IN", audio: new Uint8Array([1]) }),
      (error: unknown) => error instanceof SarvamError && error.status === 503,
    );
    await assert.rejects(
      createSarvamTextToSpeech().execute({ language: "en-IN", text: "Hello" }),
      (error: unknown) => error instanceof SarvamError && error.status === 503,
    );
  } finally {
    if (saved === undefined) delete process.env.SARVAM_API_KEY;
    else process.env.SARVAM_API_KEY = saved;
  }
});

test("Sarvam STT rejects empty and oversized audio before a network call", async () => {
  const saved = process.env.SARVAM_API_KEY;
  process.env.SARVAM_API_KEY = "test-only";
  try {
    await assert.rejects(
      createSarvamSpeechToText().execute({ language: "ta-IN", audio: new Uint8Array() }),
      (error: unknown) => error instanceof SarvamError && error.status === 413,
    );
  } finally {
    if (saved === undefined) delete process.env.SARVAM_API_KEY;
    else process.env.SARVAM_API_KEY = saved;
  }
});

test("Sarvam TTS validates supported language and text length", async () => {
  const saved = process.env.SARVAM_API_KEY;
  process.env.SARVAM_API_KEY = "test-only";
  try {
    await assert.rejects(
      createSarvamTextToSpeech().execute({ language: "fr-FR", text: "Hello" }),
      (error: unknown) => error instanceof SarvamError && error.status === 400,
    );
    await assert.rejects(
      createSarvamTextToSpeech().execute({ language: "hi-IN", text: "x".repeat(2501) }),
      (error: unknown) => error instanceof SarvamError && error.status === 400,
    );
  } finally {
    if (saved === undefined) delete process.env.SARVAM_API_KEY;
    else process.env.SARVAM_API_KEY = saved;
  }
});
