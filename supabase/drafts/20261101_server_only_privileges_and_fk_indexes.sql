-- DRAFT ONLY — reviewed against production metadata for project aetbwfkeohaawekhukqs
-- at repository commit 00d3dc8. This file is intentionally outside
-- supabase/migrations/, which scripts/apply-supabase-migrations.sh scans.
-- Do not apply without separate review and approval.
--
-- Scope: remove anon/authenticated table privileges from the 18 server-only app
-- tables; add a generated PK to rate_limit_attempts; add indexes for the 19 FK
-- constraints that currently lack a valid leading-column index.
--
-- This does not change RLS flags/policies, grant/revoke postgres or service_role,
-- alter application rows, or drop/replace idx_pandit_status or idx_pandit_reviews.
-- The identity column assigns generated IDs to existing rate_limit_attempts rows;
-- it does not depend on bucket/attempted_at uniqueness. The PK step takes a table
-- lock. The FK indexes use CONCURRENTLY and must remain outside a transaction.
-- Use psql with ON_ERROR_STOP=1. If a concurrent index build fails, inspect/remove
-- any invalid same-name index before retrying; IF NOT EXISTS cannot repair one.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- Fail closed if the live schema/guard has drifted from the audited baseline.
DO $preflight$
DECLARE
  expected_public_tables CONSTANT text[] := ARRAY[
    'app_sessions', 'comments', 'communities', 'content_categories', 'content_tags',
    'events', 'likes', 'memberships', 'notifications', 'posts', 'rate_limit_attempts',
    'report_messages', 'report_status_history', 'reports', 'rsvps', 'shares',
    'user_activity', 'users',
    'pandit_applications', 'pandit_evidence', 'pandit_policy', 'pandit_reviews',
    'pandit_roles', 'pandit_storage_uploads'
  ];
  found_tables integer;
  id_type oid;
  id_identity "char";
  id_not_null boolean;
  pk_columns text[];
BEGIN
  SELECT count(*) INTO found_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname = ANY (expected_public_tables);
  IF found_tables <> cardinality(expected_public_tables) THEN
    RAISE EXCEPTION 'Preflight failed: expected all 24 audited public tables, found %', found_tables;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname = ANY (expected_public_tables)
      AND c.relrowsecurity = false
  ) THEN
    RAISE EXCEPTION 'Preflight failed: an audited public table no longer has RLS enabled';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = ANY (expected_public_tables)
  ) THEN
    RAISE EXCEPTION 'Preflight failed: an audited public table now has a policy; review default-deny assumptions';
  END IF;

  IF (SELECT count(*) FROM pg_roles
      WHERE rolname IN ('anon', 'authenticated')
        AND rolsuper = false AND rolbypassrls = false) <> 2 THEN
    RAISE EXCEPTION 'Preflight failed: anon/authenticated role attributes differ from the audited baseline';
  END IF;

  IF (SELECT count(*)
      FROM pg_attribute
      WHERE attrelid = 'public.rate_limit_attempts'::regclass
        AND attname IN ('bucket', 'attempted_at')
        AND attnum > 0 AND NOT attisdropped) <> 2 THEN
    RAISE EXCEPTION 'Preflight failed: rate_limit_attempts no longer has the expected bucket and attempted_at columns';
  END IF;

  SELECT a.atttypid, a.attidentity, a.attnotnull
    INTO id_type, id_identity, id_not_null
  FROM pg_attribute a
  WHERE a.attrelid = 'public.rate_limit_attempts'::regclass
    AND a.attname = 'id' AND a.attnum > 0 AND NOT a.attisdropped;
  IF id_type IS NOT NULL
     AND (id_type <> 'int8'::regtype OR id_identity <> 'a' OR id_not_null = false) THEN
    RAISE EXCEPTION 'Preflight failed: an existing rate_limit_attempts.id is not GENERATED ALWAYS bigint NOT NULL';
  END IF;

  SELECT array_agg(a.attname::text ORDER BY key_col.ordinality)
    INTO pk_columns
  FROM pg_constraint con
  JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key_col(attnum, ordinality) ON true
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = key_col.attnum
  WHERE con.conrelid = 'public.rate_limit_attempts'::regclass
    AND con.contype = 'p';
  IF pk_columns IS NOT NULL AND pk_columns IS DISTINCT FROM ARRAY['id']::text[] THEN
    RAISE EXCEPTION 'Preflight failed: rate_limit_attempts already has a primary key other than id';
  END IF;
END
$preflight$;

REVOKE ALL PRIVILEGES ON TABLE
  public.app_sessions,
  public.comments,
  public.communities,
  public.content_categories,
  public.content_tags,
  public.events,
  public.likes,
  public.memberships,
  public.notifications,
  public.posts,
  public.rate_limit_attempts,
  public.report_messages,
  public.report_status_history,
  public.reports,
  public.rsvps,
  public.shares,
  public.user_activity,
  public.users
FROM anon, authenticated;

-- Current server-side app inserts omit id; GENERATED ALWAYS also prevents callers
-- from choosing IDs. Existing rows receive distinct sequence-generated values.
ALTER TABLE public.rate_limit_attempts
  ADD COLUMN IF NOT EXISTS id bigint GENERATED ALWAYS AS IDENTITY;

DO $primary_key$
DECLARE
  pk_columns text[];
BEGIN
  SELECT array_agg(a.attname::text ORDER BY key_col.ordinality)
    INTO pk_columns
  FROM pg_constraint con
  JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key_col(attnum, ordinality) ON true
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = key_col.attnum
  WHERE con.conrelid = 'public.rate_limit_attempts'::regclass
    AND con.contype = 'p';

  IF pk_columns IS NULL THEN
    ALTER TABLE public.rate_limit_attempts
      ADD CONSTRAINT rate_limit_attempts_pkey PRIMARY KEY (id);
  ELSIF pk_columns IS DISTINCT FROM ARRAY['id']::text[] THEN
    RAISE EXCEPTION 'Cannot add rate_limit_attempts primary key: unexpected existing key %', pk_columns;
  END IF;
END
$primary_key$;

COMMIT;

-- CREATE INDEX CONCURRENTLY cannot run inside BEGIN/COMMIT. Each index is
-- idempotent when valid; the database assertions below verify all 31 public FKs.
SET lock_timeout = '5s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_app_sessions_user_id_fk ON public.app_sessions (user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_comments_post_id_fk ON public.comments (post_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_comments_user_id_fk ON public.comments (user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_communities_created_by_fk ON public.communities (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_created_by_fk ON public.events (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_likes_user_id_fk ON public.likes (user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user_id_fk ON public.notifications (user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pandit_evidence_verified_by_fk ON public.pandit_evidence (verified_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pandit_reviews_actor_id_fk ON public.pandit_reviews (actor_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pandit_storage_uploads_application_id_fk ON public.pandit_storage_uploads (application_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_user_id_fk ON public.posts (user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_report_messages_author_id_fk ON public.report_messages (author_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_report_messages_report_id_fk ON public.report_messages (report_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_report_status_history_actor_id_fk ON public.report_status_history (actor_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_report_status_history_report_id_fk ON public.report_status_history (report_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reports_reporter_id_fk ON public.reports (reporter_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reports_resolved_by_fk ON public.reports (resolved_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rsvps_user_id_fk ON public.rsvps (user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shares_user_id_fk ON public.shares (user_id);
RESET lock_timeout;
