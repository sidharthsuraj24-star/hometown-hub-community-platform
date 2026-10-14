-- Run once after 001_initial_schema.sql in the target Supabase project.
-- The bucket is private: application reads/writes must use the server-only
-- service-role key. Never expose that key through NEXT_PUBLIC_* variables.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hometown-post-images', 'hometown-post-images', false, 1500000,
        array['image/png','image/jpeg','image/webp']::text[])
on conflict (id) do update set public=false, file_size_limit=1500000,
  allowed_mime_types=excluded.allowed_mime_types;

-- No anon/authenticated storage policies are created intentionally. The Node
-- server uses the service-role secret only after checking community membership.
