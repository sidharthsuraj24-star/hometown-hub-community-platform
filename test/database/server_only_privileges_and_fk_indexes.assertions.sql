-- Database assertions for supabase/drafts/20261101_server_only_privileges_and_fk_indexes.sql
-- Run manually only against a disposable or separately approved staging database,
-- after applying the draft migration there; this file is not in the migration runner.
-- Example: psql "$STAGING_DB_URL" --no-psqlrc --set ON_ERROR_STOP=1 --file "$0"
-- These checks read PostgreSQL catalogs/privilege metadata only; they do not read
-- application rows or mutate schema/data.

DO $assertions$
DECLARE
  expected_public_tables CONSTANT text[] := ARRAY[
    'app_sessions', 'comments', 'communities', 'content_categories', 'content_tags',
    'events', 'likes', 'memberships', 'notifications', 'posts', 'rate_limit_attempts',
    'report_messages', 'report_status_history', 'reports', 'rsvps', 'shares',
    'user_activity', 'users',
    'pandit_applications', 'pandit_evidence', 'pandit_policy', 'pandit_reviews',
    'pandit_roles', 'pandit_storage_uploads'
  ];
  server_only_tables CONSTANT text[] := ARRAY[
    'app_sessions', 'comments', 'communities', 'content_categories', 'content_tags',
    'events', 'likes', 'memberships', 'notifications', 'posts', 'rate_limit_attempts',
    'report_messages', 'report_status_history', 'reports', 'rsvps', 'shares',
    'user_activity', 'users'
  ];
  client_roles CONSTANT text[] := ARRAY['anon', 'authenticated'];
  server_roles CONSTANT text[] := ARRAY['postgres', 'service_role'];
  table_privileges CONSTANT text[] := ARRAY[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ];
  found_tables integer;
  fk_count integer;
  id_type oid;
  id_identity "char";
  id_not_null boolean;
  pk_columns text[];
  table_name text;
  role_name text;
  privilege_name text;
  expected_index record;
