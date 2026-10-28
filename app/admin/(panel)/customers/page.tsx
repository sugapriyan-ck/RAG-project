import type { Metadata } from "next";
import { requireAdminSession } from "@/lib/admin/dal";
import { listCustomers } from "@/lib/admin/queries";
import { formatDateTime } from "@/lib/admin/format";
import { deleteCustomer } from "@/app/admin/actions";
import { CustomerForm } from "./customer-form";

export const metadata: Metadata = { title: "Customers — ShopEasy Admin" };

export default async function CustomersPage() {
  await requireAdminSession();
  const customers = await listCustomers();

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Customers</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Customer records used to personalise answers. Kept separate from the knowledge base.
        </p>
      </header>

      <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-3 text-sm font-semibold">Add a customer</h2>
        <CustomerForm />
      </section>

      <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-200 text-xs uppercase text-zinc-500 dark:border-zinc-800">
            <tr>
              <th className="px-4 py-3 font-medium">Customer ID</th>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="hidden px-4 py-3 font-medium sm:table-cell">Contact</th>
              <th className="hidden px-4 py-3 font-medium md:table-cell">Added</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {customers.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-zinc-500">
                  No customers yet.
                </td>
              </tr>
            ) : (
              customers.map((customer) => (
                <tr key={customer.id}>
                  <td className="px-4 py-3 font-medium">{customer.external_id}</td>
                  <td className="px-4 py-3">{customer.name ?? "—"}</td>
                  <td className="hidden px-4 py-3 text-zinc-600 sm:table-cell dark:text-zinc-400">
                    {customer.phone ?? customer.email ?? "—"}
                  </td>
                  <td className="hidden px-4 py-3 text-zinc-500 md:table-cell">
                    {formatDateTime(customer.created_at)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <form action={deleteCustomer}>
                      <input type="hidden" name="id" value={customer.id} />
                      <button
                        type="submit"
                        className="rounded-lg border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                      >
                        Delete
                      </button>
                    </form>
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
