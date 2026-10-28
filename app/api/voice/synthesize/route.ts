import { NextRequest, NextResponse } from "next/server";
import { createSarvamTextToSpeech, SarvamError } from "../../../../lib/voice/sarvam";
import { voiceRateLimit } from "../../../../lib/voice/route-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

const MAX_TEXT_LENGTH = 2500;

function errorResponse(error: unknown) {
  if (error instanceof SarvamError) {
    const status = error.status === 429 ? 429 : error.status && error.status >= 400 && error.status < 500 ? 400 : 502;
    return NextResponse.json({ error: status === 429 ? "Voice service is busy. Please try again shortly." : status === 400 ? "This speech request could not be processed." : "Speech synthesis is temporarily unavailable." }, { status });
  }
  return NextResponse.json({ error: "Speech synthesis is temporarily unavailable." }, { status: 502 });
}

export async function POST(request: NextRequest) {
  const limited = voiceRateLimit(request);
  if (limited) return limited;
  try {
    const body = await request.json() as { text?: unknown; language?: unknown };
    if (typeof body.text !== "string" || !body.text.trim() || body.text.length > MAX_TEXT_LENGTH) {
      return NextResponse.json({ error: "text is required and must be at most 2,500 characters." }, { status: 400 });
    }
    if (typeof body.language !== "string") return NextResponse.json({ error: "language is required." }, { status: 400 });
    const result = await createSarvamTextToSpeech().execute({ text: body.text, language: body.language, signal: request.signal });
    return new NextResponse(result.audio as Uint8Array<ArrayBuffer>, { status: 200, headers: { "Content-Type": result.mimeType, "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
