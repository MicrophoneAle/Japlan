import { describe, expect, it } from "vitest";
import {
  bandForMinutes,
  bandForTimeAxis,
  estimateTaskMinutes,
  frictionMinutes,
  reconcileTimeAxis,
  travelMinutes,
  venueMinutes,
} from "./duration";
import {
  assignSlots,
  dayMinutes,
  FILL_HIGH,
  FILL_LOW,
  MAX_MAIN_TASKS,
  orderRoute,
  paceFor,
  selectForDay,
  usableWindow,
  type Plannable,
} from "./day-plan";
import {
  boardTemplates,
  sidequestTemplates,
  TEMPLATES,
  midpointAxes,
} from "./templates";
import { computePoints, tierForPoints } from "./scoring";
import { TOKYO_HAND_PROFILE } from "./tokyo-profile";
import {
  boardConflict,
  planAssigneeBoard,
  prepareCandidates,
  resolvePlace,
  type Candidate,
  type PrepareContext,
} from "./plan-board";
import { fillTemplatesDeterministically, isCurveballBoard } from "./generate";
import type { ProposedTask } from "./validate";

const ASAKUSA = { lat: 35.7148, lng: 139.7967 };
const UENO = { lat: 35.7142, lng: 139.7773 };
const SHIBUYA = { lat: 35.6595, lng: 139.7004 };

describe("duration estimate", () => {
  it("splits bands at 20 min, 45 min and 2 h, and maps the time axis onto them", () => {
    expect([19, 20, 44, 45, 119, 120].map(bandForMinutes)).toEqual([
      "sidequest", "light", "light", "medium", "medium", "challenging",
    ]);
    expect([1, 2, 3, 4, 5].map(bandForTimeAxis)).toEqual([
      "sidequest", "light", "medium", "challenging", "challenging",
    ]);
  });

  it("reads venue time from the category, restaurants by price", () => {
    expect(venueMinutes("Coffee Shop")).toBe(30);
    expect(venueMinutes("Art Museum")).toBe(120);
    expect(venueMinutes("Scenic Lookout")).toBe(15);
    expect(venueMinutes("Food Hall")).toBe(45);
    expect(venueMinutes("Shinto Shrine")).toBe(30);
    expect(venueMinutes("Ramen Restaurant")).toBe(35);
    expect(venueMinutes("Italian Restaurant", 1)).toBe(35);
    expect(venueMinutes("Italian Restaurant", 4)).toBe(110);
    expect(venueMinutes("Something Unheard Of")).toBeNull();
  });

  it("travels by straight-line distance at a city speed, slower on foot", () => {
    const city = travelMinutes(ASAKUSA, SHIBUYA, "city");
    const walk = travelMinutes(ASAKUSA, SHIBUYA, "walk");
    expect(city).toBeGreaterThan(40);
    expect(city).toBeLessThan(80);
    expect(walk).toBeGreaterThan(city * 3);
    expect(travelMinutes(ASAKUSA, ASAKUSA)).toBe(5); // getting anywhere costs something
  });

  it("charges friction for boldness: a stranger task takes 20+ minutes with no venue or travel", () => {
    expect([1, 2, 3, 4, 5].map(frictionMinutes)).toEqual([0, 5, 20, 30, 40]);
    expect(estimateTaskMinutes({ boldness: 5 })).toBe(40);
    expect(estimateTaskMinutes({ boldness: 3 })).toBe(20);
    // Nothing known and not bold: the model's axis stands.
    expect(estimateTaskMinutes({ boldness: 1 })).toBeNull();
    expect(estimateTaskMinutes({ boldness: 2, venueCategory: "Coffee Shop" })).toBe(35);
  });

  it("overrides the model's time axis only when more than one band apart", () => {
    // Model says 1 (sidequest), code says 150 min (challenging): overridden.
    expect(reconcileTimeAxis(1, 150)).toEqual({ time: 4, minutes: 150, overridden: true });
    // One band apart: the model's axis stands, minutes kept inside its band.
    expect(reconcileTimeAxis(2, 60)).toEqual({ time: 2, minutes: 44, overridden: false });
    expect(reconcileTimeAxis(3, 60)).toEqual({ time: 3, minutes: 60, overridden: false });
    expect(reconcileTimeAxis(3, null)).toEqual({ time: 3, minutes: 80, overridden: false });
  });
});

