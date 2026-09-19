import type { Axes } from "./scoring";

export type SeedVerification = "photo" | "honor" | "peer";
// "photo" is a bonus hint (see photo_bonus_max), not a claim requirement. "peer" still needs a tapback.

export type HandWrittenTask = {
  code: string;
  title: string;
  axes: Axes;
  verification: SeedVerification;
  photo_bonus_max: number;
  neighborhood: string;
};

// Day-1 board (letter A). Axes are explicit; points come from scoring.ts.
export const HAND_WRITTEN_DAY1_TASKS: HandWrittenTask[] = [
  {
    code: "A1",
    title: "eat something starting with a-d",
    axes: { boldness: 1, physical: 1, time: 1, scarcity: 1, cultural: 1, aesthetics: 1 },
    verification: "honor",
    photo_bonus_max: 0,
    neighborhood: "anywhere",
  },
  {
    code: "A2",
    title: "name a smell you didn't expect",
    axes: { boldness: 2, physical: 1, time: 1, scarcity: 1, cultural: 2, aesthetics: 1 },
    verification: "honor",
    photo_bonus_max: 0,
    neighborhood: "anywhere",
  },
  {
    code: "A3",
    title: "photograph a doorway older than you",
    axes: { boldness: 3, physical: 2, time: 1, scarcity: 1, cultural: 1, aesthetics: 2 },
    verification: "photo",
    photo_bonus_max: 2,
    neighborhood: "anywhere",
  },
  {
    code: "A4",
    title: "find a vending machine drink nobody recognizes",
    axes: { boldness: 3, physical: 3, time: 2, scarcity: 2, cultural: 2, aesthetics: 2 },
    verification: "photo",
    photo_bonus_max: 3,
    neighborhood: "anywhere",
  },
  {
    code: "A5",
    title: "photograph a street that has no english on it",
    axes: { boldness: 4, physical: 3, time: 2, scarcity: 2, cultural: 2, aesthetics: 2 },
    verification: "photo",
    photo_bonus_max: 3,
    neighborhood: "anywhere",
  },
  {
    code: "A6",
    title: "get a photo from a viewpoint you had to climb to",
    axes: { boldness: 3, physical: 3, time: 3, scarcity: 3, cultural: 3, aesthetics: 3 },
    verification: "photo",
    photo_bonus_max: 4,
    neighborhood: "anywhere",
  },
  {
    code: "A7",
    title: "learn one phrase from a stranger and use it",
    axes: { boldness: 4, physical: 3, time: 3, scarcity: 3, cultural: 3, aesthetics: 2 },
    verification: "peer",
    photo_bonus_max: 0,
    neighborhood: "anywhere",
  },
  {
    code: "A8",
    title: "get somewhere with no maps and no transit",
    axes: { boldness: 4, physical: 4, time: 3, scarcity: 3, cultural: 3, aesthetics: 3 },
    verification: "peer",
    photo_bonus_max: 0,
    neighborhood: "anywhere",
  },
  {
    code: "A9",
    title: "order by pointing, no shared language",
    axes: { boldness: 3, physical: 2, time: 2, scarcity: 2, cultural: 2, aesthetics: 1 },
    verification: "honor",
    photo_bonus_max: 0,
    neighborhood: "anywhere",
  },
  {
    code: "A10",
    title: "photograph something you cannot identify",
    axes: { boldness: 5, physical: 4, time: 4, scarcity: 3, cultural: 3, aesthetics: 3 },
    verification: "photo",
    photo_bonus_max: 5,
    neighborhood: "anywhere",
  },
];
