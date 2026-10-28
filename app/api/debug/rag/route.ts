import { NextRequest, NextResponse } from "next/server";
import { answerQuestion } from "../../../../lib/rag/answer";

export const dynamic = "force-dynamic";

// Development-only diagnostic. In production set RAG_DEBUG=true explicitly.
const DEBUG_ENABLED =
  process.env.NODE_ENV === "development" || process.env.RAG_DEBUG === "true";

export async function GET(request: NextRequest) {
  if (!DEBUG_ENABLED) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const question = request.nextUrl.searchParams.get("q")?.trim();
  if (!question) {
    return NextResponse.json(
      { error: 'Missing query parameter "q".' },
      { status: 400 },
    );
  }
  try {
    const result = await answerQuestion(question);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}