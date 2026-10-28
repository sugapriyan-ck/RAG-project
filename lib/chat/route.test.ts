import assert from "node:assert/strict";
import { after, test } from "node:test";
import { NextRequest } from "next/server";
import { GET, POST } from "../../app/api/chat/route";
import { parseOpenRouterSse } from "../llm";

const id = "11111111-1111-4111-8111-111111111111";
const key = "22222222-2222-4222-8222-222222222222";
const env = { NEXT_PUBLIC_SUPABASE_URL: "https://offline.example", SUPABASE_SERVICE_ROLE_KEY: "offline-test-value", OPENROUTER_API_KEY: "offline-test-value", EMBEDDING_DIMENSIONS: "1", LLM_MODEL: "offline-test-model" };
const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
Object.assign(process.env, env);
after(() => { for (const name of Object.keys(env)) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const post = (body: unknown) => new NextRequest("http://localhost/api/chat", { method: "POST", body: JSON.stringify(body) });
const flushPersistence = () => new Promise<void>((resolve) => setImmediate(resolve));

test("OpenRouter SSE parser yields JSON delta text and stops at DONE", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n"));
      controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\ndata: [DONE]\n\n"));
      controller.close();
    },
  });
  const chunks: string[] = [];
  for await (const chunk of parseOpenRouterSse(stream)) chunks.push(chunk);
  assert.deepEqual(chunks, ["Hel", "lo"]);
});

test("invalid POST and GET fail before any network or DB access", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network call"); });
  for (const body of [null, { message: 1 }, { message: "ok", voice: "true" }, { message: "ok", language: "fr" }, { message: "ok", conversationId: id },
    { message: "ok", conversationId: null, visitorKey: key }, { message: "ok", conversationId: id, visitorKey: null },
    { message: "ok", conversationId: "bad", visitorKey: key }]) {
    assert.equal((await POST(post(body))).status, 400);
  }
  assert.equal((await POST(new NextRequest("http://localhost/api/chat", { method: "POST", body: "{" }))).status, 400);
  assert.equal((await GET(new NextRequest("http://localhost/api/chat?conversationId=bad&visitorKey=bad"))).status, 400);
  for (const query of ["", "?conversationId=null&visitorKey=null", `?conversationId=${id}`, `?visitorKey=${key}`]) {
    assert.equal((await GET(new NextRequest(`http://localhost/api/chat${query}`))).status, 400);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("browser null handles create a conversation and return a voice reply", async (t) => {
  const calls: string[] = [];
  const answer = "Returns take five days.";
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push(`${init?.method} ${url.pathname}`);
    if (url.pathname.endsWith("/conversations") && init?.method === "POST") {
      assert.deepEqual(body, { status: "active", title: "How long do returns take?" });
      return json({ id, visitor_key: key });
    }
    if (url.pathname.endsWith("/messages") && init?.method === "POST") {
      assert.equal(body.conversation_id, id);
      assert.equal(body.content, body.role === "user" ? "How long do returns take?" : answer);
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/embeddings")) return json({ data: [{ embedding: [1] }] });
    if (url.pathname.endsWith("/match_documents")) return json([{ chunk_id: "chunk", document_id: "doc", document_name: "Returns", chunk_content: answer, similarity: 0.99 }]);
    if (url.pathname.endsWith("/completions")) {
      assert.match(body.messages[0].content, /English/);
      assert.match(body.messages[0].content, /spoken aloud/);
      assert.equal(body.messages.length, 2);
      return json({ choices: [{ message: { content: answer } }] });
    }
    assert.ok(url.pathname.endsWith("/conversations") && init?.method === "PATCH");
    assert.equal(url.searchParams.get("id"), `eq.${id}`);
    return new Response(null, { status: 204 });
  });
  const response = await POST(post({ message: "How long do returns take?", conversationId: null, visitorKey: null, language: "en-IN", voice: true }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  const body = await response.json();
  assert.equal(body.conversationId, id);
  assert.equal(body.visitorKey, key);
  assert.equal(body.answer, answer);
  assert.equal(body.usedKnowledgeBase, true);
  await flushPersistence();
  assert.equal(calls[0], "POST /rest/v1/conversations");
  assert.equal(calls.filter((call) => call === "POST /rest/v1/conversations").length, 1);
  assert.equal(calls.filter((call) => call === "POST /rest/v1/messages").length, 2);
  assert.equal(calls.filter((call) => call.endsWith("/completions")).length, 1);
});

test("typed chat returns SSE events while voice keeps JSON", async (t) => {
  const encoder = new TextEncoder();
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname.endsWith("/conversations") && init?.method === "POST") return json({ id, visitor_key: key });
    if (url.pathname.endsWith("/messages") && init?.method === "POST") return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/embeddings")) return json({ data: [{ embedding: [1] }] });
    if (url.pathname.endsWith("/match_documents")) return json([{ chunk_id: "chunk", document_id: "doc", document_name: "Returns", chunk_content: "Five days", similarity: 0.9 }]);
    if (url.pathname.endsWith("/completions")) {
      assert.equal(body.stream, true);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"Five\"}}]}\n\n"));
          controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\" days\"}}]}\n\ndata: [DONE]\n\n"));
          controller.close();
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response(null, { status: 204 });
  });
  const response = await POST(post({ message: "When?" }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  const text = await response.text();
  assert.match(text, /"type":"token"/);
  assert.match(text, /"type":"done"/);
  assert.match(text, /"conversationId":"11111111-1111-4111-8111-111111111111"/);
  await flushPersistence();
});

test("unauthorized visitors cannot load history or write messages", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    assert.ok(url.includes("/conversations?"));
    assert.ok(url.includes(`visitor_key=eq.${key}`));
    return json(null);
  });
  assert.equal((await POST(post({ message: "hello", conversationId: id, visitorKey: key }))).status, 403);
  assert.equal(calls.length, 1);
});

