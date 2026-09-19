-- Day planning: each task carries its rough time of day on the board and the
-- code's duration estimate, so a board listed later shows the same shape it
-- was generated with. source gains 'curveball' (text, no constraint to change).
-- Run after 2026-09-23-board-request-rate-limit.sql, before deploying.

alter table tasks add column if not exists slot text;
alter table tasks add column if not exists duration_minutes integer;

comment on column tasks.slot is 'morning | afternoon | evening; null before day planning';
comment on column tasks.duration_minutes is 'code estimate: venue + travel + friction';
comment on column tasks.source is 'generated | freeform | curveball';
