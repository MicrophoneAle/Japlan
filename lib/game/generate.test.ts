import { describe, expect, it } from "vitest";
import { parseGeneratedTasks } from "./generate";
import { pointsForBoard } from "./scoring";
import {
  validateGeneratedTask,
  type ProposedTask,
} from "./validate";

const allFives = {
  boldness: 5,
  physical: 5,
  time: 5,
  scarcity: 5,
  cultural: 5,
  aesthetics: 5,
};

const baseTask: ProposedTask = {
  code: "B1",
  title: "eat something starting with a-d",
  axes: {
    boldness: 1,
    physical: 1,
    time: 1,
    scarcity: 1,
    cultural: 1,
    aesthetics: 1,
  },
  verification: "honor",
  photo_bonus_max: 0,
  neighborhood: "anywhere",
};

describe("generated scoring", () => {
  it("lands all-5s axes in Challenging, not above the band ceiling", () => {
    const scored = pointsForBoard(allFives, { day: 1, tripDays: 5 });
    expect(scored.points).toBe(30);
    expect(scored.tier).toBe("Challenging");
  });

  it("computes points from scoring.ts and ignores a model point field", () => {
    const tasks = parseGeneratedTasks(
      JSON.stringify([
        {
          code: "B1",
          title: "photograph a doorway older than you",
          axes: {
            boldness: 3,
            physical: 2,
            time: 1,
            scarcity: 1,
            cultural: 1,
            aesthetics: 2,
          },
          verification: "photo",
          photo_bonus_max: 2,
          neighborhood: "Asakusa",
          points: 999,
          base_points: 999,
        },
      ]),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).not.toHaveProperty("points");
    const scored = pointsForBoard(tasks[0].axes, { day: 1, tripDays: null });
    expect(scored.points).toBe(12);
    expect(scored.points).not.toBe(999);
  });
});

describe("generation validation", () => {
  it("rejects an allergy conflict", () => {
    const reason = validateGeneratedTask(
      { ...baseTask, title: "eat unidentifiable street food" },
      {
        assignees: [
          {
            answers: {
              dietary: { value: "has_restriction" },
              dietary_strictness: { value: "allergy" },
            },
          },
        ],
        completedTitles: [],
      },
    );
    expect(reason).toBe("allergy");
  });

  it("rejects an over-budget task", () => {
    const reason = validateGeneratedTask(
      { ...baseTask, title: "a private helicopter tour" },
      {
        assignees: [{ answers: { budget: { value: "low" } } }],
        completedTitles: [],
      },
    );
    expect(reason).toBe("over_budget");
  });

  it("rejects a repeat of a completed task", () => {
    const reason = validateGeneratedTask(baseTask, {
      assignees: [{ answers: {} }],
      completedTitles: ["Eat something starting with a-d"],
    });
    expect(reason).toBe("duplicate");
  });
});
