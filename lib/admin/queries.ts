import { createAdminClient } from "@/lib/supabase/admin";

// Read-only admin queries. Callers MUST have passed requireAdminSession()
// first — these use the service-role client (bypasses RLS).

export interface DocumentRow {
  id: string;
  name: string;
  mime_type: string | null;
  status: "pending" | "processing" | "ready" | "failed";
  error_message: string | null;
  chunk_count: number;
  created_at: string;
  indexed_at: string | null;
}

export interface ConversationRow {
  id: string;
  title: string | null;
  status: "active" | "closed";
  language: string | null;
  created_at: string;
  last_message_at: string;
  messageCount: number;
}

export interface MessageRow {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  language: string | null;
  used_rag: boolean;
  sources: { documentName?: string; similarity?: number }[];
  created_at: string;
}

export interface CustomerRow {
  id: string;
  external_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  created_at: string;
}

export interface UnansweredQuestion {
  id: string;
  conversation_id: string | null;
  question: string;
  created_at: string;
}

export interface OverviewStats {
  documents: number;
  documentsReady: number;
  documentsFailed: number;
  chunks: number;
  conversations: number;
  messages: number;
  customers: number;
  unanswered: number;
}

// head:true returns only the count so the row payload is never transferred.
function count(table: string, column?: { name: string; value: string }) {
  const supabase = createAdminClient();
  let query = supabase.from(table).select("*", { count: "exact", head: true });
  if (column) query = query.eq(column.name, column.value);
  return query.then((result) => result.count ?? 0);
}

export async function getOverviewStats(): Promise<OverviewStats> {
  const [documents, documentsReady, documentsFailed, chunks, conversations, messages, customers, unanswered] =
    await Promise.all([
      count("documents"),
      count("documents", { name: "status", value: "ready" }),
      count("documents", { name: "status", value: "failed" }),
      count("document_chunks"),
      count("conversations"),
      count("messages"),
      count("customer_profiles"),
      count("support_events", { name: "event_type", value: "unanswered_question" }),
    ]);

  return { documents, documentsReady, documentsFailed, chunks, conversations, messages, customers, unanswered };
}

export async function listDocuments(): Promise<DocumentRow[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("documents")
    .select("id, name, mime_type, status, error_message, chunk_count, created_at, indexed_at")
    .order("created_at", { ascending: false });
  return (data ?? []) as DocumentRow[];
}

export async function listConversations(): Promise<ConversationRow[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("conversations")
    .select("id, title, status, language, created_at, last_message_at, messages(count)")
    .order("last_message_at", { ascending: false })
    .limit(100);

  return (data ?? []).map((row) => {
    const counts = (row as { messages?: { count: number }[] }).messages;
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      language: row.language,
      created_at: row.created_at,
      last_message_at: row.last_message_at,
      messageCount: counts?.[0]?.count ?? 0,
    } as ConversationRow;
  });
}

export async function getConversation(id: string) {
  const supabase = createAdminClient();
  const { data: conversation } = await supabase
    .from("conversations")
    .select("id, title, status, language, created_at, last_message_at")
    .eq("id", id)
    .maybeSingle();
  if (!conversation) return null;

  const { data: messages } = await supabase
    .from("messages")
    .select("id, role, content, language, used_rag, sources, created_at")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true })
    .limit(300);

  return { conversation, messages: (messages ?? []) as MessageRow[] };
}

export async function listCustomers(): Promise<CustomerRow[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("customer_profiles")
    .select("id, external_id, name, phone, email, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  return (data ?? []) as CustomerRow[];
}

export async function listUnansweredQuestions(limit = 10): Promise<UnansweredQuestion[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("support_events")
    .select("id, conversation_id, payload, created_at")
    .eq("event_type", "unanswered_question")
    .order("created_at", { ascending: false })
    .limit(limit);

  return (data ?? []).map((row) => ({
    id: row.id,
    conversation_id: row.conversation_id,
    question: String((row.payload as { question?: string })?.question ?? "(unknown)"),
    created_at: row.created_at,
  }));
}
