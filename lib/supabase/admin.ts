import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role client. BYPASSES ROW LEVEL SECURITY — server-only.
// Authorization must be enforced in the calling route handler / server code
// (requireAdmin checks the profile role) before any data is read or written.
// The service role key must NEVER be exposed to the browser.
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
}