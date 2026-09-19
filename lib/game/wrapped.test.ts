import { describe, expect, it } from "vitest";
import { zeroStats } from "./stats";
import { buildWrappedData, WRAPPED_SOURCES } from "./wrapped";

const photo = { src: "/placeholder.jpg", alt: "placeholder" };

describe("Wrapped from real stats", () => {
  const data = buildWrappedData({
    trip: { name: "osaka", destination: "osaka, japan", start_date: "2026-09-20", end_date: "2026-09-24" },
    people: [
      { id: "a", name: "Ana", score: 40, favorite: "late nights out" },
      { id: "b", name: "Ben", score: 25, favorite: null },
      { id: "c", name: "Cy", score: 25, favorite: null },
    ],
    stats: {
      a: { ...zeroStats(), tasks_completed: 3, photos_submitted: 2, places_visited: 2 },
      b: { ...zeroStats(), tasks_completed: 2, places_visited: 1 },
      c: { ...zeroStats(), tasks_completed: 2 },
    },
    awarded: [
      { participantId: "a", title: "sing one line", points: 20, neighborhood: "Namba" },
      { participantId: "b", title: "ask a stranger", points: 18, neighborhood: "Umeda" },
      { participantId: "a", title: "eat standing up", points: 9, neighborhood: "Namba" },
      { participantId: "c", title: "wrong train", points: 12, neighborhood: null },
    ],
    placeholder: photo,
  });

  it("uses the real trip and group totals for the cards", () => {
    expect(data.trip).toEqual({ name: "osaka", destination: "osaka, japan", dates: "sep 20 to sep 24", days: 5 });
    expect(data.stats).toEqual([
      { value: "3", label: "friends unleashed" },
      { value: "3", label: "places visited" },
      { value: "7", label: "things done" },
      { value: "2", label: "camera-roll receipts" },
    ]);
    expect(data.totals.tasks_completed).toBe(7);
  });

  it("ranks with ties sharing a rank, and fills each person from their own rows", () => {
    expect(data.people.map((p) => [p.name, p.rank, p.quests])).toEqual([
      ["Ana", 1, 3],
      ["Ben", 2, 2],
      ["Cy", 2, 2],
    ]);
    expect(data.people[0]).toMatchObject({ favorite: "late nights out", moment: "sing one line" });
    expect(data.people[1].favorite).toBe("");
  });

  it("takes the three best claims as quests, and distinct places", () => {
    expect(data.quests.map((q) => [q.title, q.winner])).toEqual([
      ["sing one line", "Ana"],
      ["ask a stranger", "Ben"],
      ["wrong train", "Cy"],
    ]);
    expect(data.places).toEqual(["Namba", "Umeda"]);
  });

  it("says where each field comes from", () => {
    // Photos became real with the live page's claim-photos storage.
    expect(WRAPPED_SOURCES["people[].photo"].source).toBe("real");
    expect(WRAPPED_SOURCES["people[].quests"].source).toBe("real");
    expect(Object.values(WRAPPED_SOURCES).some((s) => s.source === "fictional")).toBe(false);
  });
});
