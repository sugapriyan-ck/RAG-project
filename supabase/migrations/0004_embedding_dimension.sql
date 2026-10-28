-- The OpenRouter embedder (nvidia/nemotron-3-embed-1b:free) returns
-- 2048-dimensional vectors, which EXCEEDS pgvector's 2000-dimension index
-- limit (HNSW and IVFFlat). So:
--   1. resize the column to vector(2048) — required for any storage
--   2. NO similarity index — retrieval uses exact `<=>` search, which is fast
--      for a small MVP knowledge base.
-- If a future model is <=2000 dims, add:
--   create index on public.document_embeddings using hnsw (embedding vector_cosine_ops);
drop index if exists public.document_embeddings_embedding_idx;

alter table public.document_embeddings
  alter column embedding type vector(2048);