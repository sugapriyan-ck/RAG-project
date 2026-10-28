import type { Metadata } from "next";
import Link from "next/link";
import { requireAdminSession } from "@/lib/admin/dal";
import { getOverviewStats, listUnansweredQuestions } from "@/lib/admin/queries";
import { formatDateTime } from "@/lib/admin/format";

export const metadata: Metadata = { title: "Overview — ShopEasy Admin" };

function StatCard({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value.toLocaleString()}</p>
      {hint ? <p className="mt-1 text-xs text-zinc-400">{hint}</p> : null}
    </div>
  );
}

export default async function AdminOverviewPage() {
  await requireAdminSession();
  const [stats, unanswered] = await Promise.all([getOverviewStats(), listUnansweredQuestions(8)]);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Knowledge base health and recent guest activity.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Documents"
          value={stats.documents}
          hint={`${stats.documentsReady} ready · ${stats.documentsFailed} failed`}
        />
        <StatCard label="Chunks indexed" value={stats.chunks} />
        <StatCard label="Conversations" value={stats.conversations} />
        <StatCard label="Messages" value={stats.messages} />
        <StatCard label="Customers" value={stats.customers} />
        <StatCard
          label="Unanswered"
          value={stats.unanswered}
          hint="Knowledge-base gaps"
        />
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold">Recent unanswered questions</h2>
          <Link href="/admin/conversations" className="text-xs text-zinc-500 hover:underline">
            View conversations →
          </Link>
        </div>
        {unanswered.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            No gaps recorded yet — the assistant is answering from the knowledge base.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {unanswered.map((event) => (
              <li key={event.id} className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm">{event.question}</p>
                  <p className="mt-0.5 text-xs text-zinc-400">{formatDateTime(event.created_at)}</p>
                </div>
                {event.conversation_id ? (
                  <Link
                    href={`/admin/conversations/${event.conversation_id}`}
                    className="shrink-0 text-xs text-zinc-500 hover:underline"
                  >
                    Open
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
