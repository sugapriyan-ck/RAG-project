-- =============================================================
-- V1 SCHEMA — Multilingual RAG Customer Support Platform
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
-- NOTE: no similarity index here — the chosen embedder produces 2048
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