import { createAdminClient } from "../supabase/admin";
import { digest, embedTexts } from "../embeddings";
import { cleanText } from "./clean";
import { extractText, isSupportedMime, mimeFromFilename } from "./extract";
import { chunkText } from "./chunk";

export interface IngestOptions {
  // dryRun: run the full pipeline but do NOT write to the database.
  dryRun?: boolean;
  maxChars?: number;
}

export type IngestStatus = "ready" | "duplicate" | "failed";

export interface IngestResult {
  status: IngestStatus;
  documentId?: string;
  chunkCount: number;
  dimensions?: number;
  model?: string;
  error?: string;
}

function fail(error: string): IngestResult {
  return { status: "failed", chunkCount: 0, error };
}

// Core knowledge-base ingestion: extract -> clean -> chunk -> embed -> store.
// Kept independent of any UI and of the chat/RAG retrieval path.
export async function ingestDocument(
  input: { name: string; buffer: Buffer; mime?: string },
  options: IngestOptions = {},
): Promise<IngestResult> {
  const mime = input.mime ?? mimeFromFilename(input.name);
  if (!isSupportedMime(mime)) {
    return fail(`Unsupported file type '${input.name}' (supported: PDF, TXT, MD)`);
  }

  const raw = await extractText(input.buffer, mime);
  const content = cleanText(raw);
  if (!content) return fail(`'${input.name}' produced no readable text`);

  const hash = digest(content);
  const chunks = chunkText(content, { maxChars: options.maxChars });

  if (options.dryRun) {
    return { status: "ready", chunkCount: chunks.length };
  }

  const supabase = createAdminClient();
  const embeddingModel = process.env.EMBEDDING_MODEL || "BAAI/bge-m3";

  // Duplicate protection: same cleaned text = same hash = already indexed.
  // A record is only a duplicate if it was indexed with the CURRENT embedding
  // model; a FAILED record or one indexed with an older model gets wiped and
  // re-indexed (its chunks/embeddings cascade-delete).
  const { data: existing } = await supabase
    .from("documents")
    .select("id, status, embedding_model")
    .eq("content_hash", hash)
    .maybeSingle();
  if (existing?.status === "ready" && existing.embedding_model === embeddingModel) {
    return {
      status: "duplicate",
      documentId: existing.id,
      chunkCount: 0,
    };
  }
  if (existing) {
    const { error: wipeError } = await supabase
      .from("documents")
      .delete()
      .eq("id", existing.id);
    if (wipeError) return fail(`Could not replace failed record: ${wipeError.message}`);
  }

  const { data: doc, error: docError } = await supabase
    .from("documents")
    .insert({
      name: input.name,
      mime_type: mime,
      status: "processing",
      content_hash: hash,
      embedding_model: embeddingModel,
    })
    .select("id")
    .single();

  if (docError || !doc) {
    return fail(`Could not create document record: ${docError?.message}`);
  }

  try {
    const { vectors, model, dimensions } = await embedTexts(
      chunks.map((c) => c.content),
    );

    const { data: insertedChunks, error: chunkError } = await supabase
      .from("document_chunks")
      .insert(chunks.map((c) => ({ document_id: doc.id, seq: c.seq, content: c.content })))
      .select("id, seq");

    if (chunkError || !insertedChunks) throw new Error(chunkError?.message || "chunk insert failed");

    const idBySeq = new Map<number, string>(
      insertedChunks.map((row) => [Number(row.seq), String(row.id)]),
    );

    const { error: embeddingError } = await supabase
      .from("document_embeddings")
      .insert(
        chunks.map((c, i) => ({
          chunk_id: idBySeq.get(c.seq),
          model,
          dimensions,
          embedding: vectors[i],
        })),
      );

    if (embeddingError) throw new Error(embeddingError.message);

    await supabase
      .from("documents")
      .update({
        status: "ready",
        chunk_count: chunks.length,
        indexed_at: new Date().toISOString(),
        error_message: null,
      })
      .eq("id", doc.id);

    return {
      status: "ready",
      documentId: doc.id,
      chunkCount: chunks.length,
      dimensions,
      model,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown ingestion error";
    await supabase
      .from("documents")
      .update({ status: "failed", error_message: message })
      .eq("id", doc.id);
    return { status: "failed", documentId: doc.id, chunkCount: chunks.length > 0 ? chunks.length : 0, error: message };
  }
}