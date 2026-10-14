-- Hometown Hub initial schema. Apply only to a new, private Supabase project.
-- This migration creates schema/taxonomy only; it intentionally inserts no users,
-- communities, events, posts, metrics, or other personal/sample records.
create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(), email text not null unique,
  name text not null, password_salt text not null, password_hash text not null,
  hometown text not null default '', bio text not null default '',
  role text not null default 'user', disabled boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists communities (
  id uuid primary key default gen_random_uuid(), name text not null, location text not null,
  description text not null, category text not null, tags jsonb not null default '[]'::jsonb,
  rules text not null default '', status text not null default 'pending',
  created_by uuid not null references users(id), created_at timestamptz not null default now()
);
create table if not exists memberships (
  community_id uuid not null references communities(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade, role text not null default 'member',
  status text not null default 'pending', created_at timestamptz not null default now(),
  primary key (community_id,user_id)
);
create table if not exists posts (
  id uuid primary key default gen_random_uuid(), community_id uuid not null references communities(id) on delete cascade,
  user_id uuid not null references users(id), body text not null, category text not null,
  kind text not null default 'post', image_path text not null default '', pinned boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists comments (id uuid primary key default gen_random_uuid(), post_id uuid not null references posts(id) on delete cascade, user_id uuid not null references users(id), body text not null, created_at timestamptz not null default now());
create table if not exists likes (post_id uuid not null references posts(id) on delete cascade, user_id uuid not null references users(id) on delete cascade, created_at timestamptz not null default now(), primary key(post_id,user_id));
create table if not exists shares (post_id uuid not null references posts(id) on delete cascade, user_id uuid not null references users(id) on delete cascade, created_at timestamptz not null default now(), primary key(post_id,user_id));
create table if not exists events (id uuid primary key default gen_random_uuid(), community_id uuid not null references communities(id) on delete cascade, created_by uuid not null references users(id), title text not null, description text not null, location text not null, starts_at timestamptz not null, capacity integer, status text not null default 'open', created_at timestamptz not null default now());
create table if not exists rsvps (event_id uuid not null references events(id) on delete cascade, user_id uuid not null references users(id) on delete cascade, status text not null, created_at timestamptz not null default now(), primary key(event_id,user_id));
create table if not exists notifications (id uuid primary key default gen_random_uuid(), user_id uuid not null references users(id) on delete cascade, type text not null, message text not null, link text not null default '', read_at timestamptz, created_at timestamptz not null default now());
create table if not exists reports (id uuid primary key default gen_random_uuid(), reporter_id uuid not null references users(id), target_type text not null, target_id uuid not null, reason text not null, status text not null default 'open', created_at timestamptz not null default now(), resolved_by uuid references users(id), resolved_at timestamptz, resolution_note text not null default '');
create table if not exists report_messages (id uuid primary key default gen_random_uuid(), report_id uuid not null references reports(id) on delete cascade, author_id uuid not null references users(id), body text not null, created_at timestamptz not null default now());
create table if not exists report_status_history (id uuid primary key default gen_random_uuid(), report_id uuid not null references reports(id) on delete cascade, actor_id uuid not null references users(id), from_status text not null, to_status text not null, created_at timestamptz not null default now());
create table if not exists user_activity (user_id uuid not null references users(id) on delete cascade, activity_day date not null, last_seen_at timestamptz not null, primary key(user_id,activity_day));
create table if not exists content_categories (name text primary key, created_at timestamptz not null default now());
create table if not exists content_tags (name text primary key, created_at timestamptz not null default now());
create table if not exists app_sessions (token_hash text primary key, user_id uuid not null references users(id) on delete cascade, expires_at timestamptz not null, created_at timestamptz not null default now());
create table if not exists rate_limit_attempts (bucket text not null, attempted_at timestamptz not null default now());
create index if not exists idx_communities_status on communities(status);
create index if not exists idx_memberships_user on memberships(user_id,status);
create index if not exists idx_posts_community_created on posts(community_id,created_at desc);
create index if not exists idx_events_community_start on events(community_id,starts_at);
create index if not exists idx_rate_limit_attempts_bucket on rate_limit_attempts(bucket,attempted_at);

insert into content_categories(name) values ('General'),('Announcements'),('Culture'),('Events'),('Local Help') on conflict do nothing;
insert into content_tags(name) values ('Alumni'),('Culture'),('Local Help'),('Local History'),('Food & Traditions') on conflict do nothing;