describe("usable hours", () => {
  it("runs from board_time to a pace-based end of day, minus meals", () => {
    const steady = usableWindow({ boardTime: "08:00", pace: "steady" });
    expect(steady).toMatchObject({ startMinutes: 8 * 60 + 30, endMinutes: 21 * 60 });
    expect(steady.usableMinutes).toBe(750 - 75);
    const relaxed = usableWindow({ boardTime: "08:00", pace: "relaxed" });
    const chaotic = usableWindow({ boardTime: "08:00", pace: "chaotic" });
    // Relaxed ends at 20:00, so only part of dinner comes out: 120 * 270/300.
    expect(relaxed.usableMinutes).toBe(630 - 108);
    expect(chaotic.usableMinutes).toBe(840 - 45);
    // A relaxed group has fewer usable hours than a chaotic one.
    expect(relaxed.usableMinutes).toBeLessThan(steady.usableMinutes);
    expect(steady.usableMinutes).toBeLessThan(chaotic.usableMinutes);
  });

  it("follows board_time and shrinks to what is left when asked for today", () => {
    expect(usableWindow({ boardTime: "10:00", pace: "chaotic" }).startMinutes).toBe(600);
    const evening = usableWindow({ boardTime: "08:00", pace: "steady", nowMinutes: 18 * 60 });
    expect(evening.startMinutes).toBe(18 * 60);
    expect(evening.endMinutes).toBe(21 * 60);
    // Only the dinner part of the meal time comes out.
    expect(evening.usableMinutes).toBeGreaterThan(130);
    expect(evening.usableMinutes).toBeLessThan(180);
    // Past the usual end there is still an evening, up to midnight.
    const late = usableWindow({ boardTime: "08:00", pace: "steady", nowMinutes: 22 * 60 });
    expect(late).toMatchObject({ startMinutes: 22 * 60, endMinutes: 24 * 60 });
  });

  it("takes a group's majority pace", () => {
    expect(paceFor(["early_and_moving"])).toBe("chaotic");
    expect(paceFor(["two_things_and_lunch", "two_things_and_lunch", "early_and_moving"])).toBe("relaxed");
    expect(paceFor(["early_and_moving", "two_things_and_lunch"])).toBe("steady");
    expect(paceFor([null, undefined])).toBe("steady");
  });
});

type T = Plannable & { id: string };
const task = (id: string, minutes: number, extra: Partial<T> = {}): T => ({
  id,
  minutes,
  coords: null,
  stranger: false,
  kind: id,
  ...extra,
});

