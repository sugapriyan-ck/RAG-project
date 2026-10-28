import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdminProfile } from "@/lib/admin/dal";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Admin sign in — ShopEasy" };

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string }>;
}) {
  // Already signed in as an admin? Skip the form.
  const admin = await getAdminProfile();
  if (admin) redirect("/admin");

  const { denied } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-100 px-4 py-12 dark:bg-zinc-950">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
          ShopEasy Admin
        </h1>
        <p className="mt-1 mb-6 text-sm text-zinc-500 dark:text-zinc-400">
          Sign in with your admin account.
        </p>

        {denied ? (
          <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            That account doesn&apos;t have admin access.
          </p>
        ) : null}

        <LoginForm />

        <p className="mt-6 text-center text-xs text-zinc-400">
          <Link href="/" className="hover:underline">
            ← Back to chat
          </Link>
        </p>
      </div>
    </main>
  );
}
