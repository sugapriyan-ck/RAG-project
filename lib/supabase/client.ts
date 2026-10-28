"use client";

import { createBrowserClient } from "@supabase/ssr";

// Browser-side Supabase client. Only ever uses the anon key.
// Used for auth (sign in / sign up) from the admin UI.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}