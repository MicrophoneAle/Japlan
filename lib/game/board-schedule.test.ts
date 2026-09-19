import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOARD_LOCAL_HOUR,
  CRON_UTC_HOUR,
  describeBoardTime,
  isBoardRequest,
  nextScheduledBoard,
} from "./board-schedule";
import { QUESTIONS, QUESTION_ORDER } from "./survey-questions";
import { GROUP_INTRO, SETUP_COMPLETE, SURVEY_DONE_DM, setupPrompt } from "./copy";
import { GROUP_ONLY_QUESTIONS, applyReply, startSurvey } from "./survey";
import { nextSetupQuestion } from "./setup";

describe("board schedule mirrors the cron", () => {
  it("uses the hour vercel.json actually schedules", () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8"));
    const schedule = vercel.crons.find((c: { path: string }) => c.path === "/api/cron/daily-board")
      .schedule as string;
    expect(schedule).toBe(`0 ${CRON_UTC_HOUR} * * *`);
    expect(BOARD_LOCAL_HOUR).toBe(8);
  });

  const tokyo = (now: string, todayBoardExists = false) =>
    nextScheduledBoard({
      state: "active",
      destination: "Tokyo",
      timezone: "Asia/Tokyo",
      now: new Date(now),
      todayBoardExists,
    });

  it("puts a Tokyo board at 8am local", () => {
    const noon = new Date("2026-09-19T03:00:00Z"); // 12:00 JST
    const next = tokyo(noon.toISOString());
    expect(next.at?.toISOString()).toBe("2026-09-19T23:00:00.000Z"); // 08:00 JST sept 20
    expect(describeBoardTime(next.at!, noon, "Asia/Tokyo")).toBe("tomorrow at 8am");

    const early = new Date("2026-09-19T22:30:00Z"); // 07:30 JST sept 20
    expect(describeBoardTime(tokyo(early.toISOString()).at!, early, "Asia/Tokyo")).toBe(
      "today at 8am",
    );
    // Today's board already posted: the cron skips today, so the next is tomorrow.
    expect(tokyo(early.toISOString(), true).at?.toISOString()).toBe("2026-09-20T23:00:00.000Z");
  });

  it("says so when the cron never reaches 8am in the trip's zone", () => {
    expect(
      nextScheduledBoard({
        state: "active",
        destination: "New York",
        timezone: "America/New_York",
        now: new Date("2026-09-19T03:00:00Z"),
        todayBoardExists: false,
      }),
    ).toEqual({ at: null, reason: "timezone_unscheduled" });
  });

  it("needs an active trip with a destination", () => {
    const base = { timezone: "Asia/Tokyo", now: new Date(), todayBoardExists: false };
    expect(nextScheduledBoard({ ...base, state: "surveying", destination: "Tokyo" })).toEqual({
      at: null,
      reason: "not_active",
    });
    expect(nextScheduledBoard({ ...base, state: "active", destination: null })).toEqual({
      at: null,
      reason: "no_destination",
    });
  });
});

describe("board requests", () => {
  it("recognises asking for the day's plan", () => {
    for (const text of [
      "Please give me the first day plans",
      "what's on the board?",
      "any tasks today",
      "show me my tasks",
      "japlan what's the plan for tomorrow",
    ]) {
      expect(isBoardRequest(text), text).toBe(true);
    }
  });

  it("leaves claims and chatter alone", () => {
    for (const text of ["did the ramen task", "finished the board lol", "that plan was great", "hey"]) {
      expect(isBoardRequest(text), text).toBe(false);
    }
  });
});

describe("solo trips skip group-only questions", () => {
  function walk(isSolo: boolean): string[] {
    let step = startSurvey();
    const seen = [step.state.awaiting as string];
    for (let guard = 0; step.state.awaiting !== "done" && guard < 40; guard++) {
      step = applyReply(step.state, "skip", { isSolo });
      seen.push(step.state.awaiting as string);
    }
    return seen;
  }

  it("never asks the social graph or competitiveness solo", () => {
    const solo = walk(true);
    for (const id of GROUP_ONLY_QUESTIONS) expect(solo).not.toContain(id);
    // Hard constraints and preferences still asked.
    for (const id of ["dietary", "mobility", "budget", "pace", "chaos"]) expect(solo).toContain(id);
  });

  it("still asks them in a group", () => {
    const group = walk(false);
    for (const id of ["social_with", "social_travelled", "social_couples", "competitiveness"]) {
      expect(group).toContain(id);
    }
  });

  it("drops the loser's stake from a solo setup", () => {
    expect(nextSetupQuestion("difficulty", { isSolo: true })).toBeNull();
    expect(nextSetupQuestion("difficulty", { isSolo: false })).toBe("stake");
    expect(setupPrompt("destination", null, { first: true, isSolo: true })).toMatch(
      /^trip setup, 3 quick ones\./,
    );
  });
});

describe("survey and setup copy", () => {
  const prompts = QUESTION_ORDER.map((id) => QUESTIONS[id].prompt);

  it("has no placeholder text left", () => {
    for (const text of [...prompts, GROUP_INTRO, SETUP_COMPLETE, SURVEY_DONE_DM]) {
      expect(text).not.toMatch(/PLACEHOLDER/);
    }
  });

  it("mentions skip once, in the first question only", () => {
    expect(QUESTIONS[QUESTION_ORDER[0]].prompt).toMatch(/skip/);
    for (const text of prompts.slice(1)) expect(text).not.toMatch(/skip/i);
  });

  it("follows the house style", () => {
    for (const text of [...prompts, GROUP_INTRO, SETUP_COMPLETE, SURVEY_DONE_DM]) {
      expect(text, text).not.toMatch(/!/);
      expect(text, text).not.toMatch(/\u2014/); // em dash
      expect(text, text).toBe(text.replace(/^[A-Z]/, (c) => c.toLowerCase())); // no capital start
      expect(text.split("\n"), text).toHaveLength(1);
    }
  });

  it("shows choice labels people can type back", () => {
    for (const id of QUESTION_ORDER) {
      const question = QUESTIONS[id];
      if (question.kind !== "choice") continue;
      for (const choice of question.choices ?? []) {
        expect(question.prompt, `${id}: ${choice.label}`).toContain(choice.label);
      }
    }
    // Internal ids never leak into what people read.
    expect(prompts.join(" ")).not.toMatch(/_/);
  });
});
