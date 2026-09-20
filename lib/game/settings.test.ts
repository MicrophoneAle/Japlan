import { describe, expect, it } from "vitest";
import { applySettingUpdate, settingIdFor, settingsSummary } from "./settings";
import { selectForDay, usableWindow, type Plannable } from "./day-plan";
import { CONVERSATION_SYSTEM_PROMPT, HELP_TEXT } from "./copy";
import { answerValue, type SurveyAnswers } from "./survey";
import { compatAnswers, prefsOf } from "./prefs";

const v = (value: string) => ({ value });
const set = (answers: SurveyAnswers, setting: string, value: string, mode?: "set" | "add" | "remove") =>
  applySettingUpdate({ answers, setting, value, mode });

describe("everyone's own answers are editable, in plain words", () => {
  const me: SurveyAnswers = {
    pace: v("two_things_and_lunch"),
    budget: v("low"),
    interest_picks: v("food"),
    sociability: v("rather_not"),
  };

  it("pace: faster, chaotic, back to in between", () => {
    expect(set(me, "pace", "faster")).toMatchObject({ ok: true, shown: "early and moving" });
    expect(set(me, "pace", "the highest possible")).toMatchObject({ ok: true, shown: "early and moving" });
    expect(set(me, "pace", "somewhere in between")).toMatchObject({ ok: true, shown: "somewhere in between" });
    expect(set(me, "pace", "slower")).toMatchObject({ ok: true, shown: "two things and lunch" });
  });

  it("budget: a number goes to its band", () => {
    const update = set(me, "budget", "150 a day");
    expect(update.ok && update.answers.budget).toEqual({ value: "high" });
    expect(set(me, "budget", "$15").ok && set(me, "budget", "$15")).toMatchObject({ shown: "low" });
  });

  it("interests: add one without losing the other", () => {
    const update = set(me, "interests", "museums", "add");
    expect(update.ok && update.answers.interest_picks).toEqual({ value: "museums,food" });
    const removed = set({ interest_picks: v("museums,food") }, "interests", "food", "remove");
    expect(removed.ok && removed.answers.interest_picks).toEqual({ value: "museums" });
  });

  it("strangers: fine now, or small doses", () => {
    expect(set(me, "strangers", "i'm fine talking to strangers now")).toMatchObject({ ok: true, shown: "love it" });
    expect(set(me, "sociability", "in small doses")).toMatchObject({ ok: true, shown: "fine in small doses" });
  });

  it("tasks per day: a number, more, or back to the default", () => {
    expect(set(me, "tasks per day", "7")).toMatchObject({ ok: true, shown: "7 a day" });
    const more = applySettingUpdate({ answers: me, setting: "more tasks", value: "more", currentTasks: 3 });
    expect(more).toMatchObject({ ok: true, shown: "5 a day" });
    expect(set({ tasks_per_day: v("7") }, "tasks per day", "back to default")).toMatchObject({ ok: true, shown: "the pace default" });
  });

  // Diet and allergy language goes to hard_constraints, which is where
  // validation reads it from. dietary/dietary_detail are DERIVED from that by
  // compatAnswers, so writing them directly was regenerated away on the next
  // read: acknowledged, then silently ignored. See constraint-correction.test.
  it("diet: saying what it is sets it, none clears it", () => {
    const update = set({ dietary: v("none") }, "diet", "peanuts");
    expect(update.ok && answerValue(update.answers, "hard_constraints")).toBe("peanuts");
    // And reading it back the way the generator does produces the old fields.
    const read = update.ok ? compatAnswers(update.answers, prefsOf(null, update.answers)) : {};
    expect(read).toMatchObject({ dietary: v("has_restriction"), dietary_detail: v("peanuts") });

    const cleared = set(update.ok ? update.answers : {}, "diet", "none");
    expect(cleared.ok && answerValue(cleared.answers, "hard_constraints")).toBe("none");
    const clearedRead = cleared.ok ? compatAnswers(cleared.answers, prefsOf(null, cleared.answers)) : {};
    expect(clearedRead.dietary).toEqual(v("none"));
  });

  it("re-asks with the options when a value cannot be read, never refuses", () => {
    expect(set(me, "budget", "hmm")).toEqual({ ok: false, id: "budget", options: ["low", "medium", "high", "or a daily amount"] });
    expect(settingIdFor("my speed")).toBe("pace");
    expect(set(me, "favourite colour", "blue")).toEqual({ ok: false, id: null, options: [] });
  });

  it("lists current values for japlan settings", () => {
    expect(settingsSummary(me)).toContain("pace: two things and lunch");
    expect(settingsSummary(me)).toContain("talking to strangers: rather not");
    expect(settingsSummary(me)).toContain("tasks per day: the pace default");
  });
});

describe("a task count is a request, not a cap", () => {
  const task = (i: number, minutes = 50): Plannable & { id: number } => ({
    id: i,
    minutes,
    coords: null,
    stranger: i === 0,
    kind: `k${i}`,
  });

  it("pace sets the default; asking for seven gets seven when they fit", () => {
    const relaxed = usableWindow({ boardTime: "08:00", pace: "relaxed" });
    const pool = Array.from({ length: 10 }, (_, i) => task(i));
    expect(selectForDay(pool, relaxed).length).toBeLessThan(7);
    expect(selectForDay(pool, relaxed, { targetCount: 7 })).toHaveLength(7);
  });

  it("gives fewer only when the day has no more room", () => {
    const evening = usableWindow({ boardTime: "08:00", pace: "steady", nowMinutes: 19 * 60 });
    const pool = Array.from({ length: 10 }, (_, i) => task(i, 45));
    const chosen = selectForDay(pool, evening, { targetCount: 7 });
    expect(chosen.length).toBeLessThan(7);
    expect(chosen.reduce((sum, t) => sum + t.minutes, 0)).toBeLessThanOrEqual(evening.usableMinutes);
  });
});

describe("the model is told it does not enforce rules", () => {
  it("says so, and lists the tools that do the things people ask for", () => {
    expect(CONVERSATION_SYSTEM_PROMPT).toContain("never tell someone they cannot do something because of a rule you believe exists");
    expect(CONVERSATION_SYSTEM_PROMPT).toContain("editable at any time by the person they belong to");
    expect(CONVERSATION_SYSTEM_PROMPT).toContain("a failed tool call is better than a wrong refusal");
    for (const tool of ["request_tasks", "update_my_setting", "update_trip_setting", "redo_today"]) {
      expect(CONVERSATION_SYSTEM_PROMPT).toContain(tool);
    }
    // The line that told it to refuse new tasks is gone.
    expect(CONVERSATION_SYSTEM_PROMPT).not.toMatch(/point at an open one/);
    expect(HELP_TEXT.dm).not.toMatch(/3 personal tasks/);
  });
});
