import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "../../../lib/supabase/admin";
import { answerQuestion } from "../../../lib/rag/answer";
import { retrieveChunks, type RetrievedChunk } from "../../../lib/rag/retrieve";
import { completeChatStream } from "../../../lib/llm";
import { boundHistory, contextualizeQuestion, HISTORY_LIMIT } from "../../../lib/chat/context";
import { buildAnswerMessages, noHitAnswer, resolveReplyLanguage } from "../../../lib/chat/prompt";
import { validateChatRequest, validateHandles, type ChatLanguage, type ConversationHandles } from "../../../lib/chat/validation";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Keep the public guest endpoint bounded even when a caller does not send a
// Content-Length header. This is deliberately process-local: deployments with
// multiple instances should put an equivalent limit at their edge as well.
const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
const requestCounts = new Map<string, { startedAt: number; count: number }>();

function requestAddress(request: NextRequest) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || "unknown";
}

function rateLimit(request: NextRequest) {
  const now = Date.now();
  const key = requestAddress(request);
  const previous = requestCounts.get(key);
  const entry = !previous || now - previous.startedAt >= RATE_LIMIT_WINDOW_MS
    ? { startedAt: now, count: 1 }
    : { ...previous, count: previous.count + 1 };
  requestCounts.set(key, entry);
  // Avoid retaining inactive addresses indefinitely in a long-lived server.
  if (requestCounts.size > 10_000) {
    for (const [address, item] of requestCounts) {
      if (now - item.startedAt >= RATE_LIMIT_WINDOW_MS) requestCounts.delete(address);
    }
  }
  if (entry.count > RATE_LIMIT_MAX) {
    return NextResponse.json({ error: "Please wait a moment before sending another message." }, {
      status: 429,
      headers: { "Retry-After": String(Math.ceil((RATE_LIMIT_WINDOW_MS - (now - entry.startedAt)) / 1000)) },
    });
  }
  return null;
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function payloadTooLarge() {
  return NextResponse.json({ error: "Request body is too large" }, { status: 413 });
}

function serverError(handles: ConversationHandles = {}) {
  return NextResponse.json(
    { error: "We couldn't complete your request. Please try again.", ...handles },
    { status: 500 },
  );
}

function unauthorized() {
  return NextResponse.json(
    { error: "This conversation link no longer works. Please start a new chat." },
    { status: 403 },
  );
}

function safePersistenceLog(label: string) {
  // Provider/DB error bodies may contain private values. Keep the log useful
  // for locating the failed write without echoing untrusted error payloads.
  console.error(`[chat] ${label} persistence failed`);
}

function sourceMetadata(retrieval: RetrievedChunk[]) {
  return retrieval.map((s) => ({
    documentId: s.documentId,
    documentName: s.documentName,
    similarity: Number(s.similarity.toFixed(3)),
  }));
}

function eventLine(event: Record<string, unknown>) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function prepareTypedAnswer(
  question: string,
  options: { history: ReturnType<typeof boundHistory>; language?: ChatLanguage },
  signal: AbortSignal,
) {
  const language = resolveReplyLanguage(question, options);
  const retrieval = await retrieveChunks(contextualizeQuestion(question, options.history));
  if (retrieval.length === 0) {
    return {
      chunks: (async function* () { yield noHitAnswer(question, language ?? undefined); })(),
      usedKnowledgeBase: false,
      retrieval,
      language,
    };
  }
  const context = retrieval
    .map((chunk, i) => `[Passage ${i + 1} — ${chunk.documentName}]\n${chunk.content}`)
    .join("\n\n");
  const chunks = await completeChatStream(
    buildAnswerMessages(question, context, { history: options.history, language: language ?? undefined }),
    { maxTokens: 512, signal },
  );
  return { chunks, usedKnowledgeBase: true, retrieval, language };
}

function persistAnswer(args: {
  supabase: ReturnType<typeof createAdminClient>;
  conversationId: string;
  visitorKey?: string;
  question: string;
  answer: string;
  input: { voice: boolean; language?: string };
  usedKnowledgeBase: boolean;
  retrieval: RetrievedChunk[];
  language: string | null;
}) {
  const sources = sourceMetadata(args.retrieval);
  const assistantMessage: Record<string, unknown> = {
    conversation_id: args.conversationId,
    role: "assistant",
    content: args.answer,
    used_rag: args.usedKnowledgeBase,
    retrieval_success: args.retrieval.length > 0,
    sources,
    style: args.input.voice ? "voice" : "text",
  };
  if (args.language ?? args.input.language) assistantMessage.language = args.language ?? args.input.language;

  const assistantWrite = args.supabase.from("messages").insert(assistantMessage);
  const conversationWrite = args.supabase.from("conversations")
    .update({ last_message_at: new Date().toISOString(), ...(args.input.language ? { language: args.input.language } : {}) })
    .eq("id", args.conversationId);
  const writes: PromiseLike<unknown>[] = [
    assistantWrite.then(({ error }) => {
      if (error) throw error;
    }),
    conversationWrite.then(({ error }) => { if (error) throw error; }),
  ];
  if (!args.usedKnowledgeBase) {
    const auditWrite = args.supabase.from("support_events").insert({
      event_type: "unanswered_question",
      conversation_id: args.conversationId,
      payload: { question: args.question },
    });
    writes.push(auditWrite.then(({ error }) => { if (error) throw error; }));
  }
  void Promise.allSettled(writes).then((results) => {
    results.forEach((result, index) => {
      if (result.status === "rejected") safePersistenceLog(index === 0 ? "assistant message" : index === 1 ? "conversation metadata" : "unanswered-question audit");
    });
  });
}

// Verify the visitor holds the key for this conversation.
// Guest chat uses the service-role client (RLS-bypassing), so the visitor_key
// check happens here, server-side — a random key never reads another chat.
async function verifyConversation(args: {
  conversationId?: string;
  visitorKey?: string;
}) {
  if ((args.conversationId && !args.visitorKey) || (!args.conversationId && args.visitorKey)) {
    return { error: badRequest("conversationId and visitorKey must be provided together") };
  }
  if (!args.conversationId || !args.visitorKey) return {}; // new conversation

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("conversations")
    .select("id, status")
    .eq("id", args.conversationId)
    .eq("visitor_key", args.visitorKey)
    .maybeSingle();

  if (error) return { error: serverError(args) };
  // Older deployments/tests may not project status; only reject an explicit
  // non-active state while preserving compatibility with that response shape.
  if (!data || (data.status !== undefined && data.status !== "active")) return { error: unauthorized() };
  return { row: data };
}

export async function GET(request: NextRequest) {
  const validated = validateHandles(
    request.nextUrl.searchParams.get("conversationId") ?? undefined,
    request.nextUrl.searchParams.get("visitorKey") ?? undefined,
    true,
  );
  if (validated.error) return badRequest(validated.error);
  const handles = validated.value!;
  try {
    const { row, error } = await verifyConversation(handles);
    if (error) return error;
    if (!row) return badRequest("conversationId and visitorKey are required");
    const conversationIdForQuery = String(row.id);

    const supabase = createAdminClient();
    const { data: messages, error: messagesError } = await supabase
      .from("messages")
      .select("role, content, created_at")
      .eq("conversation_id", conversationIdForQuery)
      .order("created_at", { ascending: false })
      .limit(100);

    if (messagesError) return serverError(handles);

    return NextResponse.json({
      conversationId: row.id,
      messages: (messages ?? []).reverse(),
    });
  } catch {
    return serverError(handles);
  }
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    const declaredLength = request.headers.get("content-length");
    if (declaredLength && Number(declaredLength) > MAX_BODY_BYTES) {
      return payloadTooLarge();
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return payloadTooLarge();
    }
    body = JSON.parse(raw);
  } catch {
    return badRequest("Invalid JSON body");
  }

  const validated = validateChatRequest(body);
  if (validated.error) return badRequest(validated.error);
  const limited = rateLimit(request);
  if (limited) return limited;
  const input = validated.value!;
  const question = input.message;
  let conversationId = input.conversationId;
  let visitorKey = input.visitorKey;
  try {
    const supabase = createAdminClient();
    const { row: verified, error } = await verifyConversation({
      conversationId,
      visitorKey,
    });
    if (error) return error;

    // First message -> create the conversation and hand the visitor its key.
    if (!conversationId) {
      const { data: created, error: createError } = await supabase
        .from("conversations")
        .insert({ status: "active", title: question.slice(0, 60) })
        .select("id, visitor_key")
        .single();
      if (createError || !created) return serverError();
      conversationId = created.id;
      visitorKey = created.visitor_key;
    }

    // Read only after the visitor key was verified, and before inserting this turn.
    // The browser cannot supply or override model history.
    let history = boundHistory([]);
    if (verified) {
      const { data: recent, error: historyError } = await supabase
        .from("messages")
        .select("role, content")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(HISTORY_LIMIT);
      if (historyError) return serverError({ conversationId, visitorKey });
      history = boundHistory((recent ?? []).reverse());
    }

    const userMessage: Record<string, unknown> = {
      conversation_id: conversationId,
      role: "user",
      content: question,
      style: input.voice ? "voice" : "text",
    };
    if (input.language) userMessage.language = input.language;
    const { error: userMessageError } = await supabase.from("messages").insert(userMessage);
    if (userMessageError) return serverError({ conversationId, visitorKey });

    if (input.voice) {
      const result = await answerQuestion(question, { history, language: input.language, voice: true });
      const sourcesJson = sourceMetadata(result.retrieval);
      persistAnswer({ supabase, conversationId: conversationId!, visitorKey, question, answer: result.answer, input, usedKnowledgeBase: result.usedKnowledgeBase, retrieval: result.retrieval, language: result.language });
      return NextResponse.json({ answer: result.answer, usedKnowledgeBase: result.usedKnowledgeBase, sources: sourcesJson, language: result.language, conversationId, visitorKey });
    }

    // Retrieval and the provider response headers are ready before the stream
    // is returned, so no token is emitted before auth, history and user writes.
    const prepared = await prepareTypedAnswer(question, { history, language: input.language }, request.signal);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let answer = "";
        try {
          for await (const token of prepared.chunks) {
            answer += token;
            controller.enqueue(encoder.encode(eventLine({ type: "token", token })));
          }
          if (!answer) throw new Error("The model returned an empty response");
          const sources = sourceMetadata(prepared.retrieval);
          persistAnswer({ supabase, conversationId: conversationId!, visitorKey, question, answer, input, usedKnowledgeBase: prepared.usedKnowledgeBase, retrieval: prepared.retrieval, language: prepared.language });
          controller.enqueue(encoder.encode(eventLine({ type: "done", usedKnowledgeBase: prepared.usedKnowledgeBase, sources, language: prepared.language, conversationId, visitorKey })));
          controller.close();
        } catch {
          controller.enqueue(encoder.encode(eventLine({ type: "error", error: "We couldn't complete your request. Please try again." })));
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
  } catch {
    // Keep the conversation handle so the visitor can retry same-thread.
    return serverError({ conversationId, visitorKey });
  }
}
