import type { Axes } from "./scoring";
import type { SeedVerification } from "./hand-written-tasks";
import type { DurationBand } from "./duration";
import type { TaskKind } from "./validate";

export type InterestKey =
  | "food"
  | "nature"
  | "museums"
  | "nightlife"
  | "shopping"
  | "architecture"
  | "weird";

export type SlotKind =
  | "letter_range"
  | "time"
  | "early_time"
  | "transport_mode"
  | "subject"
  | "neighborhood"
  | "dish"
  | "phrase"
  | "place_a"
  | "place_b"
  | "transit_line"
  | "amount"
  | "museum";

export type TemplateSlot = {
  key: string;
  kind: SlotKind;
};

export type AxisRange = {
  min: number;
  max: number;
};

export type TaskTemplate = {
  id: string;
  // Title with `{slot_key}` placeholders. Filled from the destination profile.
  archetype: string;
  kind: TaskKind;
  slots: TemplateSlot[];
  verification: SeedVerification;
  // photo_bonus_max is the bonus ceiling. verification "photo" is not a claim gate.
  photo_bonus_max: number;
  axes: Record<keyof Axes, AxisRange>;
  indoor: boolean;
  // Used only by the deterministic fallback, never sent as a model point value.
  typical_cost: "low" | "medium" | "high";
  // How long it takes. "sidequest" (under ~20 min) never goes on the daily
  // board. The time axis range stays inside this band.
  duration: DurationBand;
  // Where the time goes, for estimateTaskMinutes: a venue category ("place"
  // means the category of the place it names), a leg between its first two
  // places, and fixed minutes it always costs.
  venue?: string;
  leg?: "walk" | "city";
  fixedMinutes?: number;
  // Needs speaking to someone you do not know. Validation filters on this
  // flag (sociability), never on the title. Boards have one unless someone
  // assigned said "rather not".
  needs_stranger: boolean;
  // Food the player does not get to choose: off limits for anyone with a
  // dietary restriction.
  blind_food?: boolean;
  // Built around alcohol: off limits for anyone who does not drink.
  alcohol?: boolean;
  // Which survey interests it serves (interest_picks ids). Used to weight
  // the board toward what the people on it picked.
  interests?: InterestKey[];
  // Needs more than one person; never offered on a solo trip.
  groupOnly?: boolean;
  // Only makes sense at one end of the day.
  when?: "morning" | "evening";
  // "Go look at X": the weakest archetype. Used by the fallback last.
  lookOnly?: boolean;
};

function range(min: number, max: number): AxisRange {
  return { min, max };
}

function axes(
  boldness: AxisRange,
  physical: AxisRange,
  time: AxisRange,
  scarcity: AxisRange,
  cultural: AxisRange,
  aesthetics: AxisRange,
): Record<keyof Axes, AxisRange> {
  return { boldness, physical, time, scarcity, cultural, aesthetics };
}

