import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOARD_TIME,
  boardDueNow,
  describeBoardTime,
  formatBoardTime,
  isBoardRequest,
  nextBoardAt,
  parseBoardDay,
  parseBoardTime,
  tripDayForDate,
} from "./board-schedule";
import { detectBoardTimeCommand } from "./commands";
import { QUESTIONS, QUESTION_ORDER, SURVEY_INTRO } from "./survey-questions";
import { GROUP_INTRO, SETUP_COMPLETE, SURVEY_DONE_DM, setupPrompt } from "./copy";
import { GROUP_ONLY_QUESTIONS, applyReply, startSurvey } from "./survey";
import { nextSetupQuestion } from "./setup";

// Tokyo trip, Sep 19 to 23. 2026-09-19 is a Saturday.
const tokyo = {
  start_date: "2026-09-19",
  end_date: "2026-09-23",
  timezone: "Asia/Tokyo",
  board_time: "08:00",
};
const jst = (local: string) => new Date(`${local}+09:00`);

describe("when a board is due", () => {
  it("is due at or after board_time, not only on the exact hour", () => {
    expect(boardDueNow(tokyo, jst("2026-09-20T07:59:00"))).toEqual({
      due: false,
      reason: "before_board_time",
    });
    expect(boardDueNow(tokyo, jst("2026-09-20T08:00:00"))).toEqual({
      due: true,
      date: "2026-09-20",
      day: 2,
    });
    // A tick hours late still posts the day's board: recovery, not a skip.
    expect(boardDueNow(tokyo, jst("2026-09-20T23:10:00"))).toMatchObject({ due: true, day: 2 });
  });

  it("follows a custom board_time", () => {
    const late = { ...tokyo, board_time: "10:30" };
    expect(boardDueNow(late, jst("2026-09-20T10:29:00")).due).toBe(false);
    expect(boardDueNow(late, jst("2026-09-20T10:30:00")).due).toBe(true);
  });

  it("works in any timezone, not just UTC+9", () => {
    const ny = { ...tokyo, timezone: "America/New_York" };
    expect(boardDueNow(ny, new Date("2026-09-20T12:05:00Z"))).toMatchObject({ due: true, day: 2 }); // 08:05 EDT
    const paris = { ...tokyo, timezone: "Europe/Paris" };
    expect(boardDueNow(paris, new Date("2026-09-20T06:05:00Z"))).toMatchObject({ due: true, day: 2 }); // 08:05 CEST
  });

  it("skips trips that have not started or have ended", () => {
    expect(boardDueNow(tokyo, jst("2026-09-18T09:00:00"))).toEqual({ due: false, reason: "not_started" });
    expect(boardDueNow(tokyo, jst("2026-09-24T09:00:00"))).toEqual({ due: false, reason: "ended" });
    expect(boardDueNow({ ...tokyo, start_date: null }, jst("2026-09-20T09:00:00")).due).toBe(false);
  });
});

describe("next board time", () => {
  it("is the first morning for a trip that has not started", () => {
    const now = jst("2026-09-17T12:00:00");
    const next = nextBoardAt(tokyo, now, { todayBoardExists: false })!;
    expect(next.date).toBe("2026-09-19");
    expect(describeBoardTime(next.at, now, tokyo.timezone)).toBe("sep 19 at 8am");
  });

  it("is tomorrow once today's board exists, and none after the trip", () => {
    const now = jst("2026-09-20T12:00:00");
    const next = nextBoardAt(tokyo, now, { todayBoardExists: true })!;
    expect(describeBoardTime(next.at, now, tokyo.timezone)).toBe("tomorrow at 8am");
    expect(nextBoardAt(tokyo, jst("2026-09-23T12:00:00"), { todayBoardExists: true })).toBeNull();
  });

  it("uses the trip's board_time", () => {
    const now = jst("2026-09-20T06:00:00");
    const next = nextBoardAt({ ...tokyo, board_time: "07:15" }, now, { todayBoardExists: false })!;
    expect(describeBoardTime(next.at, now, tokyo.timezone)).toBe("today at 7:15am");
  });
});

describe("board time parsing", () => {
  it("reads the usual ways people say a time", () => {
    expect(parseBoardTime("7am")).toBe("07:00");
    expect(parseBoardTime("7 am")).toBe("07:00");
    expect(parseBoardTime("10:30")).toBe("10:30");
    expect(parseBoardTime("10.30am")).toBe("10:30");
    expect(parseBoardTime("7:15pm")).toBe("19:15");
    expect(parseBoardTime("12am")).toBe("00:00");
    expect(parseBoardTime("noon")).toBe("12:00");
    expect(parseBoardTime("19:00")).toBe("19:00");
  });

  it("refuses ambiguous or impossible times", () => {
    expect(parseBoardTime("7")).toBeNull(); // am or pm?
    expect(parseBoardTime("25:00")).toBeNull();
    expect(parseBoardTime("13pm")).toBeNull();
    expect(parseBoardTime("morning")).toBeNull();
  });

  it("formats times the way people write them", () => {
    expect(formatBoardTime(DEFAULT_BOARD_TIME)).toBe("8am");
    expect(formatBoardTime("10:30")).toBe("10:30am");
    expect(formatBoardTime("19:00")).toBe("7pm");
    expect(formatBoardTime("00:00")).toBe("12am");
  });

  it("recognises the board time command", () => {
    expect(detectBoardTimeCommand("japlan board time 7am", "japlan")).toEqual({ time: "07:00" });
    expect(detectBoardTimeCommand("japlan board time 10:30", "japlan")).toEqual({ time: "10:30" });
    expect(detectBoardTimeCommand("japlan set board time to 9am", "japlan")).toEqual({ time: "09:00" });
    expect(detectBoardTimeCommand("japlan board time whenever", "japlan")).toEqual({ time: null });
    expect(detectBoardTimeCommand("board time 7am", "japlan")).toBeNull();
    expect(detectBoardTimeCommand("japlan plans", "japlan")).toBeNull();
  });
});

