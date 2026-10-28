import type { Metadata } from "next";
import Link from "next/link";
import { requireAdminSession } from "@/lib/admin/dal";
import { listConversations } from "@/lib/admin/queries";
import { formatDateTime } from "@/lib/admin/format";

export const metadata: Metadata = { title: "Conversations — ShopEasy Admin" };

export default async function ConversationsPage() {
  await requireAdminSession();
  const conversations = await listConversations();

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Conversations</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          The most recent guest chat sessions.
        </p>
      </header>

      <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500 dark:border-zinc-800">
            <tr>
              <th className="px-4 py-3 font-medium">Conversation</th>
              <th className="px-4 py-3 font-medium">Language</th>
              <th className="hidden px-4 py-3 font-medium sm:table-cell">Messages</th>
              <th className="hidden px-4 py-3 font-medium md:table-cell">Last activity</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {conversations.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-zinc-500">
                  No conversations yet.
                </td>
              </tr>
            ) : (
              conversations.map((conversation) => (
                <tr key={conversation.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                  <td className="max-w-sm px-4 py-3">
                    <Link href={`/admin/conversations/${conversation.id}`} className="font-medium hover:underline">
                      {conversation.title?.trim() || "(untitled conversation)"}
                    </Link>
                    <span className="ml-2 text-xs text-zinc-400">{conversation.status}</span>
                  </td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                    {conversation.language ?? "—"}
                  </td>
                  <td className="hidden px-4 py-3 text-zinc-600 sm:table-cell dark:text-zinc-400">
                    {conversation.messageCount}
                  </td>
                  <td className="hidden px-4 py-3 text-zinc-500 md:table-cell">
                    {formatDateTime(conversation.last_message_at)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
