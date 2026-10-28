import { createAdminClient } from "../supabase/admin";
import { embedQuery } from "../embeddings";

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  documentName: string;
  content: string;
  similarity: number;
}

export interface RetrieveOptions {
  topK?: number;
  threshold?: number;
}

const DEFAULT_TOP_K = 5;
// bge-m3 cosine scores for code-mixed questions run ~0.28-0.49; 0.22 keeps
// good recall for short casual queries while still filtering junk.
const DEFAULT_THRESHOLD = 0.22;

// Exact, short social turns should not spend an embedding request or query the
// knowledge base. Keep this deliberately conservative so follow-up questions
// and questions that merely start with a greeting still use RAG.
const GREETING_OR_CHATTER = /^(?:hi|hello|hey|hiya|good morning|good afternoon|good evening|namaste|thanks?|thank you|bye|goodbye|how are you|how's it going|what's up|who are you)[.!?,\s]*$/iu;

export function isObviousGreetingOrChitchat(query: string): boolean {
  const normalized = query.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return normalized.length > 0 && normalized.length <= 80 && GREETING_OR_CHATTER.test(normalized);
}

interface MatchRow {
  chunk_id: string;
  document_id: string;
  document_name: string;
  chunk_content: string;
  similarity: number;
}

// Embed the question, then ask Postgres (match_documents) for the nearest
// chunks that clear the relevance threshold. PostgREST casts the JSON array
// of floats to vector(2048) automatically.
export async function retrieveChunks(
  query: string,
  options: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  if (isObviousGreetingOrChitchat(query)) return [];
  const queryEmbedding = await embedQuery(query);

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding: queryEmbedding,
    match_count: options.topK ?? DEFAULT_TOP_K,
    match_threshold: options.threshold ?? DEFAULT_THRESHOLD,
  });

  if (error) throw new Error(`match_documents failed: ${error.message}`);

  return ((data ?? []) as MatchRow[]).map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    documentName: row.document_name,
    content: row.chunk_content,
    similarity: row.similarity,
  }));
}
