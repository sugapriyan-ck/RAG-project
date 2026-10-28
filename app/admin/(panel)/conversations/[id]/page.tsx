import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminSession } from "@/lib/admin/dal";
import { getConversation } from "@/lib/admin/queries";
import { formatDateTime } from "@/lib/admin/format";

export const metadata: Metadata = { title: "Conversation — ShopEasy Admin" };

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminSession();
  const { id } = await params;
  const data = await getConversation(id);
  if (!data) notFound();

  const { conversation, messages } = data;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/conversations" className="text-sm text-zinc-500 hover:underline">
          ← Conversations
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">
          {conversation.title?.trim() || "(untitled conversation)"}
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          {conversation.status} · {conversation.language ?? "language unknown"} ·{" "}
          {messages.length} messages · started {formatDateTime(conversation.created_at)}
        </p>
      </div>

      <div className="space-y-4">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex ${message.role === "user" ? "justify-start" : "justify-end"}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${
                message.role === "user"
                  ? "bg-white text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
                  : "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
              }`}
            >
              <p className="whitespace-pre-wrap">{message.content}</p>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] opacity-60">
                <span>{formatDateTime(message.created_at)}</span>
                <span>· {message.role}</span>
                {message.language ? <span>· {message.language}</span> : null}
                {message.role === "assistant" ? (
                  <span>· {message.used_rag ? "knowledge base" : "no KB hit"}</span>
                ) : null}
              </div>
              {message.role === "assistant" && message.sources?.length ? (
                <p className="mt-1 text-[11px] opacity-60">
                  Sources:{" "}
                  {message.sources
                    .map((s) => s.documentName ?? "unknown")
                    .filter((name, index, all) => all.indexOf(name) === index)
                    .join(", ")}
                </p>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
