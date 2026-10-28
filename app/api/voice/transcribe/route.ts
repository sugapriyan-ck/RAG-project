import { NextRequest, NextResponse } from "next/server";
import { createSarvamSpeechToText, SarvamError } from "../../../../lib/voice/sarvam";
import { voiceRateLimit } from "../../../../lib/voice/route-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MIME_TYPES = new Set([
  "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/aac",
  "audio/flac", "audio/ogg", "audio/opus", "audio/mp4", "audio/webm",
]);

function errorResponse(error: unknown) {
  if (error instanceof SarvamError) {
    const status = error.status === 413 ? 413 : error.status === 429 ? 429 : error.status && error.status >= 400 && error.status < 500 ? 400 : 502;
    return NextResponse.json({ error: status === 429 ? "Voice service is busy. Please try again shortly." : status === 400 ? "This audio request could not be processed." : "Speech recognition is temporarily unavailable." }, { status });
  }
  return NextResponse.json({ error: "Speech recognition is temporarily unavailable." }, { status: 502 });
}

export async function POST(request: NextRequest) {
  const limited = voiceRateLimit(request);
  if (limited) return limited;
  const type = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (!MIME_TYPES.has(type)) return NextResponse.json({ error: "Send a supported audio MIME type." }, { status: 415 });
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_AUDIO_BYTES) return NextResponse.json({ error: "Audio is too large." }, { status: 413 });
  try {
    const buffer = new Uint8Array(await request.arrayBuffer());
    if (!buffer.byteLength || buffer.byteLength > MAX_AUDIO_BYTES) return NextResponse.json({ error: "Audio is empty or too large." }, { status: 413 });
    const language = request.headers.get("x-voice-language") ?? "en-IN";
    const result = await createSarvamSpeechToText().execute({ audio: buffer, mimeType: type, language, signal: request.signal });
    return NextResponse.json({ text: result.text, language: result.language, confidence: result.confidence });
  } catch (error) {
    return errorResponse(error);
  }
}