BEGIN
  SELECT count(*) INTO found_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname = ANY (expected_public_tables);
  IF found_tables <> cardinality(expected_public_tables) THEN
    RAISE EXCEPTION 'Expected all 24 audited public tables; found %', found_tables;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(expected_public_tables) AS expected(name)
    LEFT JOIN pg_namespace public_ns ON public_ns.nspname = 'public'
    LEFT JOIN pg_class c
      ON c.relnamespace = public_ns.oid AND c.relname = expected.name
    WHERE c.oid IS NULL OR c.relrowsecurity = false
  ) THEN
    RAISE EXCEPTION 'One or more audited public tables are missing or do not have RLS enabled';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = ANY (expected_public_tables)
  ) THEN
    RAISE EXCEPTION 'An audited table has a policy; default-deny client access has changed';
  END IF;

  IF (SELECT count(*) FROM pg_roles
      WHERE rolname = ANY (client_roles)
        AND rolsuper = false AND rolbypassrls = false) <> cardinality(client_roles) THEN
    RAISE EXCEPTION 'anon/authenticated role attributes are missing or no longer non-superuser/non-BYPASSRLS';
  END IF;

  -- No effective client table privileges, including TRUNCATE, on any audited table.
  FOREACH table_name IN ARRAY expected_public_tables LOOP
    FOREACH role_name IN ARRAY client_roles LOOP
      FOREACH privilege_name IN ARRAY table_privileges LOOP
        IF has_table_privilege(role_name, format('public.%I', table_name), privilege_name) THEN
          RAISE EXCEPTION 'Client role % still has % on public.%', role_name, privilege_name, table_name;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- Preserve server-side PostgreSQL access to all 24 tables, including Pandit.
  FOREACH table_name IN ARRAY expected_public_tables LOOP
    FOREACH role_name IN ARRAY server_roles LOOP
      FOREACH privilege_name IN ARRAY table_privileges LOOP
        IF NOT has_table_privilege(role_name, format('public.%I', table_name), privilege_name) THEN
          RAISE EXCEPTION 'Server role % lost % on public.%', role_name, privilege_name, table_name;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  SELECT a.atttypid, a.attidentity, a.attnotnull
    INTO id_type, id_identity, id_not_null
  FROM pg_attribute a
  WHERE a.attrelid = 'public.rate_limit_attempts'::regclass
    AND a.attname = 'id' AND a.attnum > 0 AND NOT a.attisdropped;
  IF id_type IS DISTINCT FROM 'int8'::regtype
     OR id_identity IS DISTINCT FROM 'a'
     OR id_not_null IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'rate_limit_attempts.id must be GENERATED ALWAYS bigint NOT NULL';
  END IF;

  SELECT array_agg(a.attname::text ORDER BY key_col.ordinality)
    INTO pk_columns
  FROM pg_constraint con
  JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key_col(attnum, ordinality) ON true
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = key_col.attnum
  WHERE con.conrelid = 'public.rate_limit_attempts'::regclass
    AND con.contype = 'p';
  IF pk_columns IS DISTINCT FROM ARRAY['id']::text[] THEN
    RAISE EXCEPTION 'rate_limit_attempts primary key must contain exactly id; found %', pk_columns;
  END IF;

  -- The audited schema has 31 public FKs; every one must have a valid, ready,
  -- non-partial index whose key columns begin with the FK columns in order.
  SELECT count(*) INTO fk_count
  FROM pg_constraint fk
  JOIN pg_class child ON child.oid = fk.conrelid
  JOIN pg_namespace ns ON ns.oid = child.relnamespace
  WHERE fk.contype = 'f' AND ns.nspname = 'public';
  IF fk_count <> 31 THEN
    RAISE EXCEPTION 'Expected 31 public foreign keys from the audited schema; found %', fk_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint fk
    JOIN pg_class child ON child.oid = fk.conrelid
    JOIN pg_namespace ns ON ns.oid = child.relnamespace
    WHERE fk.contype = 'f'
      AND ns.nspname = 'public'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_index i
        WHERE i.indrelid = fk.conrelid
          AND i.indisvalid = true
          AND i.indisready = true
          AND i.indpred IS NULL
          AND i.indexprs IS NULL
          AND i.indnkeyatts >= cardinality(fk.conkey)
          AND (
            SELECT array_agg(index_col.attnum ORDER BY index_col.ordinality)
            FROM unnest(i.indkey) WITH ORDINALITY AS index_col(attnum, ordinality)
            WHERE index_col.ordinality <= cardinality(fk.conkey)
          ) = fk.conkey
      )
  ) THEN
    RAISE EXCEPTION 'At least one public foreign key lacks a valid leading-column index';
  END IF;

  -- Confirm the 19 indexes in the draft exist on the intended FK/table pair.
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('idx_app_sessions_user_id_fk', 'app_sessions', 'app_sessions_user_id_fkey'),
      ('idx_comments_post_id_fk', 'comments', 'comments_post_id_fkey'),
      ('idx_comments_user_id_fk', 'comments', 'comments_user_id_fkey'),
      ('idx_communities_created_by_fk', 'communities', 'communities_created_by_fkey'),
      ('idx_events_created_by_fk', 'events', 'events_created_by_fkey'),
      ('idx_likes_user_id_fk', 'likes', 'likes_user_id_fkey'),
      ('idx_notifications_user_id_fk', 'notifications', 'notifications_user_id_fkey'),
      ('idx_pandit_evidence_verified_by_fk', 'pandit_evidence', 'pandit_evidence_verified_by_fkey'),
      ('idx_pandit_reviews_actor_id_fk', 'pandit_reviews', 'pandit_reviews_actor_id_fkey'),
      ('idx_pandit_storage_uploads_application_id_fk', 'pandit_storage_uploads', 'pandit_storage_uploads_application_id_fkey'),
      ('idx_posts_user_id_fk', 'posts', 'posts_user_id_fkey'),
      ('idx_report_messages_author_id_fk', 'report_messages', 'report_messages_author_id_fkey'),
      ('idx_report_messages_report_id_fk', 'report_messages', 'report_messages_report_id_fkey'),
      ('idx_report_status_history_actor_id_fk', 'report_status_history', 'report_status_history_actor_id_fkey'),
      ('idx_report_status_history_report_id_fk', 'report_status_history', 'report_status_history_report_id_fkey'),
      ('idx_reports_reporter_id_fk', 'reports', 'reports_reporter_id_fkey'),
      ('idx_reports_resolved_by_fk', 'reports', 'reports_resolved_by_fkey'),
      ('idx_rsvps_user_id_fk', 'rsvps', 'rsvps_user_id_fkey'),
      ('idx_shares_user_id_fk', 'shares', 'shares_user_id_fkey')
    ) AS expected(index_name, table_name, constraint_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_constraint fk
      JOIN pg_class child ON child.oid = fk.conrelid
      JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
      JOIN pg_index i ON i.indrelid = fk.conrelid
      JOIN pg_class index_class ON index_class.oid = i.indexrelid
      JOIN pg_namespace index_ns ON index_ns.oid = index_class.relnamespace
      WHERE fk.contype = 'f'
        AND fk.conname = expected.constraint_name
        AND child.relname = expected.table_name
        AND child_ns.nspname = 'public'
        AND index_class.relname = expected.index_name
        AND index_ns.nspname = 'public'
        AND i.indisvalid = true
        AND i.indisready = true
        AND i.indpred IS NULL
        AND i.indexprs IS NULL
        AND i.indnkeyatts >= cardinality(fk.conkey)
        AND (
          SELECT array_agg(index_col.attnum ORDER BY index_col.ordinality)
          FROM unnest(i.indkey) WITH ORDINALITY AS index_col(attnum, ordinality)
          WHERE index_col.ordinality <= cardinality(fk.conkey)
        ) = fk.conkey
    )
  ) THEN
    RAISE EXCEPTION 'One or more expected new FK indexes are missing, invalid, or on the wrong constraint';
  END IF;

  -- These two pre-existing, currently unused Pandit indexes are intentionally retained.
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('idx_pandit_status', 'pandit_applications'),
      ('idx_pandit_reviews', 'pandit_reviews')
    ) AS expected(index_name, table_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_class index_class
      JOIN pg_namespace index_ns ON index_ns.oid = index_class.relnamespace
      JOIN pg_index i ON i.indexrelid = index_class.oid
      JOIN pg_class table_class ON table_class.oid = i.indrelid
      WHERE index_ns.nspname = 'public'
        AND index_class.relname = expected.index_name
        AND table_class.relname = expected.table_name
        AND i.indisvalid = true
        AND i.indisready = true
    )
  ) THEN
    RAISE EXCEPTION 'A pre-existing Pandit index was removed or made invalid';
  END IF;
END
$assertions$;
