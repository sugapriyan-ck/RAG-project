-- Query-path indexes. Keep the existing ascending index for callers that use
-- it; this adds the descending read pattern used for recent conversation turns.
create index if not exists messages_conversation_id_created_at_desc_idx
  on public.messages (conversation_id, created_at desc);

create index if not exists conversations_visitor_key_idx
  on public.conversations (visitor_key);
