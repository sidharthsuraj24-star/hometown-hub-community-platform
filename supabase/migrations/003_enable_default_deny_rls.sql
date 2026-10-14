-- Default-deny direct Supabase API access for Hometown Hub application tables.
-- The deployed app must use a privileged server-only database credential; never
-- expose that credential to browser JavaScript or HTML. No direct client policies
-- are defined here.
ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."communities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."posts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."comments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."likes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."shares" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."rsvps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."report_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."report_status_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."user_activity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."content_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."content_tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."app_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."rate_limit_attempts" ENABLE ROW LEVEL SECURITY;