describe("which day a request means", () => {
  const opts = { today: "2026-09-19", startDate: "2026-09-19" };
  it("reads today, tomorrow, day N and weekdays", () => {
    expect(parseBoardDay("japlan plans", opts).date).toBe("2026-09-19");
    expect(parseBoardDay("japlan tomorrow", opts).date).toBe("2026-09-20");
    expect(parseBoardDay("japlan day 3", opts).date).toBe("2026-09-21");
    expect(parseBoardDay("japlan monday", opts).date).toBe("2026-09-21");
    expect(parseBoardDay("japlan saturday", opts)).toEqual({ date: "2026-09-19", label: "today" });
    expect(parseBoardDay("the day after tomorrow", opts).date).toBe("2026-09-21");
    expect(tripDayForDate("2026-09-19", "2026-09-21")).toBe(3);
  });

  it("reads calendar dates, first and last day, and plans before the trip", () => {
    const trip = { today: "2026-09-10", startDate: "2026-10-17", endDate: "2026-10-20" };
    expect(parseBoardDay("japlan oct 19", trip).date).toBe("2026-10-19");
    expect(parseBoardDay("japlan 19 october", trip).date).toBe("2026-10-19");
    expect(parseBoardDay("japlan the last day", trip)).toEqual({ date: "2026-10-20", label: "the last day" });
    expect(parseBoardDay("japlan first day", trip).date).toBe("2026-10-17");
    // No day named, trip not started: its first day, not a refusal.
    expect(parseBoardDay("japlan plans", trip)).toEqual({ date: "2026-10-17", label: "day 1" });
    // A new year's trip asked about in december rolls into the next year.
    expect(parseBoardDay("japlan jan 2", { today: "2026-12-20", startDate: "2026-12-30", endDate: "2027-01-03" }).date)
      .toBe("2027-01-02");
    for (const ask of ["japlan oct 19", "japlan the last day", "japlan first day"]) {
      expect(isBoardRequest(ask), ask).toBe(true);
    }
  });
});

describe("board requests", () => {
  it("recognises asking for a day's board", () => {
    for (const text of [
      "japlan plans",
      "japlan tasks",
      "japlan board",
      "japlan what am i doing today",
      "japlan give me the plans",
      "Please give me the first day plans",
      "japlan tomorrow",
      "japlan day 3",
      "japlan friday",
      "what's on the board?",
      "japlan sidequest",
      "japlan sidequests",
      "japlan quest",
      "japlan quests",
      "japlan give me a quest",
    ]) {
      expect(isBoardRequest(text), text).toBe(true);
    }
  });

  it("leaves claims and chatter alone", () => {
    for (const text of [
      "did the ramen task",
      "finished the board lol",
      "that plan was great",
      "hey",
      "japlan see you tomorrow at the hotel",
    ]) {
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

  it("never asks about splitting up solo", () => {
    const solo = walk(true);
    for (const id of GROUP_ONLY_QUESTIONS) expect(solo).not.toContain(id);
    // Hard constraints and preferences still asked.
    for (const id of ["ab_food_outdoors", "ab_pace", "budget_band", "hard_constraints", "must_have"]) expect(solo).toContain(id);
  });

  it("asks it in a group, and none of the old twenty questions", () => {
    const group = walk(false);
    expect(group).toContain("splitting");
    // first_name is not one of the retired twenty: v2 still opens with
    // "what should i call you?".
    expect(group).toContain("first_name");
    for (const id of ["dietary", "mobility", "chaos", "sociability", "social_travelled", "competitiveness"]) {
      expect(group).not.toContain(id);
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

  it("explains skip once, in the intro, and never again per question", () => {
    expect(SURVEY_INTRO).toMatch(/skip/i);
    for (const text of prompts) expect(text).not.toMatch(/skip/i);
  });

  it("follows the house style", () => {
    for (const text of [...prompts, GROUP_INTRO, SETUP_COMPLETE, SURVEY_DONE_DM]) {
      expect(text, text).not.toMatch(/!/);
      expect(text, text).not.toMatch(/\u2014/); // em dash
      expect(text, text).toBe(text.replace(/^[A-Z]/, (c) => c.toLowerCase())); // no capital start
      // The rule is one message, not one line: a question that lists its
      // options needs line breaks, and it is still a single send.
    }
  });

  it("numbers every choice, so people can answer with what they see", () => {
    for (const id of QUESTION_ORDER) {
      const question = QUESTIONS[id];
      // Follow-ups take any words; only the main choices list options.
      if (question.kind !== "choice" || id.startsWith("fu_")) continue;
      const choices = question.choices ?? [];
      for (let i = 0; i < choices.length; i += 1) {
        // "1 \u00b7 under $50": the number they type, starting its own line.
        expect(question.prompt, `${id}: choice ${i + 1}`).toMatch(
          new RegExp(`(^|\\n)${i + 1} \u00b7 `),
        );
      }
    }
    // Internal ids never leak into what people read.
    expect(prompts.join(" ")).not.toMatch(/[a-z]_[a-z]/);
  });
});
