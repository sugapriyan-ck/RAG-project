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