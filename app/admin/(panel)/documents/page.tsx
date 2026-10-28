import type { Metadata } from "next";
import { requireAdminSession } from "@/lib/admin/dal";
import { listDocuments } from "@/lib/admin/queries";
import { formatDateTime } from "@/lib/admin/format";
import { deleteDocument, reembedDocument } from "@/app/admin/actions";
import { UploadForm } from "./upload-form";

export const metadata: Metadata = { title: "Knowledge base — ShopEasy Admin" };

const statusStyles: Record<string, string> = {
  ready: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  processing: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  pending: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  failed: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300",
};

export default async function DocumentsPage() {
  await requireAdminSession();
  const documents = await listDocuments();

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Knowledge base</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Upload PDF, TXT or MD files. Each file is extracted, chunked and embedded automatically.
        </p>
      </header>

      <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-3 text-sm font-semibold">Add a document</h2>
        <UploadForm />
      </section>

      <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500 dark:border-zinc-800">
            <tr>
              <th className="px-4 py-3 font-medium">Document</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Chunks</th>
              <th className="hidden px-4 py-3 font-medium md:table-cell">Indexed</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {documents.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-zinc-500">
                  No documents yet.
                </td>
              </tr>
            ) : (
              documents.map((doc) => (
                <tr key={doc.id}>
                  <td className="max-w-xs px-4 py-3">
                    <p className="truncate font-medium" title={doc.name}>
                      {doc.name}
                    </p>
                    {doc.error_message ? (
                      <p className="truncate text-xs text-red-500" title={doc.error_message}>
                        {doc.error_message}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                        statusStyles[doc.status] ?? statusStyles.pending
                      }`}
                    >
                      {doc.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{doc.chunk_count}</td>
                  <td className="hidden px-4 py-3 text-zinc-500 md:table-cell">
                    {formatDateTime(doc.indexed_at)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <form action={reembedDocument}>
                        <input type="hidden" name="id" value={doc.id} />
                        <button
                          type="submit"
                          className="rounded-lg border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                          Re-embed
                        </button>
                      </form>
                      <form action={deleteDocument}>
                        <input type="hidden" name="id" value={doc.id} />
                        <button
                          type="submit"
                          className="rounded-lg border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                        >
                          Delete
                        </button>
                      </form>
                    </div>
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
