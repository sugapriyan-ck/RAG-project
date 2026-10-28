"use client";

import { useActionState } from "react";
import { createCustomer } from "@/app/admin/actions";
import { idleActionState } from "@/lib/admin/types";

const inputClass =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50";

export function CustomerForm() {
  const [state, action, pending] = useActionState(createCustomer, idleActionState);

  return (
    <form action={action} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <input name="external_id" placeholder="Customer ID *" required className={inputClass} />
        <input name="name" placeholder="Name" className={inputClass} />
        <input name="phone" placeholder="Phone" className={inputClass} />
        <input name="email" type="email" placeholder="Email" className={inputClass} />
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {pending ? "Adding…" : "Add customer"}
        </button>
        {state.status !== "idle" && state.message ? (
          <p
            className={`text-sm ${
              state.status === "success" ? "text-emerald-600" : "text-red-600"
            }`}
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
