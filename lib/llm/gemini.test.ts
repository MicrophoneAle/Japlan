import { describe, expect, it } from "vitest";
import type { LLMProvider } from "./index";
import { matchClaimText, scorePhotoFidelity } from "./gemini";

function providerWith(replies: string[]): LLMProvider {
  const queue = [...replies];
  return {
    async complete() {
      return queue.shift() ?? "";
    },
  };
}

describe("matchClaimText", () => {
  it("returns null when task_code is empty", async () => {
    const match = await matchClaimText({
      provider: providerWith([
        JSON.stringify({ task_code: "", confidence: 0.9, reasoning: "none" }),
      ]),
      text: "hello",
      tasks: [{ code: "A1", title: "eat something" }],
    });
    expect(match).toBeNull();
  });

  it("returns the matched code", async () => {
    const match = await matchClaimText({
      provider: providerWith([
        JSON.stringify({
          task_code: "A4",
          confidence: 0.91,
          reasoning: "vending",
        }),
      ]),
      text: "japlan the vending machine drink",
      tasks: [{ code: "A4", title: "find a vending machine drink nobody recognizes" }],
    });
    expect(match?.task_code).toBe("A4");
    expect(match?.confidence).toBe(0.91);
  });
});

describe("scorePhotoFidelity", () => {
  const image = { data: "aaaa", mime: "image/jpeg" };
  const relates = (yes: boolean) => JSON.stringify({ seen: "a park bench", relates: yes });

  it("asks whether the photo plausibly relates, as evidence not proof", async () => {
    const systems: string[] = [];
    const provider: LLMProvider = {
      async complete(opts) {
        systems.push(opts.system);
        return relates(false);
      },
    };
    const scored = await scorePhotoFidelity({ provider, title: "find a bench in yoyogi park", photoBonusMax: 2, image });
    expect(scored).toMatchObject({ shows_task: false, fidelity: 0, seen: "a park bench" });
    expect(systems).toHaveLength(1); // no score after a no
    expect(systems[0]).toMatch(/evidence, not proof/i);
    expect(systems[0]).toMatch(/when unsure, relates is true/i);
    expect(systems[0]).not.toMatch(/does this photo show/i);
  });

  it("scores within 1..max after a yes, so a match always pays", async () => {
    const score = async (fidelity: unknown) =>
      (await scorePhotoFidelity({
        provider: providerWith([relates(true), JSON.stringify({ fidelity })]),
        title: "find a bench",
        photoBonusMax: 2,
        image,
      }))?.fidelity;
    expect(await score(9)).toBe(2);
    expect(await score(0)).toBe(1);
    expect(await score("junk")).toBe(1);
  });

  it("keeps the raw answers for the logs", async () => {
    const scored = await scorePhotoFidelity({
      provider: providerWith([relates(true), JSON.stringify({ fidelity: 2 })]),
      title: "find a bench",
      photoBonusMax: 3,
      image,
    });
    expect(scored?.raw).toEqual({ relates: relates(true), fidelity: JSON.stringify({ fidelity: 2 }) });
  });

  it("returns null for an empty or unreadable answer instead of a no", async () => {
    for (const raw of ["", "not json", JSON.stringify({ seen: "x" })]) {
      expect(
        await scorePhotoFidelity({ provider: providerWith([raw]), title: "find a bench", photoBonusMax: 2, image }),
      ).toBeNull();
    }
  });
});
