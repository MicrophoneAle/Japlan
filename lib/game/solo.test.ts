import { describe, expect, it } from "vitest";
import { persistableTask } from "@/lib/handlers/daily-board";
import { buildSoloParticipantInsert, buildSoloTripInsert } from "@/lib/handlers/solo";
import {
  applySoloVerification,
  defaultSoloSurveyAnswers,
  routeSoloDm,
  shouldRunSoloBootstrap,
  shouldRunSoloSkipSurvey,
  soloModeEnabled,
  soloParticipantCount,
  verificationForSolo,
} from "./solo";
import { allParticipantsComplete } from "./survey";

describe("solo bootstrap payload", () => {
  it("creates exactly one participant for the DM chat", () => {
    const trip = buildSoloTripInsert("dm-chat-1");
    expect(trip).toEqual({
      linq_chat_id: "dm-chat-1",
      name: "solo test",
      state: "bootstrapping",
      is_solo: true,
    });
    const people = [buildSoloParticipantInsert("trip-1", "+15551212")];
    expect(people).toHaveLength(1);
    expect(people[0]?.display_name).toBe("+15551212");
    expect(
      buildSoloParticipantInsert("trip-1", "+15551212", "Michael").display_name,
    ).toBe("Michael");
    expect(soloParticipantCount(people.map((p) => p.phone))).toBe(1);
  });
});

describe("solo survey completion", () => {
  it("treats one finished survey as everyone done", () => {
    expect(allParticipantsComplete(["done"])).toBe(true);
    expect(defaultSoloSurveyAnswers().budget).toEqual({ value: "medium" });
    expect(defaultSoloSurveyAnswers().dietary).toEqual({ value: "none" });
  });
});

describe("solo peer verification", () => {
  it("downgrades peer tasks to honor on a solo trip", () => {
    expect(verificationForSolo("peer", true)).toBe("honor");
    expect(verificationForSolo("photo", true)).toBe("photo");
    expect(verificationForSolo("honor", true)).toBe("honor");

    const tasks = applySoloVerification(
      [
        {
          title: "get a stranger to draw you",
          verification: "peer" as const,
        },
        {
          title: "photograph a doorway",
          verification: "photo" as const,
        },
      ],
      true,
    );
    expect(tasks.map((t) => t.verification)).toEqual(["honor", "photo"]);

    const persisted = persistableTask({
      tripId: "trip-1",
      day: 1,
      tripDays: 5,
      task: {
        code: "C1",
        title: "get a stranger to draw you",
        axes: {
          boldness: 3,
          physical: 1,
          time: 1,
          scarcity: 1,
          cultural: 1,
          aesthetics: 1,
        },
        verification: "peer",
        photo_bonus_max: 0,
        neighborhood: "Asakusa",
      },
      participantId: null,
      teamId: null,
      expiresAt: new Date("2026-09-19T23:59:59.000Z"),
      isSolo: true,
    });
    expect(persisted.row.verification).toBe("honor");
  });
});

describe("group behaviour when solo mode is off", () => {
  it("does not exist when JAPLAN_SOLO_MODE is unset or false", () => {
    expect(soloModeEnabled(undefined)).toBe(false);
    expect(soloModeEnabled("false")).toBe(false);
    expect(soloModeEnabled("true")).toBe(true);
    expect(soloModeEnabled("TRUE")).toBe(true);
    expect(soloModeEnabled("1")).toBe(true);
    expect(soloModeEnabled("yes")).toBe(true);
    expect(soloModeEnabled(" YES ")).toBe(true);

    expect(
      shouldRunSoloBootstrap({
        enabled: false,
        isDm: true,
        text: "japlan solo",
      }),
    ).toBe(false);
    expect(
      shouldRunSoloSkipSurvey({
        enabled: false,
        isDm: true,
        text: "japlan skipsurvey",
      }),
    ).toBe(false);
    expect(
      routeSoloDm({
        enabled: false,
        text: "japlan solo",
        soloTripState: null,
      }),
    ).toBeNull();
    expect(
      routeSoloDm({
        enabled: false,
        text: "A1",
        soloTripState: "active",
      }),
    ).toBeNull();
    expect(verificationForSolo("peer", false)).toBe("peer");
    expect(
      applySoloVerification([{ title: "peer task", verification: "peer" }], false),
    ).toEqual([{ title: "peer task", verification: "peer" }]);
  });

  it("does not hijack group chats even when the flag is on", () => {
    expect(
      shouldRunSoloBootstrap({
        enabled: true,
        isDm: false,
        text: "japlan solo",
      }),
    ).toBe(false);
    expect(
      routeSoloDm({
        enabled: true,
        text: "japlan solo",
        soloTripState: null,
      }),
    ).toBe("solo_bootstrap");
    expect(
      routeSoloDm({
        enabled: true,
        text: "japlan skipsurvey",
        soloTripState: "surveying",
      }),
    ).toBe("solo_skip");
    expect(
      routeSoloDm({
        enabled: true,
        text: "A1",
        soloTripState: "active",
      }),
    ).toBe("solo_claim");
    expect(
      routeSoloDm({
        enabled: true,
        text: "25-34",
        soloTripState: "surveying",
      }),
    ).toBeNull();
  });
});
