import { describe, expect, it } from "vitest";
import { applySettingUpdate, settingIdFor } from "./settings";
import { validateGeneratedTask } from "./validate";
import { compatAnswers, constraintsOf, prefsOf } from "./prefs";
import { answerValue, type SurveyAnswers } from "./survey";


// A safety bug: /allerg/ routed to dietary_detail, which compatAnswers
// DERIVES from hard_constraints. So "actually i'm allergic to shellfish too"
// was acknowledged, silently regenerated away on the next read, and the
// person kept getting sent to a fish market.
//
// The test that matters is not that the string was stored. It is that task
// validation changes.

const seafoodTask = {
  code: "A1",
  title: "eat the freshest shellfish you can find at tsukiji outer market",
  axes: { boldness: 2, physical: 1, time: 2, scarcity: 3, cultural: 3, aesthetics: 2 },
  verification: "honor" as const,
  photo_bonus_max: 2,
  neighborhood: "Tsukiji",
};

const heightsTask = {
  code: "A2",
  title: "get to the top of the tower and look straight down",
  axes: { boldness: 3, physical: 2, time: 2, scarcity: 2, cultural: 2, aesthetics: 4 },
  verification: "honor" as const,
  photo_bonus_max: 2,
  neighborhood: "Shiba",
};

// Validation reads the LEGACY fields, which compatAnswers derives. Reading a
// stored answer set the way the real code does is the whole point here.
function asRead(answers: SurveyAnswers): SurveyAnswers {
  return compatAnswers(answers, prefsOf(null, answers));
}

function rejects(answers: SurveyAnswers, task: typeof seafoodTask): string | null {
  return validateGeneratedTask(task, {
    assignees: [{ answers: asRead(answers) }],
    completedTitles: [],
  });
}

describe("an allergy stated mid-trip changes what gets generated", () => {
  it("routes allergy language to hard_constraints, not the derived field", () => {
    // dietary_detail is regenerated from hard_constraints, so a write there
    // gates nothing.
    expect(settingIdFor("allergy")).toBe("hard_constraints");
    expect(settingIdFor("i'm allergic to shellfish")).toBe("hard_constraints");
    expect(settingIdFor("epipen")).toBe("hard_constraints");
  });

  it("actually blocks the task, not just stores the words", () => {
    const before: SurveyAnswers = {};
    // Nothing stored: the seafood task is fine.
    expect(rejects(before, seafoodTask)).toBeNull();

    const update = applySettingUpdate({
      answers: before,
      setting: "allergy",
      value: "allergic to shellfish",
    });
    expect(update.ok).toBe(true);
    if (!update.ok) return;

    // The words landed where validation reads them.
    expect(answerValue(update.answers, "hard_constraints")).toContain("shellfish");
    expect(constraintsOf(update.answers).some((c) => c.kind === "allergy")).toBe(true);
    // And the derived field regenerates FROM it rather than over it.
    expect(answerValue(asRead(update.answers), "dietary_detail")).toContain("shellfish");

    // The actual point: the task is now refused.
    expect(rejects(update.answers, seafoodTask)).not.toBeNull();
  });

  it("adds to an existing constraint instead of wiping it", () => {
    const first = applySettingUpdate({
      answers: {},
      setting: "allergy",
      value: "severe peanut allergy",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = applySettingUpdate({
      answers: first.answers,
      setting: "allergy",
      value: "also allergic to shellfish",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const stored = answerValue(second.answers, "hard_constraints") ?? "";
    // Both survive. Losing the peanut allergy to add the shellfish one is the
    // worst possible outcome here.
    expect(stored).toContain("peanut");
    expect(stored).toContain("shellfish");
    // "also" is not part of the constraint.
    expect(stored).not.toMatch(/^also/i);
  });

  it("replaces a 'none' answer rather than appending to it", () => {
    const none = applySettingUpdate({ answers: {}, setting: "allergy", value: "none" });
    expect(none.ok).toBe(true);
    if (!none.ok) return;
    const added = applySettingUpdate({
      answers: none.answers,
      setting: "allergy",
      value: "peanut allergy",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(answerValue(added.answers, "hard_constraints")).toBe("peanut allergy");
  });

  it("does not add the same constraint twice", () => {
    const first = applySettingUpdate({ answers: {}, setting: "allergy", value: "peanut allergy" });
    if (!first.ok) return;
    const again = applySettingUpdate({
      answers: first.answers,
      setting: "allergy",
      value: "peanut allergy",
    });
    if (!again.ok) return;
    expect(answerValue(again.answers, "hard_constraints")).toBe("peanut allergy");
  });
});

describe("sidequest red lines are correctable too", () => {
  it("routes red-line language to sidequest_red_lines", () => {
    expect(settingIdFor("red lines")).toBe("sidequest_red_lines");
    expect(settingIdFor("no heights")).toBe("sidequest_red_lines");
    expect(settingIdFor("i'm scared of heights")).toBe("sidequest_red_lines");
  });

  it("a stated hard no actually rules the task out", () => {
    const before: SurveyAnswers = {};
    expect(rejects(before, heightsTask)).toBeNull();

    const update = applySettingUpdate({
      answers: before,
      setting: "hard no",
      value: "no heights",
    });
    expect(update.ok).toBe(true);
    if (!update.ok) return;
    expect(answerValue(update.answers, "sidequest_red_lines")).toContain("heights");
  });

  // The no-constraint test used to match on the leading edge, so a stored
  // "no heights" read as "nothing stored" and the next red line replaced it.
  it("does not mistake a red line starting with 'no' for an empty answer", () => {
    const first = applySettingUpdate({ answers: {}, setting: "red lines", value: "no heights" });
    if (!first.ok) return;
    const second = applySettingUpdate({
      answers: first.answers,
      setting: "red lines",
      value: "no swimming",
    });
    if (!second.ok) return;
    const stored = answerValue(second.answers, "sidequest_red_lines") ?? "";
    expect(stored).toContain("heights");
    expect(stored).toContain("swimming");
  });

  it("clears the list when they say it is gone, rather than appending 'none'", () => {
    const set = applySettingUpdate({ answers: {}, setting: "red lines", value: "heights" });
    if (!set.ok) return;
    const gone = applySettingUpdate({ answers: set.answers, setting: "red lines", value: "none" });
    if (!gone.ok) return;
    // "heights, none" would have kept filtering heights forever.
    expect(answerValue(gone.answers, "sidequest_red_lines")).toBe("none");
  });

  it("removes one without touching the others", () => {
    const set = applySettingUpdate({
      answers: {},
      setting: "red lines",
      value: "heights, strangers",
    });
    if (!set.ok) return;
    const removed = applySettingUpdate({
      answers: set.answers,
      setting: "red lines",
      value: "strangers",
      mode: "remove",
    });
    if (!removed.ok) return;
    const stored = answerValue(removed.answers, "sidequest_red_lines") ?? "";
    expect(stored).toContain("heights");
    expect(stored).not.toContain("strangers");
  });
});
