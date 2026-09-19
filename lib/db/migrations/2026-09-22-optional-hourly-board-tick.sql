-- OPTIONAL. Vercel Hobby allows only a daily cron (vercel.json "0 23 * * *"),
-- so on its own the board posts at 23:00 UTC's local time or the next day's
-- tick. This asks Supabase to call the same endpoint every hour instead, so a
-- board posts within the hour after its board_time in any timezone.
--
-- Uses only Supabase: the pg_cron and pg_net extensions and Vault.
--   1. Dashboard > Database > Extensions: enable pg_cron and pg_net.
--   2. Store the endpoint and secret in Vault (replace both values):
--        select vault.create_secret('https://<your-host>/api/cron/daily-board', 'japlan_board_url');
--        select vault.create_secret('<CRON_SECRET>', 'japlan_cron_secret');
--   3. Run the rest of this file.
-- Remove with: select cron.unschedule('japlan-board-tick');

select cron.schedule(
  'japlan-board-tick',
  '5 * * * *', -- five past every hour
  $$
  select net.http_get(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'japlan_board_url'),
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'japlan_cron_secret')
    )
  );
  $$
);
