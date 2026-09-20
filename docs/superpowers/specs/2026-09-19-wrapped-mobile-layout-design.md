# Wrapped mobile layout

## Goal

Keep every live Wrapped slide readable on phones without losing the
collage-led visual style used on larger screens.

## Chosen approach

Use a mobile-only safe-layout layer at 700px and below:

- Reserve the upper half of each slide for headings and text.
- Reposition artwork, score stickers, stamps, and decorative shapes into the
  lower or background region.
- Let long live names, recap sentences, and place labels wrap within bounded
  widths.
- Reduce type only where content can otherwise collide; do not globally shrink
  the story to desktop proportions.

This is preferred over a global font reduction (which makes the story weak)
and over making every slide a scrolling document (which loses the
slide-by-slide Wrapped experience).

## Affected slides

- **Stats:** cap the decorative total and keep the stat grid beneath the
  heading.
- **Places:** cap place-name width/lines and move the map count clear of the
  names.
- **Quests:** use a lower, smaller card wall that cannot cover the title.
- **Leaderboard:** reserve space for the rank stamp and ensure long names
  truncate or wrap without crossing scores.
- **Personal slides:** bound name/recap blocks, place photos behind text when
  needed, and keep score stickers out of the copy zone.
- **Camera roll and finale:** lower media content and make calls to action
  stack vertically.

## Verification

Use representative long live values at common phone widths (320px, 375px,
390px, and 430px) and verify no text intersects another text block, an image,
or fixed controls. Run TypeScript and the existing Wrapped tests after the CSS
change.
