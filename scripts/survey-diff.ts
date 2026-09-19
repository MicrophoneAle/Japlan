import { loadEnvConfig } from "@next/env";
import { generateTasksForAssignee, fillTemplatesDeterministically, isCurveballBoard } from "../lib/game/generate";
import {
  boardPreferencesFor,
  personalizationFor,
  planFromProposals,
  templatesAllowedFor,
  type PlannedTask,
} from "../lib/game/plan-board";
import { candidatesToRequest, maxTaskMinutes, paceFor, targetMinutes, usableWindow } from "../lib/game/day-plan";
import { groupBlackouts, INTEREST_KEYS, interestPicksFor, promptPreferences } from "../lib/game/preferences";
import { pointsForBoard } from "../lib/game/scoring";
import { formatPersonalBoard } from "../lib/game/board";
import { boardTemplates } from "../lib/game/templates";
import { TOKYO_HAND_PROFILE } from "../lib/game/tokyo-profile";
import type { SurveyAnswers } from "../lib/game/survey";
import { clockLabel } from "../lib/game/time";

// Does the survey change the board? Two sharply opposed survey vectors, same
// trip, same day, same destination profile, live Gemini, printed side by
// side with what each one sent to the prompt and enforced as a filter. If
// the two boards look alike, personalization is not working.
//   npx tsx scripts/survey-diff.ts [difficulty]

loadEnvConfig(process.cwd(), true);

const v = (value: string) => ({ value });
const VECTORS: Record<string, SurveyAnswers> = {
  "social foodie": {
    interest_picks: v("food,nightlife"),
    sociability: v("love_it"),
    chaos: v("high"),
    chaos_dares: v("strangers, singing in public, unidentifiable food"),
    pace: v("early_and_moving"),
    budget: v("high"),
    drinking: v("yes"),
    food_adventure: v("anything, the weirder the better"),
    mobility: v("no_limits"),
    dietary: v("none"),
  },
  "quiet museum-goer": {
    interest_picks: v("museums,architecture"),
    sociability: v("rather_not"),
    chaos: v("low"),
    chaos_alternative: v("sketching, old buildings, sitting somewhere with a view"),
    pace: v("two_things_and_lunch"),
    budget: v("low"),
    drinking: v("no"),
    dietary: v("has_restriction"),
    dietary_detail: v("shellfish"),
    dietary_strictness: v("allergy"),
    mobility: v("has_limits"),
    blackout: v("calls 9-10am"),
  },
};

async function boardFor(answers: SurveyAnswers, difficulty: string) {
  const people = [answers];
  const window = usableWindow({
    boardTime: "08:00",
    pace: paceFor([answers.pace?.value]),
    blackouts: groupBlackouts(people),
  });
  const bank = boardTemplates({ solo: true });
  const templates = templatesAllowedFor(bank, people);
  const prefs = boardPreferencesFor({ answers: people, difficulty });
  const weather = { summary: "clear, 24C", indoorPreferred: false, temperatureC: 24, precipitationChance: 0 };
  const promptFields = [...Object.keys(promptPreferences(answers)), "sociability"];
  const proposals = await generateTasksForAssignee({
    profile: TOKYO_HAND_PROFILE,
    weather,
    preferenceText: Object.entries(promptPreferences(answers)).map(([k, val]) => `${k}: ${val}`).join("; "),
    completedTitles: [],
    yesterdayRatings: "",
    scoreGap: "solo trip",
    day: 2,
    difficulty,
    templates,
    curveball: isCurveballBoard("survey-diff:2:together"),
    count: candidatesToRequest(window),
    plan: {
      windowText: `${clockLabel(window.startMinutes)} to ${clockLabel(window.endMinutes)}`,
      usableMinutes: window.usableMinutes,
      targetMinutes: targetMinutes(window),
      maxTaskMinutes: maxTaskMinutes(window),
      lateStart: false,
    },
    sociability: prefs.sociability,
    interests: INTEREST_KEYS.filter((k) => interestPicksFor(answers).includes(k)).map((key) => ({ key, share: 1 })),
  });
  const rejected: string[] = [];
  const fallback = [0, 1, 2, 3].flatMap((variant) =>
    fillTemplatesDeterministically({ profile: TOKYO_HAND_PROFILE, weather, templates, count: templates.length, seed: 14 + variant * 5 }),
  );
  const planned = planFromProposals({
    proposals,
    fallback,
    ctx: {
      profile: TOKYO_HAND_PROFILE,
      solo: true,
      window,
      assignees: [{ answers }],
      completedTitles: [],
      expiresAt: new Date("2026-10-18T15:00:00Z"),
      now: new Date("2026-10-17T00:00:00Z"),
      onReject: (reason, title) => rejected.push(`${reason}: ${title}`),
    },
    prefs,
  });
  return {
    planned,
    rejected,
    proposed: proposals.length,
    personalization: personalizationFor({ answers: people, prefs, window, offered: templates.length, total: bank.length, promptFields }),
  };
}

function render(tasks: PlannedTask[]): string[] {
  return formatPersonalBoard({
    day: 2,
    tasks: tasks.map((t, i) => ({
      code: `B${i + 1}`,
      title: t.title,
      base_points: pointsForBoard(t.axes, { day: 2, tripDays: 4 }).points,
      slot: t.slot,
      neighborhood: t.resolvedNeighborhood,
    })),
  }).split("\n");
}

function wrap(line: string, width: number): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > width) {
    const cut = rest.lastIndexOf(" ", width);
    const at = cut > 20 ? cut : width;
    out.push(rest.slice(0, at));
    rest = `           ${rest.slice(at).trimStart()}`;
  }
  out.push(rest);
  return out;
}

async function main() {
  const difficulty = process.argv[2] ?? "normal";
  const names = Object.keys(VECTORS);
  const results = await Promise.all(names.map((n) => boardFor(VECTORS[n], difficulty)));
  const width = 70;
  const cols = results.map((r) => render(r.planned.tasks).flatMap((l) => wrap(l, width)));
  console.log(`difficulty: ${difficulty} (trip-level, same for both)\n`);
  console.log(names.map((n) => n.toUpperCase().padEnd(width)).join(" | "));
  console.log(names.map(() => "-".repeat(width)).join("-+-"));
  for (let i = 0; i < Math.max(...cols.map((c) => c.length)); i++) {
    console.log(cols.map((c) => (c[i] ?? "").padEnd(width)).join(" | "));
  }
  results.forEach((r, i) => {
    const t = r.planned.tasks;
    const mean = (xs: number[]) => (xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)).toFixed(1);
    console.log(`\n== ${names[i]}`);
    console.log(`  proposed ${r.proposed}, rejected ${r.rejected.length}, on board ${t.length}, fallback used ${r.planned.usedFallback}`);
    console.log(`  stranger tasks ${t.filter((x) => x.stranger).length}, mean boldness ${mean(t.map((x) => x.axes.boldness))}, kinds ${[...new Set(t.map((x) => x.kind))].join("/")}`);
    console.log(`  personalization ${JSON.stringify(r.personalization)}`);
    for (const reason of r.rejected) console.log(`  rejected ${reason}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
