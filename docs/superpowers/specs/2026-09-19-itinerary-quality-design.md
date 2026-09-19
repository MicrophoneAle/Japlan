# Itinerary quality and variety design

## Goal

Prevent sparse, repetitive, untranslated draft itineraries while preserving
verified facts and the current development-only, no-database workflow.

## Research diversity

Research uses distinct bounded query families for destination-specific
attractions, local neighborhoods and scenic experiences, food, and social or
hands-on activities. Accessibility and dietary constraints are applied to each
family; they are not the sole search topic. Candidate selection caps a single
category so museums cannot dominate the pool when suitable alternatives exist.

The activity schema records whether user-facing copy was translated from a
non-English source. Translation preserves source-derived meaning and URLs; it
does not convert unknown facts into verified claims.

## Draft pacing and variety

The generator receives explicit duration-aware planning rules. It creates
days around a practical daytime coverage target, using verified durations when
available and transparent tentative slots otherwise. A long anchor may be
paired with a meal and lighter nearby experience; shorter activities need
additional stops. No day may be empty or contain only a generic closing
summary.

Post-generation validation requires every date to contain a substantive
activity, a meal recommendation or an explicit unresolved dining gap, and
English user-facing copy. It rejects drafts whose daily or trip-wide activity
mix is dominated by one category when the researched pool provides viable
alternatives. It continues to reject invented IDs, duplicate activities,
overlapping slots, and overstated allergy safety.

## Dining and constraints

Restaurants without verified peanut cross-contact information remain usable
only as clearly labeled recommendations to confirm directly with the venue.
They never become "peanut-safe." Accessibility uncertainty remains visible,
and explicitly incompatible activities are excluded.

## Testing

Tests cover category-balanced research selection, translation labeling,
non-empty final days, duration-aware day coverage, unresolved dining gaps,
English output enforcement, and rejection of museum-only plans when diverse
candidates exist. Existing tests continue to cover factual-source and
candidate-ID boundaries.
