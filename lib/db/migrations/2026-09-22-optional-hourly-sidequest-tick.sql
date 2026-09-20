-- Optional hourly runtime tick for time-sensitive sidequests and vote nudges.
-- Task boards are request-driven and do not depend on a cron schedule.
--
-- On Vercel Hobby, the built-in cron runs once daily. Use Supabase's pg_cron
-- when trips should get randomized sidequest offers near their chosen times,
-- queued offers should fire soon after a task ends, and stale offers should
-- expire without waiting for the next participant message.
--
-- Uses only Supabase: the pg_cron and pg_net extensions and Vault.
--   1. Dashboard > Database > Extensions: enable pg_cron and pg_net.
--   2. Store the endpoint and secret in Vault (replace both values):
--        select vault.create_secret('https://<your-host>/api/cron/daily-board', 'japlan_runtime_url');
--        select vault.create_secret('<CRON_SECRET>', 'japlan_cron_secret');
--   3. Run the rest of this file.
-- Remove with: select cron.unschedule('japlan-sidequest-tick');

select cron.schedule(
  'japlan-sidequest-tick',
  '5 * * * *', -- hourly checks for sidequest timers and open-vote nudges
  $$
  select net.http_get(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'japlan_runtime_url'),
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'japlan_cron_secret')
    )
  );
  $$
);
