import { createHash } from "node:crypto";

const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
const DEFAULT_MODEL = "BAAI/bge-m3";
const MAX_BATCH = 32; // inputs per embedding request (free models rate-limit)
const MAX_RETRIES = 3;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CACHE_MAX_ENTRIES = 256;

interface CachedEmbedding {
  vector: number[];
  expiresAt: number;
}

// This cache is intentionally process-local: vectors are cheap to evict and
// must not become a second persistence layer for customer queries.
const queryEmbeddingCache = new Map<string, CachedEmbedding>();

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  dimensions: number;
}

function embedModel(): string {
  return process.env.EMBEDDING_MODEL || DEFAULT_MODEL;
}

function embeddingDimensions(): number {
  return Number(process.env.EMBEDDING_DIMENSIONS || 1024);
}

function cacheTtlMs(): number {
  const value = Number(process.env.EMBEDDING_CACHE_TTL_MS);
  return Number.isFinite(value) ? Math.max(0, value) : DEFAULT_CACHE_TTL_MS;
}

function cacheMaxEntries(): number {
  const value = Number(process.env.EMBEDDING_CACHE_MAX_ENTRIES);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : DEFAULT_CACHE_MAX_ENTRIES;
}

/** Normalize only transport-level differences; preserve query wording. */
export function normalizeEmbeddingQuery(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function queryCacheKey(text: string): string {
  const model = embedModel();
  const dimensions = embeddingDimensions();
  return digest(`${normalizeEmbeddingQuery(text)}\u0000${model}\u0000${dimensions}`);
}

function readCachedQueryEmbedding(key: string, now = Date.now()): number[] | undefined {
  const cached = queryEmbeddingCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= now) {
    queryEmbeddingCache.delete(key);
    return undefined;
  }
  // Map insertion order gives us a small LRU without an additional package.
  queryEmbeddingCache.delete(key);
  queryEmbeddingCache.set(key, cached);
  return [...cached.vector];
}

function writeCachedQueryEmbedding(key: string, vector: number[], now = Date.now()): void {
  const maxEntries = cacheMaxEntries();
  if (maxEntries === 0 || cacheTtlMs() === 0) return;
  queryEmbeddingCache.delete(key);
  queryEmbeddingCache.set(key, { vector: [...vector], expiresAt: now + cacheTtlMs() });
  while (queryEmbeddingCache.size > maxEntries) {
    const oldest = queryEmbeddingCache.keys().next().value;
    if (oldest === undefined) break;
    queryEmbeddingCache.delete(oldest);
  }
}

/** Test/diagnostic hook; clearing never affects persisted embeddings. */
export function clearEmbeddingCache(): void {
  queryEmbeddingCache.clear();
}

// Deterministic 32-hex hash so different module instances produce the same key.
export function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function requestEmbeddings(input: string[]): Promise<EmbeddingResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const model = embedModel();
  const res = await fetch(OPENROUTER_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Title": "RAG Support",
    },
    body: JSON.stringify({ model, input }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter embeddings ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    data?: { embedding: number[] }[];
    model?: string;
  };

  if (!json.data?.length || json.data.some((d) => !d.embedding?.length)) {
    throw new Error("OpenRouter embeddings returned no vectors");
  }

  const vectors = json.data.map((d) => d.embedding);
  const expected = embeddingDimensions();
  for (const v of vectors) {
    if (v.length !== expected) {
      throw new Error(
        `Embedding dimension mismatch: got ${v.length}, expected ${expected}. ` +
          `Run the embedding-alignment migration if you changed models.`,
      );
    }
  }

  return {
    vectors,
    model: json.model ?? model,
    dimensions: expected,
  };
}

export async function embedTexts(inputs: string[]): Promise<EmbeddingResult> {
  if (inputs.length === 0) return { vectors: [], model: embedModel(), dimensions: embeddingDimensions() };

  const vectors: number[][] = [];
  let model = embedModel();

  for (let i = 0; i < inputs.length; i += MAX_BATCH) {
    const batch = inputs.slice(i, i + MAX_BATCH);
    let attempt = 0;
    while (true) {
      try {
        const result = await requestEmbeddings(batch);
        vectors.push(...result.vectors);
        model = result.model;
        break;
      } catch (err) {
        attempt += 1;
        if (attempt >= MAX_RETRIES) throw err;
        const delay = 500 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  return {
    vectors,
    model,
    dimensions: vectors[0]?.length ?? embeddingDimensions(),
  };
}

// Embed a single query at retrieval time (Phase 4 uses this).
export async function embedQuery(text: string): Promise<number[]> {
  const key = queryCacheKey(text);
  const cached = readCachedQueryEmbedding(key);
  if (cached) return cached;

  // Only successful requests reach this write, so errors and malformed
  // provider responses are never retained.
  const { vectors } = await embedTexts([text]);
  const vector = vectors[0];
  if (!vector) throw new Error("Embedding provider returned no query vector");
  writeCachedQueryEmbedding(key, vector);
  return [...vector];
}
