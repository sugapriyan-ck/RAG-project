import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reports which server voice capabilities are configured. Returns booleans
 * only, never the key itself, so the client can offer the server engine only
 * when Sarvam is actually available.
 */
export function GET() {
  const configured = Boolean(process.env.SARVAM_API_KEY);
  return NextResponse.json(
    { speechToText: configured, textToSpeech: configured, languages: ["en-IN", "hi-IN", "ta-IN", "te-IN", "kn-IN", "ml-IN"] },
    { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=300" } },
  );
}
