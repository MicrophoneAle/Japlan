import type { WrappedData, WrappedPerson, WrappedPhoto, WrappedSlide } from "@/lib/game/wrapped";
import { zeroStats } from "@/lib/game/stats";

// FICTIONAL FIXTURE. The contract is WrappedData (lib/game/wrapped.ts); a real
// trip's data comes from wrappedDataFor (lib/handlers/wrapped.ts), and
// WRAPPED_SOURCES says which fields are real. This file only demos the shape.
export type Photo = WrappedPhoto;
export type Person = WrappedPerson;
export type { WrappedSlide };

export const photos: Photo[] = [
  { src: "/assets/images.jpg", alt: "Friends enjoying a Japlan trip memory" },
  { src: "/assets/images (1).jpg", alt: "A favourite moment from the trip" },
  { src: "/assets/images (2).jpg", alt: "A candid trip photograph" },
];

const people: Person[] = [
  { name: "Evan", score: 284, rank: 1, quests: 9, favorite: "Late-night bites", moment: "The Croissant Hunt", photo: photos[0] },
  { name: "Maya", score: 266, rank: 2, quests: 8, favorite: "Hidden galleries", moment: "Found the back-door exhibit", photo: photos[1] },
  { name: "Noah", score: 241, rank: 3, quests: 7, favorite: "Street food", moment: "Ordered entirely by pointing", photo: photos[2] },
  { name: "Zara", score: 241, rank: 3, quests: 7, favorite: "Golden-hour walks", moment: "The sunset detour", photo: photos[0] },
  { name: "Theo", score: 198, rank: 5, quests: 6, favorite: "Coffee stops", moment: "The espresso relay", photo: photos[1] },
];

export const demo = {
  trip: {
    name: "The long weekend that got competitive",
    destination: "Montréal",
    dates: "May 16 — 19, 2026",
    days: 4,
  },
  stats: [
    { value: "5", label: "friends unleashed" },
    { value: "18", label: "places on the itinerary" },
    { value: "32", label: "quests completed" },
    { value: "47", label: "camera-roll receipts" },
  ],
  totals: { ...zeroStats(), tasks_completed: 32, itinerary_items_total: 18, photos_submitted: 47 },
  places: ["Jean-Talon Market", "Old Montréal", "Mount Royal", "Mile End"],
  quests: [
    { title: "The Croissant Hunt", points: 34, winner: "Evan", photo: photos[0] },
    { title: "Say It With Your Hands", points: 28, winner: "Noah", photo: photos[2] },
    { title: "A View Worth Missing Dinner For", points: 31, winner: "Zara", photo: photos[1] },
  ],
  people,
  slides: [
    { type: "intro" },
    { type: "stats" },
    { type: "places" },
    { type: "quests" },
    { type: "leaderboard" },
    ...people.map((person, index) => ({ type: "person" as const, person, layout: (index % 3) as 0 | 1 | 2 })),
    { type: "photos" },
    { type: "finale" },
  ] satisfies WrappedSlide[],
} satisfies WrappedData;