test("GET fetches latest 100 and returns chronological history", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/conversations")) return json({ id });
    assert.equal(url.searchParams.get("order"), "created_at.desc");
    assert.equal(url.searchParams.get("limit"), "100");
    return json([{ role: "assistant", content: "newest" }, { role: "user", content: "older" }]);
  });
  const response = await GET(new NextRequest(`http://localhost/api/chat?conversationId=${id}&visitorKey=${key}`));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).messages.map((m: { content: string }) => m.content), ["older", "newest"]);
});

test("no-hit followup retrieves server history, localizes and preserves audit writes", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname.endsWith("/embeddings")) {
      const body = JSON.parse(String(init?.body));
      assert.match(body.input[0], /return shoes/);
      assert.doesNotMatch(body.input[0], /CLIENT FAKE/);
      return json({ data: [{ embedding: [1] }] });
    }
    if (url.pathname.endsWith("/match_documents")) return json([]);
    if (url.pathname.endsWith("/conversations") && init?.method === "GET") return json({ id });
    if (url.pathname.endsWith("/messages") && init?.method === "GET") {
      assert.equal(calls[0], "GET /rest/v1/conversations");
      assert.equal(url.searchParams.get("limit"), "8");
      assert.equal(url.searchParams.get("order"), "created_at.desc");
      return json([{ role: "assistant", content: "previous answer" }, { role: "user", content: "How do I return shoes?" }]);
    }
    if (init?.method === "POST" || init?.method === "PATCH") return new Response(null, { status: 204 });
    throw new Error(`Unexpected offline request: ${url.pathname}`);
  });
  const response = await POST(post({ message: "How long does it take?", conversationId: id, visitorKey: key, language: "ta-IN", voice: true, history: [{ role: "user", content: "CLIENT FAKE" }] }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.conversationId, id);
  assert.equal(body.visitorKey, key);
  assert.equal(body.usedKnowledgeBase, false);
  assert.match(body.answer, /[\u0b80-\u0bff]/u);
  await flushPersistence();
  assert.ok(calls.includes("POST /rest/v1/support_events"));
  assert.equal(calls.filter((call) => call === "POST /rest/v1/messages").length, 2);
  assert.ok(!calls.some((call) => call.includes("completions")));
});

test("new conversation handles survive downstream errors without leaking internals", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input).includes("/conversations?")) return json({ id, visitor_key: key });
    return json({ message: "internal database detail", code: "XX000" }, 400);
  });
  const response = await POST(post({ message: "hello" }));
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.conversationId, id);
  assert.equal(body.visitorKey, key);
  assert.doesNotMatch(body.error, /internal database detail|XX000/);
});

test("retrieval hit sends chronological server context and selected voice language in one completion", async (t) => {
  let completions = 0;
  let assistantSaved = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname.endsWith("/embeddings")) return json({ data: [{ embedding: [1] }] });
    if (url.pathname.endsWith("/match_documents")) return json([{ chunk_id: "chunk", document_id: "doc", document_name: "Returns", chunk_content: "Returns take five days.", similarity: 0.9876 }]);
    if (url.pathname.endsWith("/completions")) {
      completions++;
      assert.match(body.messages[0].content, /Hindi \(Devanagari script\)/);
      assert.match(body.messages[0].content, /spoken aloud/);
      assert.deepEqual(body.messages.slice(1, -1), [{ role: "user", content: "Return timing?" }, { role: "assistant", content: "Previous response" }]);
      assert.match(body.messages.at(-1).content, /Returns take five days/);
      assert.match(body.messages.at(-1).content, /How long does it take/);
      assert.equal(body.max_tokens, 160);
      return json({ choices: [{ message: { content: "वापसी में पाँच दिन लगते हैं।" } }] });
    }
    if (url.pathname.endsWith("/conversations") && init?.method === "GET") return json({ id });
    if (url.pathname.endsWith("/messages") && init?.method === "GET") return json([{ role: "assistant", content: "Previous response" }, { role: "user", content: "Return timing?" }]);
    if (url.pathname.endsWith("/messages") && body?.role === "assistant") {
      assistantSaved = true;
      assert.equal(body.used_rag, true);
      assert.equal(body.retrieval_success, true);
      assert.equal(body.sources[0].similarity, 0.988);
    }
    assert.ok(init?.method === "POST" || init?.method === "PATCH");
    assert.ok(!url.pathname.endsWith("/support_events"));
    return new Response(null, { status: 204 });
  });
  const response = await POST(post({ message: "How long does it take?", conversationId: id, visitorKey: key, language: "hi-IN", voice: true }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.answer, "वापसी में पाँच दिन लगते हैं।");
  assert.equal(body.usedKnowledgeBase, true);
  assert.equal(body.sources[0].documentName, "Returns");
  assert.equal(completions, 1);
  await flushPersistence();
  assert.ok(assistantSaved);
});

test("audit write failures return sanitized errors with conversation handles", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/conversations")) return json({ id, visitor_key: key });
    if (path.endsWith("/embeddings")) return json({ data: [{ embedding: [1] }] });
    if (path.endsWith("/match_documents")) return json([]);
    if (path.endsWith("/support_events")) return json({ message: "private audit error", code: "XX000" }, 400);
    assert.equal(init?.method, "POST");
    assert.ok(path.endsWith("/messages"));
    return new Response(null, { status: 204 });
  });
  const response = await POST(post({ message: "question", voice: true }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.conversationId, id);
  assert.equal(body.visitorKey, key);
  assert.match(body.answer, /couldn't find/i);
  await flushPersistence();
});
