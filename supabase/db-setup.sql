-- Enable the pgvector extension for embedding storage and similarity search.
-- On Supabase this installs into the `extensions` schema and the `vector`
-- type is available on the default search_path.
create extension if not exists vector;
-- =============================================================
-- V1 SCHEMA â€” Multilingual RAG Customer Support Platform
-- =============================================================
-- Tables:
--   profiles             app users (links Supabase Auth -> role)
--   customer_profiles    basic customer records  (kept SEPARATE from KB)
--   conversations        chat sessions
--   messages             chat turns (+ language, RAG usage, sources)
--   documents            knowledge-base source files
--   document_chunks      extracted text chunks
--   document_embeddings  pgvector embeddings per chunk
--   customer_data        structured per-customer context (orders, etc.)
--   support_events       analytics / feedback-loop events
-- =============================================================

-- ---------- shared updated_at trigger helper ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------- profiles ----------
-- One row per Supabase auth user. `role` drives authorization:
--   admin  -> full access to dashboard + knowledge base
--   agent  -> reserved for future support-agent access
--   customer -> default for any new sign-up (no dashboard access)
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  role         text not null default 'customer'
               check (role in ('admin', 'agent', 'customer')),
  display_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Auto-create a profile row for every new Supabase auth user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role, display_name)
  values (
    new.id,
    'customer',
    nullif(new.raw_user_meta_data ->> 'display_name', '')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Promote a user to admin. Callable only by an existing admin.
create or replace function public.promote_to_admin(target_uid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  ) then
    raise exception 'not authorized';
  end if;

  update public.profiles set role = 'admin' where id = target_uid;
end;
$$;

revoke execute on function public.promote_to_admin(uuid) from public, anon;
grant execute on function public.promote_to_admin(uuid) to authenticated;

-- ---------- customer_profiles ----------
-- PII kept minimal and completely separate from the knowledge base.
create table public.customer_profiles (
  id          uuid primary key default gen_random_uuid(),
  external_id text not null unique,          -- e.g. C1024
  name        text,
  phone       text,
  email       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger customer_profiles_set_updated_at
  before update on public.customer_profiles
  for each row execute function public.set_updated_at();

create index customer_profiles_email_idx on public.customer_profiles (email);

-- ---------- conversations ----------
-- A `visitor_key` is generated for every guest chat session. The customer's
-- browser holds it and the server verifies it before returning any data, so a
-- random key never grants access to another conversation.
create table public.conversations (
  id                  uuid primary key default gen_random_uuid(),
  visitor_key         uuid not null default gen_random_uuid(),
  customer_profile_id uuid references public.customer_profiles (id) on delete set null,
  status              text not null default 'active'
                      check (status in ('active', 'closed')),
  title               text,
  language            text,                          -- dominant language detected
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  last_message_at     timestamptz not null default now()
);

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

create index conversations_customer_profile_id_idx
  on public.conversations (customer_profile_id);
create index conversations_created_at_desc_idx
  on public.conversations (created_at desc);

-- ---------- messages ----------
-- `sources` stores the document/chunk references that grounded an answer so
-- the admin UI and the language test suite can inspect provenance.
create table public.messages (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid not null references public.conversations (id) on delete cascade,
  role              text not null check (role in ('user', 'assistant', 'system')),
  content           text not null check (length(content) between 1 and 200000),
  language          text,                            -- detected language
  script            text check (script in ('roman', 'native', 'mixed', 'unknown')),
  style             text,                            -- tanglish / hinglish / roman-* / conversational-english
  used_rag          boolean not null default false,  -- was the answer RAG-grounded
  retrieval_success boolean,                         -- null == not attempted / no retrieval
  sources           jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now()
);

create index messages_conversation_id_created_at_idx
  on public.messages (conversation_id, created_at);

-- ---------- documents ----------
-- `content_hash` (sha256 of the extracted text) prevents duplicate ingestion.
create table public.documents (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  mime_type    text,
  storage_path text,                                -- Supabase Storage object path
  status       text not null default 'pending'
               check (status in ('pending', 'processing', 'ready', 'failed')),
  error_message text,
  chunk_count  integer not null default 0,
  content_hash text,
  metadata     jsonb not null default '{}'::jsonb,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  indexed_at   timestamptz
);

create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

create index documents_status_idx on public.documents (status);
create unique index documents_content_hash_uidx
  on public.documents (content_hash)
  where content_hash is not null;

-- ---------- document_chunks ----------
create table public.document_chunks (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  seq         integer not null check (seq >= 0),
  content     text not null,
  token_count integer,
  metadata    jsonb not null default '{}'::jsonb,
  unique (document_id, seq)
);

create index document_chunks_document_id_idx
  on public.document_chunks (document_id);

-- ---------- document_embeddings ----------
-- NOTE: no similarity index here â€” the chosen embedder produces 2048
-- dimensions and pgvector indexes (HNSW/IVFFlat) cap at 2000. With a small
-- knowledge base, exact `<=>` search is fast. Revisit if we switch to a
-- <=2000-dim embedding model (see migrations 0004 for the resize path).
create table public.document_embeddings (
  id         uuid primary key default gen_random_uuid(),
  chunk_id   uuid not null unique references public.document_chunks (id) on delete cascade,
  model      text not null,
  dimensions integer not null check (dimensions > 0),
  embedding  vector(2048) not null
);

-- ---------- customer_data ----------
-- Structured, personalizable context (e.g. order status) joined at answer time.
-- record_type example: 'order'; `data` holds fields like { order_number, status }.
create table public.customer_data (
  id                  uuid primary key default gen_random_uuid(),
  customer_profile_id uuid not null references public.customer_profiles (id) on delete cascade,
  record_type         text not null,
  data                jsonb not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger customer_data_set_updated_at
  before update on public.customer_data
  for each row execute function public.set_updated_at();

create index customer_data_customer_profile_id_idx
  on public.customer_data (customer_profile_id);

-- ---------- support_events ----------
-- Analytics / feedback loop. e.g. event_type in
-- ('unanswered_question', 'retrieval_failure', 'document_uploaded', 'rag_gap_noticed')
create table public.support_events (
  id              uuid primary key default gen_random_uuid(),
  event_type      text not null,
  conversation_id uuid references public.conversations (id) on delete cascade,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index support_events_type_created_at_idx
  on public.support_events (event_type, created_at desc);
-- =============================================================
-- Row Level Security
-- =============================================================
-- Design intent (V1):
--   * RLS is ENABLED on every table and the default denies everything.
--   * `anon` has NO access. Public guest chat never touches PostgREST
--     directly â€” it flows through server route handlers that verify the
--     conversation `visitor_key` before reading or writing.
--   * Back-office data (customers, documents, chunks, embeddings,
--     conversations, events) is readable/writable only by `authenticated`
--     users whose profile role is `admin` (see public.is_admin()).
--   * Server route handlers ALSO enforce the admin role check (DAL).
--     RLS is the second, defense-in-depth layer: if a client ever gets an
--     anon/service key in the browser, RLS still blocks data access.
-- =============================================================

alter table public.profiles enable row level security;
alter table public.customer_profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.documents enable row level security;
alter table public.document_chunks enable row level security;
alter table public.document_embeddings enable row level security;
alter table public.customer_data enable row level security;
alter table public.support_events enable row level security;

-- ---------- helper: current user is an admin ----------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- Only authenticated users may evaluate it. unauthenticated / anon callers
-- are not subject to admin-only policies, so they never need it.
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------- profiles ----------
-- Users can read + edit their own profile; admins can manage all profiles.
create policy "profiles_select_own_or_admin"
  on public.profiles for select
  to authenticated
  using (id = auth.uid() or public.is_admin());

create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "profiles_admin_update"
  on public.profiles for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "profiles_admin_insert"
  on public.profiles for insert
  to authenticated
  with check (public.is_admin());

-- ---------- customer_profiles ----------
create policy "customer_profiles_admin_all"
  on public.customer_profiles for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------- customer_data ----------
create policy "customer_data_admin_all"
  on public.customer_data for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------- conversations ----------
create policy "conversations_admin_all"
  on public.conversations for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------- messages ----------
create policy "messages_admin_all"
  on public.messages for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------- documents / chunks / embeddings ----------
create policy "documents_admin_all"
  on public.documents for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "document_chunks_admin_all"
  on public.document_chunks for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "document_embeddings_admin_all"
  on public.document_embeddings for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------- support_events ----------
-- Admin-only for all operations. Events are written by the server through
-- the service-role client (which bypasses RLS), so restricting the direct
-- surface to admins is sufficient.
create policy "support_events_admin_all"
  on public.support_events for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
-- The OpenRouter embedder (nvidia/nemotron-3-embed-1b:free) returns
-- 2048-dimensional vectors, which EXCEEDS pgvector's 2000-dimension index
-- limit (HNSW and IVFFlat). So:
--   1. resize the column to vector(2048) â€” required for any storage
--   2. NO similarity index â€” retrieval uses exact `<=>` search, which is fast
--      for a small MVP knowledge base.
-- If a future model is <=2000 dims, add:
--   create index on public.document_embeddings using hnsw (embedding vector_cosine_ops);
drop index if exists public.document_embeddings_embedding_idx;

alter table public.document_embeddings
  alter column embedding type vector(2048);
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
-- Close a privilege-escalation hole.
--
-- The "profiles_update_own" RLS policy (migration 0003) lets any authenticated
-- user update their OWN row. RLS cannot restrict columns, so a customer could
-- run `update profiles set role = 'admin' where id = auth.uid()` and promote
-- themselves. Column-level GRANTs would also weaken legitimate admin updates,
-- so a BEFORE UPDATE trigger enforces the rule instead.
--
-- Blocked only for authenticated non-admins. Trusted contexts are unaffected:
--  * service_role / postgres (server + migrations)  -> current_user != 'authenticated'
--  * admins                                          -> public.is_admin() is true
--  * promote_to_admin() (SECURITY DEFINER, admin-guarded) still works
--
-- NOTE: this function must stay SECURITY INVOKER (default) so `current_user`
-- reflects the real caller; SECURITY DEFINER would mask it as the owner.
create or replace function public.prevent_profile_role_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.role is distinct from old.role
     and current_user = 'authenticated'
     and not public.is_admin() then
    raise exception 'changing the profile role is not permitted' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_prevent_role_change on public.profiles;

create trigger profiles_prevent_role_change
  before update on public.profiles
  for each row execute function public.prevent_profile_role_change();
