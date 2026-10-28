import assert from "node:assert/strict";
import test from "node:test";
import { clearEmbeddingCache, embedQuery, normalizeEmbeddingQuery } from "./index";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  clearEmbeddingCache();
  globalThis.fetch = originalFetch;
  delete process.env.EMBEDDING_CACHE_TTL_MS;
  delete process.env.EMBEDDING_CACHE_MAX_ENTRIES;
  delete process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_DIMENSIONS;
  delete process.env.OPENROUTER_API_KEY;
});

function response(vector: number[]) {
  return new Response(JSON.stringify({ data: [{ embedding: vector }], model: "test-model" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("normalizes only surrounding and repeated whitespace", () => {
  assert.equal(normalizeEmbeddingQuery("  hello\n\tworld  "), "hello world");
  assert.equal(normalizeEmbeddingQuery("hello WORLD"), "hello WORLD");
});

test("caches successful query vectors by normalized query and model/dimensions", async () => {
  process.env.EMBEDDING_DIMENSIONS = "3";
  process.env.EMBEDDING_MODEL = "test-model";
  process.env.OPENROUTER_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return response([1, 2, 3]);
  };

  assert.deepEqual(await embedQuery("  return\n policy "), [1, 2, 3]);
  assert.deepEqual(await embedQuery("return policy"), [1, 2, 3]);
  assert.equal(calls, 1);

  process.env.EMBEDDING_MODEL = "another-model";
  await embedQuery("return policy");
  assert.equal(calls, 2);
});

test("does not cache failed embedding requests", async () => {
  process.env.EMBEDDING_DIMENSIONS = "3";
  process.env.OPENROUTER_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("provider unavailable", { status: 503 });
  };

  await assert.rejects(() => embedQuery("retry me"));
  await assert.rejects(() => embedQuery("retry me"));
  assert.equal(calls, 6); // three provider attempts per call, with no cache entry
});

test("expires cached vectors at the configured TTL", async () => {
  process.env.EMBEDDING_DIMENSIONS = "3";
  process.env.EMBEDDING_CACHE_TTL_MS = "1";
  process.env.OPENROUTER_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return response([1, 2, 3]);
  };

  await embedQuery("short ttl");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await embedQuery("short ttl");
  assert.equal(calls, 2);
});
