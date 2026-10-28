import { createClient } from "@/lib/supabase/server";

// Minimal data-access/auth helpers. Real authorization checks live here so
// route handlers and server actions never reimplement them.

export async function getCurrentUser() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

// Returns the profile when the current user is an authenticated admin,
// otherwise null. Call this first in every admin route handler.
export async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user) return null;

  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, role")
    .eq("id", user.id)
    .single();

  if (!profile || profile.role !== "admin") return null;

  return { userId: user.id, role: profile.role };
}