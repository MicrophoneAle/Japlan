-- Re-clamp every task's photo bonus ceiling to the rule in
-- lib/game/scoring.ts (photoBonusCeiling): at most 5, and at most 40% of the
-- task's base points (rounded down), whichever is lower. Generation stored the
-- model's number unclamped (100-250 on 12-19 point tasks).
--
-- Awarded points stand: this touches tasks.photo_bonus_max only, never
-- claims.awarded_points or participants.score. A claimed task's ceiling is
-- lowered too, which changes nothing already paid and bounds any later bonus.
-- Safe to re-run.

-- Preview first:
-- select id, code, title, base_points, photo_bonus_max,
--        least(photo_bonus_max, 5, floor(base_points * 0.4)::int) as clamped
-- from tasks
-- where photo_bonus_max > least(5, floor(base_points * 0.4)::int);

update tasks
set photo_bonus_max = greatest(0, least(photo_bonus_max, 5, floor(base_points * 0.4)::int))
where photo_bonus_max > greatest(0, least(5, floor(base_points * 0.4)::int));