describe("filling the day", () => {
  const window = usableWindow({ boardTime: "08:00", pace: "steady" }); // 675 usable

  it("fills 60-70% of the day, not a fixed three", () => {
    const pool = Array.from({ length: 10 }, (_, i) => task(`t${i}`, 90));
    const chosen = selectForDay(pool, window);
    const total = dayMinutes(chosen);
    expect(total).toBeGreaterThanOrEqual(window.usableMinutes * FILL_LOW);
    expect(total).toBeLessThanOrEqual(window.usableMinutes * FILL_HIGH);
    expect(chosen.length).toBe(5);
    // A relaxed day gets fewer of the same tasks.
    const relaxed = usableWindow({ boardTime: "08:00", pace: "relaxed" });
    expect(selectForDay(pool, relaxed).length).toBeLessThan(chosen.length);
  });

  it("always puts a stranger task on when there is one", () => {
    const pool = [task("a", 90), task("b", 90), task("c", 90), task("d", 90), task("s", 40, { stranger: true })];
    expect(selectForDay(pool, window).some((t) => t.stranger)).toBe(true);
  });

  it("keeps kinds varied while other kinds are available", () => {
    const pool = [task("x1", 60, { kind: "explore" }), task("x2", 60, { kind: "explore" }), task("f", 60, { kind: "food" })];
    const chosen = selectForDay(pool, { ...window, usableMinutes: 200 });
    expect(chosen.map((t) => t.kind)).toEqual(["explore", "food"]);
  });

  it("never picks two tasks that conflict", () => {
    const pool = [task("a", 90, { kind: "one" }), task("a2", 90, { kind: "two" }), task("b", 90, { kind: "three" })];
    const chosen = selectForDay(pool, window, { conflicts: (x, y) => x.id[0] === y.id[0] });
    expect(chosen.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("orders located tasks along a route, not back and forth", () => {
    const ordered = orderRoute([
      task("shibuya", 60, { coords: SHIBUYA }),
      task("asakusa", 60, { coords: ASAKUSA }),
      task("anywhere", 60),
      task("ueno", 60, { coords: UENO }),
      task("dawn", 30, { when: "morning" }),
    ]);
    expect(ordered[0].id).toBe("dawn");
    const route = ordered.filter((t) => t.coords).map((t) => t.id);
    // Ueno sits between Asakusa and Shibuya, so it is never an end of the route.
    expect(route[1]).toBe("ueno");
    expect(ordered.map((t) => t.id)).toContain("anywhere");
  });

  it("labels morning, afternoon and evening from the spread-out day", () => {
    const slotted = assignSlots([task("a", 90), task("b", 90), task("c", 90)], window);
    expect(slotted.map((t) => t.slot)).toEqual(["morning", "afternoon", "evening"]);
    const lateWindow = usableWindow({ boardTime: "08:00", pace: "steady", nowMinutes: 18 * 60 });
    expect(assignSlots([task("a", 60)], lateWindow)[0].slot).toBe("evening");
  });
});

describe("template bank", () => {
  it("has the five originals plus the new archetypes", () => {
    expect(TEMPLATES).toHaveLength(28);
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(28);
  });

  it("keeps each template's time axis inside its duration band", () => {
    for (const t of TEMPLATES) {
      expect(bandForTimeAxis(t.axes.time.min), t.id).toBe(t.duration);
      expect(bandForTimeAxis(t.axes.time.max), t.id).toBe(t.duration);
    }
  });

  it("keeps sidequests off the board and group templates off solo boards", () => {
    expect(sidequestTemplates().map((t) => t.id).sort()).toEqual(
      ["buy_unidentifiable", "eat_letter_range", "eat_standing"],
    );
    expect(boardTemplates({ solo: true }).some((t) => t.duration === "sidequest" || t.groupOnly)).toBe(false);
    expect(boardTemplates({ solo: false }).some((t) => t.id === "split_strangest")).toBe(true);
  });

  it("spreads across the scoring space", () => {
    const tiers = new Set(boardTemplates({ solo: false }).map((t) => tierForPoints(computePoints(midpointAxes(t)))));
    expect(tiers).toEqual(new Set(["Light", "Medium", "Challenging"]));
    expect(TEMPLATES.filter((t) => t.needs_stranger).length).toBeGreaterThanOrEqual(5);
  });

  it("estimates every filled board template inside its declared band", () => {
    const ctx = context(usableWindow({ boardTime: "08:00", pace: "steady" }));
    const filled = fillTemplatesDeterministically({
      profile: TOKYO_HAND_PROFILE,
      weather: { summary: "clear", indoorPreferred: false, temperatureC: 22, precipitationChance: 0 },
      count: 99,
      templates: boardTemplates({ solo: false }),
    });
    const prepared = prepareCandidates(filled, ctx);
    expect(prepared).toHaveLength(filled.length);
    for (const c of prepared) {
      const template = TEMPLATES.find((t) => t.id === c.template)!;
      expect(bandForMinutes(c.minutes), `${c.template} ${c.minutes}`).toBe(template.duration);
    }
  });
});

function context(window: ReturnType<typeof usableWindow>, extra: Partial<PrepareContext> = {}): PrepareContext {
  return {
    profile: TOKYO_HAND_PROFILE,
    solo: false,
    window,
    assignees: [{ answers: {} }],
    completedTitles: [],
    expiresAt: new Date("2026-09-19T15:00:00Z"),
    now: new Date("2026-09-18T12:00:00Z"),
    ...extra,
  };
}

const proposal = (over: Partial<ProposedTask>): ProposedTask => ({
  code: "",
  title: "a task",
  axes: { boldness: 3, physical: 2, time: 3, scarcity: 3, cultural: 3, aesthetics: 2 },
  verification: "honor",
  photo_bonus_max: 0,
  neighborhood: "",
  ...over,
});

describe("preparing candidates", () => {
  const window = usableWindow({ boardTime: "08:00", pace: "steady" });

  it("rejects what is not a main task from the bank, and says why", () => {
    const reasons: string[] = [];
    const ctx = context(window, { solo: true, onReject: (reason) => reasons.push(reason) });
    const kept = prepareCandidates(
      [
        proposal({ title: "find a bench", template: undefined }),
        proposal({ title: "eat a thing starting with a", template: "eat_letter_range" }),
        proposal({ title: "split up and find something weird", template: "split_strangest" }),
        proposal({ title: "take the wrong train one stop", template: "wrong_train" }),
      ],
      ctx,
    );
    expect(reasons).toEqual(["no_template", "sidequest_template", "group_only"]);
    expect(kept.map((c) => c.template)).toEqual(["wrong_train"]);
  });

  it("lets code overrule a time axis that is two bands off", () => {
    const [c] = prepareCandidates(
      [proposal({ title: "ride the ginza line to the end", template: "line_to_end", axes: { boldness: 2, physical: 1, time: 2, scarcity: 4, cultural: 3, aesthetics: 2 } })],
      context(window),
    );
    expect(c.minutes).toBeGreaterThanOrEqual(150);
    expect(c.axes.time).toBe(4);
    expect(c.timeOverridden).toBe(true);
  });

  it("drops a task too long for what is left of the day, and a dawn task at 7pm", () => {
    const reasons: string[] = [];
    const evening = usableWindow({ boardTime: "08:00", pace: "steady", nowMinutes: 19 * 60 });
    const kept = prepareCandidates(
      [
        proposal({ title: "follow the yamanote line to the end", template: "line_to_end", axes: { boldness: 2, physical: 1, time: 5, scarcity: 4, cultural: 3, aesthetics: 2 } }),
        proposal({ title: "be outside before 6am", template: "awake_before", axes: { boldness: 1, physical: 2, time: 2, scarcity: 3, cultural: 2, aesthetics: 3 } }),
        proposal({ title: "compliment an outfit", template: "compliment_outfit", axes: { boldness: 5, physical: 1, time: 2, scarcity: 1, cultural: 3, aesthetics: 2 } }),
      ],
      context(evening, { onReject: (reason) => reasons.push(reason) }),
    );
    expect(reasons).toEqual(["too_long_for_window", "wrong_time_of_day"]);
    expect(kept.map((c) => c.template)).toEqual(["compliment_outfit"]);
  });

  it("places tasks on the profile map and keeps curveballs as curveballs", () => {
    expect(resolvePlace("Ueno", TOKYO_HAND_PROFILE)).toMatchObject({ name: "Ueno", neighborhood: "Ueno" });
    expect(resolvePlace("senso-ji temple", TOKYO_HAND_PROFILE)).toMatchObject({ name: "Senso-ji", neighborhood: "Asakusa" });
    const [c] = prepareCandidates(
      [proposal({ title: "bow to a vending machine at senso-ji", template: "curveball", places: ["Senso-ji"], kind: "culture", stranger: false })],
      context(window),
    );
    expect(c).toMatchObject({ source: "curveball", resolvedNeighborhood: "Asakusa", kind: "culture" });
  });
});

describe("planning a board", () => {
  const window = usableWindow({ boardTime: "08:00", pace: "steady" });
  const fallback = () =>
    prepareCandidates(
      fillTemplatesDeterministically({
        profile: TOKYO_HAND_PROFILE,
        weather: { summary: "clear", indoorPreferred: false, temperatureC: 22, precipitationChance: 0 },
        count: 99,
        templates: boardTemplates({ solo: true }),
      }),
      context(window, { solo: true }),
    );

  it("tops up a short model board from templates, with a stranger and no shared place or template", () => {
    const model = prepareCandidates(
      [proposal({ title: "take the wrong train one stop", template: "wrong_train" })],
      context(window),
    );
    const { tasks, usedFallback } = planAssigneeBoard({ modelPool: model, fallbackPool: fallback(), window });
    expect(usedFallback).toBe(true);
    expect(tasks[0]).toBeDefined();
    expect(tasks.some((t) => t.title === "take the wrong train one stop")).toBe(true);
    expect(tasks.some((t) => t.stranger)).toBe(true);
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    // Full to 60%, unless it hit the six-task cap with short tasks first.
    expect(
      dayMinutes(tasks) >= window.usableMinutes * FILL_LOW || tasks.length === MAX_MAIN_TASKS,
    ).toBe(true);
    for (let i = 0; i < tasks.length; i++) {
      for (let j = i + 1; j < tasks.length; j++) {
        expect(boardConflict(tasks[i], tasks[j]), `${tasks[i].title} / ${tasks[j].title}`).toBe(false);
      }
    }
    expect(tasks.every((t) => ["morning", "afternoon", "evening"].includes(t.slot))).toBe(true);
  });

  it("falls back to a template when the curveball fails validation, not a short board", () => {
    const reasons: string[] = [];
    const model = prepareCandidates(
      [proposal({ title: "get a tattoo of the tokyo tower", template: "curveball", kind: "culture" })],
      context(window, { onReject: (reason) => reasons.push(reason) }),
    );
    expect(reasons).toEqual(["permanent"]);
    const { tasks } = planAssigneeBoard({ modelPool: model as Candidate[], fallbackPool: fallback(), window });
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    expect(tasks.some((t) => t.source === "curveball")).toBe(false);
  });

  it("gives a 7pm request a short evening board, nothing challenging", () => {
    const evening = usableWindow({ boardTime: "08:00", pace: "steady", nowMinutes: 19 * 60 });
    const pool = prepareCandidates(
      fillTemplatesDeterministically({
        profile: TOKYO_HAND_PROFILE,
        weather: { summary: "clear", indoorPreferred: false, temperatureC: 22, precipitationChance: 0 },
        count: 99,
        templates: boardTemplates({ solo: true }),
      }),
      context(evening, { solo: true }),
    );
    const { tasks } = planAssigneeBoard({ modelPool: [], fallbackPool: pool, window: evening });
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks.length).toBeLessThanOrEqual(2);
    expect(tasks.every((t) => t.minutes < 120 && t.slot === "evening")).toBe(true);
  });
});

describe("curveballs", () => {
  it("land on roughly one board in four, the same way each time for a board", () => {
    const hits = Array.from({ length: 400 }, (_, i) => isCurveballBoard(`trip-${i}:2:p`)).filter(Boolean).length;
    expect(hits).toBeGreaterThan(70);
    expect(hits).toBeLessThan(130);
    expect(isCurveballBoard("trip-1:2:p")).toBe(isCurveballBoard("trip-1:2:p"));
  });
});

describe("model axes against the template", () => {
  it("keeps non-time axes inside the template's ranges", () => {
    const window = usableWindow({ boardTime: "08:00", pace: "steady" });
    const [c] = prepareCandidates(
      [
        proposal({
          title: "buy something under 1,000 yen you will keep",
          template: "buy_keep",
          axes: { boldness: 1, physical: 5, time: 2, scarcity: 5, cultural: 1, aesthetics: 5 },
        }),
      ],
      context(window),
    );
    const t = TEMPLATES.find((x) => x.id === "buy_keep")!;
    for (const key of ["boldness", "physical", "scarcity", "cultural", "aesthetics"] as const) {
      expect(c.axes[key]).toBeGreaterThanOrEqual(t.axes[key].min);
      expect(c.axes[key]).toBeLessThanOrEqual(t.axes[key].max);
    }
  });
});
