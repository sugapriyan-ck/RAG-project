-- Switch the embedder to BAAI/bge-m3 (1024-dim, 100+ languages incl.
-- code-mixed Indian styles). Nemotron scored ~0.05-0.13 for Tanglish/
-- Hinglish queries vs 0.28-0.49 for bge-m3.
--
--   1) track which model produced a document's embeddings (lets ingestion
--      detect "same content, different model" and re-index automatically)
--   2) resize embeddings vector to 1024 (also re-enables HNSW indexing later)
--   3) rebuild match_documents for vector(1024)
--
-- Old 2048-dim vectors can't fit into vector(1024), so clear the embeddings
-- and chunks; the ingestion CLI re-indexes the knowledge base afterwards.

-- Model that produced this document's embeddings (null until first index).
alter table public.documents
  add column if not exists embedding_model text;

-- Drop old vectors so the type change is a plain cast.
delete from public.document_chunks;  -- cascades to document_embeddings
update public.documents
  set chunk_count = 0, status = 'pending', indexed_at = null;

alter table public.document_embeddings
  alter column embedding type vector(1024);

create or replace function public.match_documents(
  query_embedding vector(1024),
  match_count int default 5,
  match_threshold double precision default 0.22
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
revoke all on function public.match_documents(vector(1024), int, double precision) from public, anon, authenticated;