-- Production status reported in the owner update on 2026-10-27: migration 005 is applied.
-- It adds a metadata-only journal for ambiguous private evidence uploads.
-- The Pandit application remains locked; keep deployed DDL aligned and do not reapply.
create table pandit_storage_uploads (
  id uuid primary key,
  application_id uuid not null references pandit_applications(id),
  kind text not null check (kind in ('GOVERNMENT_ID','BACKGROUND_CHECK','EDUCATION')),
  content_type text not null check (content_type in ('application/pdf','image/png','image/jpeg')),
  storage_path text not null unique,
  retention_basis text not null check (retention_basis = 'PENDING'),
  created_at timestamptz not null default now(),
  delete_after timestamptz not null
);
create index idx_pandit_storage_uploads_due on pandit_storage_uploads(delete_after,id);

alter table pandit_storage_uploads enable row level security;
revoke all on table pandit_storage_uploads from anon, authenticated;
