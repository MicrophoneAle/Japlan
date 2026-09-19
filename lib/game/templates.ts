import type { Axes } from "./scoring";
import type { SeedVerification } from "./hand-written-tasks";

export type SlotKind =
  | "letter_range"
  | "time"
  | "transport_mode"
  | "subject"
  | "neighborhood"
  | "dish"
  | "phrase";

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
  slots: TemplateSlot[];
  verification: SeedVerification;
  // photo_bonus_max is the bonus ceiling. verification "photo" is not a claim gate.
  photo_bonus_max: number;
  axes: Record<keyof Axes, AxisRange>;
  indoor: boolean;
  // Used only by the deterministic fallback, never sent as a model point value.
  typical_cost: "low" | "medium" | "high";
};

function range(min: number, max: number): AxisRange {
  return { min, max };
}

export const TEMPLATES: TaskTemplate[] = [
  {
    id: "eat_letter_range",
    archetype: "eat something starting with {letter_range}",
    slots: [{ key: "letter_range", kind: "letter_range" }],
    verification: "honor",
    photo_bonus_max: 0,
    axes: {
      boldness: range(1, 2),
      physical: range(1, 2),
      time: range(1, 2),
      scarcity: range(1, 2),
      cultural: range(1, 3),
      aesthetics: range(1, 2),
    },
    indoor: true,
    typical_cost: "low",
  },
  {
    id: "photo_subject_before_time",
    archetype: "photograph {subject} before {time}",
    slots: [
      { key: "subject", kind: "subject" },
      { key: "time", kind: "time" },
    ],
    verification: "photo",
    photo_bonus_max: 3,
    axes: {
      boldness: range(2, 3),
      physical: range(2, 3),
      time: range(1, 3),
      scarcity: range(1, 3),
      cultural: range(1, 2),
      aesthetics: range(2, 4),
    },
    indoor: false,
    typical_cost: "low",
  },
  {
    id: "landmark_without_transport",
    archetype: "get to {subject} without {transport_mode}",
    slots: [
      { key: "subject", kind: "subject" },
      { key: "transport_mode", kind: "transport_mode" },
    ],
    verification: "peer",
    photo_bonus_max: 0,
    axes: {
      boldness: range(3, 4),
      physical: range(3, 5),
      time: range(2, 4),
      scarcity: range(2, 3),
      cultural: range(2, 4),
      aesthetics: range(2, 3),
    },
    indoor: false,
    typical_cost: "low",
  },
  {
    id: "learn_phrase",
    archetype: "learn {phrase} from a stranger and use it",
    slots: [{ key: "phrase", kind: "phrase" }],
    verification: "peer",
    photo_bonus_max: 0,
    axes: {
      boldness: range(3, 5),
      physical: range(1, 2),
      time: range(1, 3),
      scarcity: range(2, 3),
      cultural: range(3, 5),
      aesthetics: range(1, 2),
    },
    indoor: true,
    typical_cost: "low",
  },
  {
    id: "neighborhood_dish",
    archetype: "eat {dish} in {neighborhood}",
    slots: [
      { key: "dish", kind: "dish" },
      { key: "neighborhood", kind: "neighborhood" },
    ],
    verification: "photo",
    photo_bonus_max: 2,
    axes: {
      boldness: range(2, 3),
      physical: range(2, 3),
      time: range(2, 3),
      scarcity: range(2, 3),
      cultural: range(3, 5),
      aesthetics: range(2, 3),
    },
    indoor: true,
    typical_cost: "medium",
  },

  // ---------------------------------------------------------------------------
  // Remaining templates go here. Hand-write them. Do not generate filler.
  // Aim for 20–30 archetypes covering a week: letter ranges, times, transport
  // modes, subjects, neighborhoods, dishes, phrases. Keep verification,
  // photo_bonus_max, indoor, typical_cost, and axis ranges on every row.
  // verification "photo" means a photo can add bonus points; code claims still resolve.
  // ---------------------------------------------------------------------------
];

export function fillArchetype(
  archetype: string,
  values: Record<string, string>,
): string {
  return archetype.replace(/\{([a-z_]+)\}/g, (_, key: string) => {
    return values[key] ?? `{${key}}`;
  });
}

export function midpointAxes(template: TaskTemplate): Axes {
  const axes = {} as Axes;
  for (const key of Object.keys(template.axes) as (keyof Axes)[]) {
    const { min, max } = template.axes[key];
    axes[key] = Math.round((min + max) / 2);
  }
  return axes;
}
