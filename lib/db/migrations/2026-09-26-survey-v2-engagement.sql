-- Survey v2 (weights with confidence, written profiles), conversation
-- engagement in groups, and a real per-chat transcript.
-- Run after 2026-09-25-splits-and-suggestions.sql, before deploying.

-- A/B answers become weights with confidence, updated as the bot learns.
-- { weights: { food: { w: 0.76, c: "medium" }, ... }, basis: {...}, ... }
alter table participants add column if not exists prefs_json jsonb;
-- A few sentences about the person, DM-private exactly like survey_json.
alter table participants add column if not exists profile_md text;

-- The group's aggregate: where it agrees, where it splits, and every hard
-- constraint without names. What shared boards and splits generate from.
alter table trips add column if not exists group_profile_md text;

-- Whether the bot is part of the conversation in the group right now.
-- { engaged: bool, stopped: bool, reason: text, at: timestamptz }
alter table trips add column if not exists engagement_json jsonb;

-- Every message in and out, per chat: the context every conversational call
-- reads. The events table is per webhook, mixes chats, and never had the
-- bot's own replies in it.
create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null,
  role text not null check (role in ('user', 'bot')),
  sender_handle text,
  sender_name text,
  text text not null,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_by_chat on chat_messages (chat_id, created_at desc);
