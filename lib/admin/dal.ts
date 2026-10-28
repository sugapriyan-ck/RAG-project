import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Server-only data-access layer for the admin dashboard.
//
// Authorization is centralized here so pages, layouts and server actions all
// share one implementation. `getAdminProfile` is request-memoized, so calling
// the guard multiple times per render hits Supabase once.

export interface AdminProfile {
  id: string;
  email: string | null;
  displayName: string | null;
}

export const getAdminProfile = cache(async (): Promise<AdminProfile | null> => {
  const supabase = await createClient();
  const { data: auth, error } = await supabase.auth.getUser();
  if (error || !auth.user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, role, display_name")
    .eq("id", auth.user.id)
    .single();

  if (!profile || profile.role !== "admin") return null;

  return {
    id: auth.user.id,
    email: auth.user.email ?? null,
    displayName: profile.display_name ?? null,
  };
});

// For pages/layouts: redirect anonymous or non-admin users to the login page.
export async function requireAdminSession(): Promise<AdminProfile> {
  const admin = await getAdminProfile();
  if (!admin) redirect("/admin/login?denied=1");
  return admin;
}

// For server actions: throw instead of redirecting so the action's return
// value is never silently discarded. The forms surface a generic failure.
export async function requireAdminOrThrow(): Promise<AdminProfile> {
  const admin = await getAdminProfile();
  if (!admin) throw new Error("Not authorized");
  return admin;
}
