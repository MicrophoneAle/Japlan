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

  it("stops after a no without asking for a score", async () => {
    const calls: unknown[] = [];
    const provider: LLMProvider = {
      async complete(opts) {
        calls.push(opts.system);
        return JSON.stringify({ shows_task: false });
      },
    };
    const scored = await scorePhotoFidelity({
      provider,
      title: "photograph a doorway older than you",
      photoBonusMax: 2,
      image,
    });
    expect(scored).toEqual({ shows_task: false, fidelity: 0 });
    expect(calls).toHaveLength(1);
  });

  it("asks for a bounded score only after yes", async () => {
    const scored = await scorePhotoFidelity({
      provider: providerWith([
        JSON.stringify({ shows_task: true }),
        JSON.stringify({ fidelity: 9 }),
      ]),
      title: "photograph a doorway older than you",
      photoBonusMax: 2,
      image,
    });
    expect(scored).toEqual({ shows_task: true, fidelity: 2 });
  });
});
