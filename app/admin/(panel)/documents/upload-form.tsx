"use client";

import { useActionState } from "react";
import { uploadDocument } from "@/app/admin/actions";
import { idleActionState } from "@/lib/admin/types";

export function UploadForm() {
  const [state, action, pending] = useActionState(uploadDocument, idleActionState);

  return (
    <form action={action} className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="file"
          name="file"
          accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
          className="block w-full text-sm text-zinc-600 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-zinc-700 dark:text-zinc-300 dark:file:bg-zinc-50 dark:file:text-zinc-900"
        />
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {pending ? "Indexing…" : "Upload & index"}
        </button>
      </div>

      {state.status !== "idle" && state.message ? (
        <p
          className={`rounded-lg px-3 py-2 text-sm ${
            state.status === "success"
              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
              : "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
          }`}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
