import type { ReactNode } from "react";
import Link from "next/link";
import { requireAdminSession } from "@/lib/admin/dal";
import { signOut } from "@/app/admin/actions";
import { AdminNav } from "./nav";

export default async function AdminPanelLayout({ children }: { children: ReactNode }) {
  // Authorization gate for every page under /admin (except /admin/login, which
  // lives outside this route group). Pages re-check too, since layouts are not
  // guaranteed to re-run on client-side navigation.
  const admin = await requireAdminSession();

  return (
    <div className="min-h-screen bg-zinc-100 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col md:flex-row">
        <aside className="flex shrink-0 flex-col gap-6 border-b border-zinc-200 bg-white p-4 md:w-60 md:border-r md:border-b-0 dark:border-zinc-800 dark:bg-zinc-900">
          <Link href="/admin" className="px-2 text-lg font-semibold">
            ShopEasy <span className="text-zinc-400">Admin</span>
          </Link>
          <AdminNav />
          <div className="mt-auto space-y-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <p className="truncate px-2 text-xs text-zinc-500" title={admin.email ?? ""}>
              {admin.displayName ?? admin.email ?? "Admin"}
            </p>
            <Link
              href="/"
              className="block rounded-lg px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              Open chat
            </Link>
            <form action={signOut}>
              <button
                type="submit"
                className="w-full rounded-lg px-3 py-2 text-left text-sm text-zinc-600 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                Sign out
              </button>
            </form>
          </div>
        </aside>

        <main className="flex-1 p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}
