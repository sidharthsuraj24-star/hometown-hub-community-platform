-- Scheduling prerequisites only; this migration does not register the daily cleanup job.
-- API keys stay in Vault; this migration contains no credentials or request headers.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