// Axis ranges are set per template so the bank spreads across the scoring
// space: social tasks score on boldness, rare finds on scarcity, local ones on
// cultural. Wording is a first draft.
export const TEMPLATES: TaskTemplate[] = [
  // FOOD
  {
    id: "eat_letter_range",
    archetype: "eat something starting with a letter in {letter_range}",
    kind: "food",
    slots: [{ key: "letter_range", kind: "letter_range" }],
    verification: "honor",
    photo_bonus_max: 0,
    axes: axes(range(1, 2), range(1, 1), range(1, 1), range(1, 2), range(1, 3), range(1, 2)),
    indoor: true,
    typical_cost: "low",
    duration: "sidequest",
    venue: "snack",
    needs_stranger: false,
    interests: ["food"],
  },
  {
    id: "neighborhood_dish",
    archetype: "eat {dish} in {neighborhood}",
    kind: "food",
    slots: [
      { key: "dish", kind: "dish" },
      { key: "neighborhood", kind: "neighborhood" },
    ],
    verification: "photo",
    photo_bonus_max: 2,
    axes: axes(range(2, 3), range(2, 3), range(3, 3), range(2, 3), range(3, 5), range(2, 3)),
    indoor: true,
    typical_cost: "medium",
    duration: "medium",
    venue: "restaurant",
    needs_stranger: false,
    interests: ["food"],
  },
  {
    id: "order_unreadable",
    archetype: "order something you cannot read, in {neighborhood}",
    kind: "food",
    slots: [{ key: "neighborhood", kind: "neighborhood" }],
    verification: "photo",
    photo_bonus_max: 2,
    axes: axes(range(2, 2), range(1, 1), range(2, 2), range(2, 2), range(3, 3), range(1, 1)),
    indoor: true,
    typical_cost: "low",
    duration: "light",
    venue: "street food",
    needs_stranger: false,
    interests: ["food", "weird"],
    blind_food: true,
  },
  {
    id: "dish_where_from",
    archetype: "eat {dish} where it is actually from, not a tourist version",
    kind: "food",
    slots: [{ key: "dish", kind: "dish" }],
    verification: "photo",
    photo_bonus_max: 2,
    axes: axes(range(1, 2), range(2, 2), range(3, 3), range(3, 4), range(4, 5), range(1, 2)),
    indoor: true,
    typical_cost: "medium",
    duration: "medium",
    venue: "restaurant",
    fixedMinutes: 20,
    needs_stranger: false,
    interests: ["food"],
  },
  {
    id: "cheapest_meal",
    archetype: "find the cheapest full meal in {neighborhood}, photograph the receipt",
    kind: "food",
    slots: [{ key: "neighborhood", kind: "neighborhood" }],
    verification: "photo",
    photo_bonus_max: 2,
    axes: axes(range(1, 2), range(2, 3), range(3, 3), range(3, 4), range(3, 3), range(1, 1)),
    indoor: true,
    typical_cost: "low",
    duration: "medium",
    venue: "diner",
    fixedMinutes: 30,
    needs_stranger: false,
    interests: ["food"],
  },
  {
    id: "eat_standing",
    archetype: "eat standing up, like a local",
    kind: "food",
    slots: [],
    verification: "honor",
    photo_bonus_max: 1,
    axes: axes(range(1, 2), range(1, 1), range(1, 1), range(1, 2), range(3, 4), range(1, 1)),
    indoor: true,
    typical_cost: "low",
    duration: "sidequest",
    fixedMinutes: 12,
    needs_stranger: false,
    interests: ["food"],
  },
  {
    id: "staff_pick",
    archetype: "ask someone working there what they would order, order it",
    kind: "food",
    slots: [],
    verification: "honor",
    photo_bonus_max: 1,
    axes: axes(range(3, 3), range(1, 1), range(2, 2), range(2, 2), range(3, 4), range(1, 2)),
    indoor: true,
    typical_cost: "low",
    duration: "light",
    venue: "street food",
    needs_stranger: true,
    interests: ["food"],
    blind_food: true,
  },

  // SOCIAL FRICTION: the point of the game
  {
    id: "learn_phrase",
    archetype: "learn {phrase} from a stranger and use it",
    kind: "social",
    slots: [{ key: "phrase", kind: "phrase" }],
    verification: "peer",
    photo_bonus_max: 0,
    axes: axes(range(3, 5), range(1, 2), range(2, 2), range(2, 3), range(3, 5), range(1, 2)),
    indoor: true,
    typical_cost: "low",
    duration: "light",
    needs_stranger: true,
    interests: ["weird"],
  },
  {
    id: "order_what_neighbour_ordered",
    archetype: "ask what the person next to you ordered, then order that",
    kind: "social",
    slots: [],
    verification: "honor",
    photo_bonus_max: 1,
    axes: axes(range(4, 5), range(1, 1), range(3, 3), range(2, 2), range(3, 4), range(1, 2)),
    indoor: true,
    typical_cost: "low",
    duration: "medium",
    venue: "noodle",
    needs_stranger: true,
    interests: ["food", "weird"],
    blind_food: true,
  },
  {
    id: "stranger_best_rec",
    archetype: "ask a stranger in {neighborhood} for their single best recommendation, then actually do it",
    kind: "social",
    slots: [{ key: "neighborhood", kind: "neighborhood" }],
    verification: "photo",
    photo_bonus_max: 2,
    axes: axes(range(4, 5), range(2, 2), range(3, 3), range(3, 4), range(4, 4), range(2, 2)),
    indoor: false,
    typical_cost: "low",
    duration: "medium",
    fixedMinutes: 45,
    needs_stranger: true,
    interests: ["weird"],
  },
  {
    id: "phrase_wrong",
    archetype: "learn {phrase} from someone, then use it wrong in public",
    kind: "social",
    slots: [{ key: "phrase", kind: "phrase" }],
    verification: "honor",
    photo_bonus_max: 0,
    axes: axes(range(4, 5), range(1, 1), range(2, 2), range(2, 2), range(3, 4), range(1, 1)),
    indoor: false,
    typical_cost: "low",
    duration: "light",
    needs_stranger: true,
    interests: ["weird"],
  },
  {
    id: "compliment_outfit",
    archetype: "compliment a stranger's outfit in the local language",
    kind: "social",
    slots: [],
    verification: "honor",
    photo_bonus_max: 0,
    axes: axes(range(5, 5), range(1, 1), range(2, 2), range(1, 2), range(3, 3), range(2, 3)),
    indoor: false,
    typical_cost: "low",
    duration: "light",
    needs_stranger: true,
    interests: ["shopping"],
  },

  // NAVIGATION
  {
    id: "landmark_without_transport",
    archetype: "get to {subject} without {transport_mode}",
    kind: "challenge",
    slots: [
      { key: "subject", kind: "subject" },
      { key: "transport_mode", kind: "transport_mode" },
    ],
    verification: "peer",
    photo_bonus_max: 0,
    axes: axes(range(3, 4), range(3, 5), range(3, 3), range(2, 3), range(2, 4), range(2, 3)),
    indoor: false,
    typical_cost: "low",
    duration: "medium",
    venue: "place",
    fixedMinutes: 45,
    needs_stranger: false,
    interests: ["architecture"],
  },
  {
    id: "directions_no_phone",
    archetype: "get directions to {subject} without using your phone",
    kind: "challenge",
    slots: [{ key: "subject", kind: "subject" }],
    verification: "peer",
    photo_bonus_max: 0,
    axes: axes(range(4, 4), range(2, 3), range(3, 3), range(2, 2), range(3, 3), range(1, 2)),
    indoor: false,
    typical_cost: "low",
    duration: "medium",
    venue: "place",
    fixedMinutes: 30,
    needs_stranger: true,
    interests: ["architecture"],
  },
  {
    id: "a_to_b_without",
    archetype: "get from {place_a} to {place_b} without {transport_mode}",
    kind: "challenge",
    slots: [
      { key: "place_a", kind: "place_a" },
      { key: "place_b", kind: "place_b" },
      { key: "transport_mode", kind: "transport_mode" },
    ],
    verification: "peer",
    photo_bonus_max: 0,
    axes: axes(range(2, 3), range(4, 5), range(3, 3), range(3, 4), range(3, 4), range(2, 3)),
    indoor: false,
    typical_cost: "low",
    duration: "medium",
    leg: "walk",
    needs_stranger: false,
    interests: ["nature", "architecture"],
  },
  {
    id: "wrong_train",
    archetype: "take the wrong train deliberately, one stop, get off, look around",
    kind: "explore",
    slots: [],
    verification: "photo",
    photo_bonus_max: 2,
    axes: axes(range(3, 3), range(2, 2), range(3, 3), range(3, 4), range(3, 4), range(2, 3)),
    indoor: false,
    typical_cost: "low",
    duration: "medium",
    fixedMinutes: 45,
    needs_stranger: false,
    interests: ["weird"],
  },
  {
    id: "line_to_end",
    archetype: "follow {transit_line} to the end of the line",
    kind: "explore",
    slots: [{ key: "transit_line", kind: "transit_line" }],
    verification: "photo",
    photo_bonus_max: 2,
    axes: axes(range(2, 3), range(1, 2), range(4, 5), range(4, 5), range(3, 4), range(2, 3)),
    indoor: false,
    typical_cost: "low",
    duration: "challenging",
    fixedMinutes: 150,
    needs_stranger: false,
    interests: ["weird", "nature"],
  },
  {
    id: "highest_point",
    archetype: "find the highest publicly accessible point in {neighborhood}",
    kind: "challenge",
    slots: [{ key: "neighborhood", kind: "neighborhood" }],
    verification: "photo",
    photo_bonus_max: 3,
    axes: axes(range(2, 3), range(3, 4), range(3, 3), range(3, 4), range(2, 3), range(3, 4)),
    indoor: false,
    typical_cost: "low",
    duration: "medium",
    fixedMinutes: 50,
    needs_stranger: false,
    interests: ["architecture", "nature"],
  },

  // SIGHTS: the weakest archetype ("go look at X"). Kept for the fallback.
  {
    id: "photo_subject_before_time",
    archetype: "photograph {subject} before {time}",
    kind: "explore",
    slots: [
      { key: "subject", kind: "subject" },
      { key: "time", kind: "time" },
    ],
    verification: "photo",
    photo_bonus_max: 3,
    axes: axes(range(1, 2), range(2, 3), range(2, 2), range(1, 3), range(1, 2), range(2, 4)),
    indoor: false,
    typical_cost: "low",
    duration: "light",
    venue: "place",
    needs_stranger: false,
    interests: ["architecture"],
    lookOnly: true,
  },

  // ACQUISITION
  {
    id: "buy_keep",
    archetype: "buy something under {amount} you will actually keep",
    kind: "creative",
    slots: [{ key: "amount", kind: "amount" }],
    verification: "photo",
    photo_bonus_max: 2,
    axes: axes(range(2, 2), range(1, 1), range(2, 2), range(1, 2), range(2, 3), range(2, 3)),
    indoor: true,
    typical_cost: "low",
    duration: "light",
    venue: "shop",
    needs_stranger: false,
    interests: ["shopping"],
  },
  {
    id: "buy_unidentifiable",
    archetype: "buy something you cannot identify",
    kind: "creative",
    slots: [],
    verification: "photo",
    photo_bonus_max: 2,
    axes: axes(range(2, 2), range(1, 1), range(1, 1), range(2, 3), range(3, 3), range(1, 2)),
    indoor: true,
    typical_cost: "low",
    duration: "sidequest",
    fixedMinutes: 10,
    needs_stranger: false,
    interests: ["shopping", "weird"],
  },

  // TIME
  {
    id: "awake_before",
    archetype: "be awake and outside before {early_time}",
    kind: "challenge",
    slots: [{ key: "early_time", kind: "early_time" }],
    verification: "photo",
    photo_bonus_max: 2,
    axes: axes(range(1, 1), range(2, 2), range(2, 2), range(2, 2), range(2, 3), range(3, 4)),
    indoor: false,
    typical_cost: "low",
    duration: "light",
    fixedMinutes: 30,
    needs_stranger: false,
    interests: ["nature"],
    when: "morning",
  },
  {
    id: "stay_one_hour",
    archetype: "stay in one place for an hour doing nothing",
    kind: "culture",
    slots: [],
    verification: "honor",
    photo_bonus_max: 1,
    axes: axes(range(2, 2), range(1, 1), range(3, 3), range(1, 2), range(2, 3), range(2, 2)),
    indoor: false,
    typical_cost: "low",
    duration: "medium",
    fixedMinutes: 60,
    needs_stranger: false,
    interests: ["nature"],
  },

  // GROUP: never on a solo trip
  {
    id: "split_strangest",
    archetype: "split up for an hour, meet back with the strangest thing you found",
    kind: "creative",
    slots: [],
    verification: "photo",
    photo_bonus_max: 3,
    axes: axes(range(3, 3), range(2, 2), range(3, 3), range(3, 4), range(3, 3), range(2, 3)),
    indoor: false,
    typical_cost: "low",
    duration: "medium",
    fixedMinutes: 70,
    needs_stranger: false,
    interests: ["weird", "shopping"],
    groupOnly: true,
  },


  // MUSEUMS AND NIGHTLIFE: so those interests have somewhere to land.
  {
    id: "museum_staff_pick",
    archetype: "ask someone working at {museum} which piece they would save in a fire, then go find it",
    kind: "culture",
    slots: [{ key: "museum", kind: "museum" }],
    verification: "photo",
    photo_bonus_max: 2,
    axes: axes(range(4, 4), range(1, 2), range(4, 4), range(3, 4), range(4, 5), range(2, 3)),
    indoor: true,
    typical_cost: "medium",
    duration: "challenging",
    venue: "museum",
    needs_stranger: true,
    interests: ["museums"],
  },
  {
    id: "oldest_thing",
    archetype: "find the oldest thing you can touch in {neighborhood}, and find out how old it is",
    kind: "culture",
    slots: [{ key: "neighborhood", kind: "neighborhood" }],
    verification: "photo",
    photo_bonus_max: 2,
    axes: axes(range(2, 3), range(2, 2), range(3, 3), range(3, 4), range(4, 5), range(2, 3)),
    indoor: false,
    typical_cost: "low",
    duration: "medium",
    fixedMinutes: 60,
    needs_stranger: false,
    interests: ["museums", "architecture"],
  },
  {
    id: "bartender_pick",
    archetype: "get a bartender in {neighborhood} to make you whatever they are proudest of",
    kind: "social",
    slots: [{ key: "neighborhood", kind: "neighborhood" }],
    verification: "honor",
    photo_bonus_max: 1,
    axes: axes(range(3, 4), range(1, 1), range(3, 3), range(2, 3), range(3, 4), range(2, 3)),
    indoor: true,
    typical_cost: "medium",
    duration: "medium",
    venue: "bar",
    needs_stranger: true,
    alcohol: true,
    interests: ["nightlife"],
    when: "evening",
  },
  {
    id: "loudest_place",
    archetype: "find the loudest place in {neighborhood} after 9pm and stay for one whole song",
    kind: "explore",
    slots: [{ key: "neighborhood", kind: "neighborhood" }],
    verification: "photo",
    photo_bonus_max: 2,
    axes: axes(range(2, 3), range(1, 2), range(2, 2), range(2, 3), range(3, 3), range(2, 3)),
    indoor: true,
    typical_cost: "low",
    duration: "light",
    fixedMinutes: 20,
    needs_stranger: false,
    interests: ["nightlife", "weird"],
    when: "evening",
  },

  // ---------------------------------------------------------------------------
  // More templates go here. Hand-write them. Do not generate filler. Keep
  // kind, duration (with the time axis range inside it), needs_stranger,
  // blind_food, alcohol, interests, venue /
  // leg / fixedMinutes, verification, photo_bonus_max, indoor, typical_cost
  // and axis ranges on every row. verification "photo" means a photo can add
  // bonus points; code claims still resolve.
  // ---------------------------------------------------------------------------
];

export function templateById(id: string | null | undefined): TaskTemplate | null {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}

// Templates that can go on a daily board: main tasks only (sidequests fill
// the gaps between them), and nothing needing a group on a solo trip.
export function boardTemplates(opts: { solo: boolean }): TaskTemplate[] {
  return TEMPLATES.filter(
    (t) => t.duration !== "sidequest" && !(opts.solo && t.groupOnly),
  );
}

export function sidequestTemplates(): TaskTemplate[] {
  return TEMPLATES.filter((t) => t.duration === "sidequest");
}

export function fillArchetype(
  archetype: string,
  values: Record<string, string>,
): string {
  return archetype.replace(/\{([a-z_]+)\}/g, (_, key: string) => {
    return values[key] ?? `{${key}}`;
  });
}

export function midpointAxes(template: TaskTemplate): Axes {
  const out = {} as Axes;
  for (const key of Object.keys(template.axes) as (keyof Axes)[]) {
    const { min, max } = template.axes[key];
    out[key] = Math.round((min + max) / 2);
  }
  return out;
}
