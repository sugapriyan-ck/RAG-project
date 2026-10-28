-- Exact-cosine retrieval over the knowledge base (Phase 4).
--
-- Deliberately no similarity index: the embedder outputs 2048 dimensions,
-- which exceeds pgvector's 2000-dim cap for HNSW/IVFFlat, and exact `<=>`
-- search is fast enough at MVP knowledge-base scale.
--
-- Authorization: executed only by our server (service role / RLS bypass, plus
-- requireAdmin() where relevant). Revoked from the REST surface below.
create or replace function public.match_documents(
  query_embedding vector(2048),
  match_count int default 5,
  match_threshold double precision default 0.35
)
returns table (
  chunk_id      uuid,
  document_id   uuid,
  document_name text,
  chunk_content text,
  similarity    double precision
)
language sql
stable
set search_path = public
as $$
  select
    dc.id                                    as chunk_id,
    dc.document_id                           as document_id,
    d.name                                   as document_name,
    dc.content                               as chunk_content,
    (1 - (de.embedding <=> query_embedding)) as similarity
  from public.document_embeddings de
  join public.document_chunks dc on dc.id = de.chunk_id
  join public.documents d      on d.id  = dc.document_id
  where (1 - (de.embedding <=> query_embedding)) >= match_threshold
  order by (de.embedding <=> query_embedding) asc
  limit match_count;
$$;

-- Server-side only: keep it off the anon/authenticated REST surface.
revoke all on function public.match_documents(vector(2048), int, double precision) from public, anon, authenticated;