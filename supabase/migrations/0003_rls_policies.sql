-- =============================================================
-- Row Level Security
-- =============================================================
-- Design intent (V1):
--   * RLS is ENABLED on every table and the default denies everything.
--   * `anon` has NO access. Public guest chat never touches PostgREST
--     directly — it flows through server route handlers that verify the
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