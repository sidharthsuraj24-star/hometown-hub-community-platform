-- Hometown Hub production status: this migration has been applied.
-- At production verification, all five Pandit tables were empty; RLS was enabled,
-- client privileges were revoked, and no client policies existed (default-deny).
-- No sample data, users, reviewer-role rows, or client access policies were seeded.
-- The separate private hometown-pandit-evidence bucket was verified with a
-- 1,048,576-byte limit and exactly application/pdf, image/png, image/jpeg allowed.
-- App code remains local/unreleased: production Pandit endpoints return 503 and
-- real evidence uploads remain disabled. No end-to-end live app integration is claimed.
-- Do not rerun against a database where migration 004 has already been applied.
create table pandit_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  display_name text not null default '', location text not null default '', description text not null default '',
  traditions text not null default '', languages text not null default '', ritual_skills text not null default '',
  experience_years integer not null default 0 check (experience_years between 0 and 80),
  status text not null default 'ACTION_REQUIRED' check (status in ('PENDING_VERIFICATION','ACTION_REQUIRED','APPROVED','REJECTED')),
  revision integer not null default 1, review_feedback text not null default '',
  -- Numeric flags match the shared SQLite/PostgreSQL runtime predicates and binds.
  is_simulation integer not null default 0 check (is_simulation = 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  submitted_at timestamptz, approved_at timestamptz, rejected_at timestamptz,
  appeal_until timestamptz, reverify_at timestamptz, approved_record_until timestamptz,
  rejected_evidence_until timestamptz, last_activity_at timestamptz, evidence_expired_at timestamptz
);
-- Private server-only evidence; never use public post uploads or a public bucket.
-- Exactly one storage source is permitted: a local object-store path or legacy inline bytes.
create table pandit_evidence (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references pandit_applications(id) on delete cascade,
  kind text not null check (kind in ('GOVERNMENT_ID','BACKGROUND_CHECK','EDUCATION')),
  content_type text not null check (content_type in ('application/pdf','image/png','image/jpeg')),
  storage_path text, content_base64 text,
  verified integer not null default 0 check (verified in (0,1)),
  verified_by uuid references users(id), created_at timestamptz not null default now(), delete_after timestamptz,
  retention_basis text check (retention_basis is null or retention_basis in ('APPROVED','PENDING','REJECTED_GOVERNMENT_ID','REJECTED_BACKGROUND_CHECK','REJECTED_EDUCATION')),
  constraint pandit_evidence_exactly_one_source check ((storage_path is null) <> (content_base64 is null)),
  constraint pandit_evidence_rejected_id_only check (retention_basis <> 'REJECTED_GOVERNMENT_ID' or kind = 'GOVERNMENT_ID'),
  constraint pandit_evidence_rejected_background_only check (retention_basis <> 'REJECTED_BACKGROUND_CHECK' or kind = 'BACKGROUND_CHECK'),
  constraint pandit_evidence_rejected_education_only check (retention_basis <> 'REJECTED_EDUCATION' or kind = 'EDUCATION'),
  unique(application_id,kind)
);
create table pandit_roles (
  user_id uuid primary key references users(id) on delete cascade,
  role text not null check (role in ('CHECKER','COMPLIANCE','SUPER_ADMIN'))
);
create table pandit_policy (
  id integer primary key check (id = 1),
  approved_retention_days integer check (approved_retention_days > 0),
  approved_retention_years integer check (approved_retention_years > 0),
  pending_evidence_retention_days integer default 90 check (pending_evidence_retention_days > 0),
  rejected_evidence_retention_days integer check (rejected_evidence_retention_days > 0),
  rejected_background_check_retention_days integer default 90 check (rejected_background_check_retention_days > 0),
  rejected_education_retention_days integer default 90 check (rejected_education_retention_days > 0),
  appeal_days integer check (appeal_days > 0),
  recheck_years integer not null default 1 check (recheck_years in (1,2)),
  -- Both may be NULL (unset/fail-closed), but never configure both units.
  constraint pandit_policy_approved_period_one_source check (approved_retention_days is null or approved_retention_years is null)
);
-- No row is seeded: release-time, owner-approved policy provisioning is required.
create table pandit_reviews (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references pandit_applications(id) on delete set null,
  actor_id uuid references users(id) on delete set null,
  event text not null, from_status text not null default '', to_status text not null default '',
  feedback text not null default '', created_at timestamptz not null default now()
);
create index idx_pandit_status on pandit_applications(status,updated_at);
create index idx_pandit_reviews on pandit_reviews(application_id,created_at);

-- Default deny: application authorization belongs to a separately approved server adapter.
alter table pandit_applications enable row level security;
alter table pandit_evidence enable row level security;
alter table pandit_roles enable row level security;
alter table pandit_policy enable row level security;
alter table pandit_reviews enable row level security;
revoke all on table pandit_applications, pandit_evidence, pandit_roles, pandit_policy, pandit_reviews from anon, authenticated;
-- No permissive policies on Pandit tables; service-role access stays server-only.
