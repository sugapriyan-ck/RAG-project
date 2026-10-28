"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ingestDocument } from "@/lib/ingestion";
import { embedTexts } from "@/lib/embeddings";
import { requireAdminOrThrow } from "@/lib/admin/dal";
import { idleActionState, type ActionState } from "@/lib/admin/types";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function refreshKnowledgeBase() {
  revalidatePath("/admin");
  revalidatePath("/admin/documents");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/admin/login");
}

export async function uploadDocument(
  _prev: ActionState = idleActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await requireAdminOrThrow();
  } catch {
    return { status: "error", message: "Not authorized." };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", message: "Choose a PDF, TXT or MD file to upload." };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { status: "error", message: "File is too large (25 MB max)." };
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await ingestDocument({
      name: file.name,
      buffer,
      mime: file.type || undefined,
    });
    refreshKnowledgeBase();

    if (result.status === "ready") {
      return { status: "success", message: `Indexed "${file.name}" into ${result.chunkCount} chunks.` };
    }
    if (result.status === "duplicate") {
      return { status: "success", message: `"${file.name}" is already in the knowledge base.` };
    }
    return { status: "error", message: result.error ?? "Ingestion failed." };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Ingestion failed.",
    };
  }
}

export async function deleteDocument(formData: FormData) {
  await requireAdminOrThrow();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = createAdminClient();
  await supabase.from("documents").delete().eq("id", id);
  refreshKnowledgeBase();
}

// Re-run embeddings for an existing document from its stored chunks. Useful
// after switching embedding models without re-uploading the source file.
export async function reembedDocument(formData: FormData) {
  await requireAdminOrThrow();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = createAdminClient();
  const { data: chunks } = await supabase
    .from("document_chunks")
    .select("id, seq, content")
    .eq("document_id", id)
    .order("seq", { ascending: true });

  if (!chunks?.length) {
    await supabase
      .from("documents")
      .update({ status: "failed", error_message: "No chunks to re-embed." })
      .eq("id", id);
    refreshKnowledgeBase();
    return;
  }

  try {
    const { vectors, model, dimensions } = await embedTexts(chunks.map((c) => c.content));
    const chunkIds = chunks.map((c) => c.id);

    await supabase.from("document_embeddings").delete().in("chunk_id", chunkIds);
    await supabase.from("document_embeddings").insert(
      chunks.map((c, i) => ({
        chunk_id: c.id,
        model,
        dimensions,
        embedding: vectors[i],
      })),
    );

    await supabase
      .from("documents")
      .update({
        status: "ready",
        chunk_count: chunks.length,
        embedding_model: model,
        indexed_at: new Date().toISOString(),
        error_message: null,
      })
      .eq("id", id);
  } catch (error) {
    await supabase
      .from("documents")
      .update({
        status: "failed",
        error_message: error instanceof Error ? error.message : "re-embed failed",
      })
      .eq("id", id);
  }

  refreshKnowledgeBase();
}

export async function createCustomer(
  _prev: ActionState = idleActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await requireAdminOrThrow();
  } catch {
    return { status: "error", message: "Not authorized." };
  }

  const externalId = String(formData.get("external_id") ?? "").trim();
  if (!externalId) {
    return { status: "error", message: "Customer ID is required." };
  }

  const name = String(formData.get("name") ?? "").trim() || null;
  const phone = String(formData.get("phone") ?? "").trim() || null;
  const email = String(formData.get("email") ?? "").trim() || null;

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("customer_profiles")
    .insert({ external_id: externalId, name, phone, email });

  if (error) {
    if (error.code === "23505") {
      return { status: "error", message: `Customer "${externalId}" already exists.` };
    }
    return { status: "error", message: error.message };
  }

  revalidatePath("/admin/customers");
  revalidatePath("/admin");
  return { status: "success", message: `Added customer ${externalId}.` };
}

export async function deleteCustomer(formData: FormData) {
  await requireAdminOrThrow();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = createAdminClient();
  await supabase.from("customer_profiles").delete().eq("id", id);
  revalidatePath("/admin/customers");
  revalidatePath("/admin");
}
