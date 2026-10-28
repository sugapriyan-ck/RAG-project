-- Enable the pgvector extension for embedding storage and similarity search.
-- On Supabase this installs into the `extensions` schema and the `vector`
-- type is available on the default search_path.
create extension if not exists vector;