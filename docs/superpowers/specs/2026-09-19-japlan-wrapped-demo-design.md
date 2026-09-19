# Japlan Wrapped demo design

## Scope

Create an explicitly labeled, local-only `Japlan Wrapped · Demo` at `/wrapped`.
It is a presentation-quality stand-in while trip, photo, and snapshot data are
unavailable. It must not change existing bot, database, API, root page, or
global application behavior.

## Data boundary

The route consumes a typed local fixture. It contains fictional trip metadata,
five participant recaps, standings, places, quests, and references to only the
three local images in `public/assets/`. The fixture is shaped as a discriminated
slide union so a future generated Wrapped response can replace it without
rewriting the player or slide templates. The UI visibly states that it is demo
data and makes no network or database requests.

## Experience

The player is a full-viewport, client-side story with a thin animated progress
indicator, click/tap controls, keyboard arrows, swipe navigation, replay, and
native share with clipboard fallback. It contains: an intro, group statistics,
exploration, quest highlights, leaderboard, one recap per eligible participant,
photo montage, and finale.

The layouts are editorial rather than dashboard-like: saturated chapter colors,
large type, geometric decorations, masked images, and varied compositions.
Personal slides cycle through three stable variants: photo-led portrait,
typographic score composition, and collage/challenge composition.

## Motion and accessibility

Slides use directional transforms with different in-slide entrances for type,
numbers, and photos. CSS keyframes and transitions avoid an additional motion
dependency. `prefers-reduced-motion` removes transforms and counters while
preserving all content and controls. Buttons have labels and keyboard focus
styles; colors retain high contrast.

## File boundary

All implementation code lives under `app/wrapped/`, using route-local CSS and
fixture/types. No existing application file is edited.

## Verification

Run lint, tests, and production build. Start the Next server and visually check
`/wrapped` at desktop and mobile dimensions for slide composition, controls,
overflow, and image fallbacks.
