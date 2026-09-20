import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  send: vi.fn(),
  shareContactCard: vi.fn(),
}));

vi.mock("@/lib/chat/transcript", () => ({ recordMessage: vi.fn(async () => {}) }));
vi.mock("./client", () => ({
  getLinqClient: () => ({
    chats: { messages: { send: h.send }, shareContactCard: h.shareContactCard },
  }),
}));

import { LINQ_OP_TIMEOUT_MS } from "./budget";
import { sendText, shareContactCardSafely } from "./send";

describe("sendText effects", () => {
  beforeEach(() => {
    h.send.mockReset();
    h.shareContactCard.mockReset();
  });

  it("sends plain text with no effect field when none is given", async () => {
    h.send.mockResolvedValue({ chat_id: "c1", message: { id: "m1" } });
    await sendText("c1", "hey");
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith("c1", {
      message: { parts: [{ type: "text", value: "hey" }] },
    });
  });

  it("includes the effect on the message content when given", async () => {
    h.send.mockResolvedValue({ chat_id: "c1", message: { id: "m1" } });
    await sendText("c1", "🎉", { effect: { type: "screen", name: "confetti" } });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith("c1", {
      message: {
        parts: [{ type: "text", value: "🎉" }],
        effect: { type: "screen", name: "confetti" },
      },
    });
  });

  it("retries without the effect if the effect-carrying send fails, and still delivers", async () => {
    h.send
      .mockRejectedValueOnce(new Error("effect rejected"))
      .mockResolvedValueOnce({ chat_id: "c1", message: { id: "m2" } });
    const result = await sendText("c1", "nice one", { effect: { type: "screen", name: "fireworks" } });
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send).toHaveBeenNthCalledWith(1, "c1", {
      message: { parts: [{ type: "text", value: "nice one" }], effect: { type: "screen", name: "fireworks" } },
    });
    expect(h.send).toHaveBeenNthCalledWith(2, "c1", {
      message: { parts: [{ type: "text", value: "nice one" }] },
    });
    expect(result).toEqual({ chatId: "c1", messageId: "m2" });
  });

  it("still throws if the plain retry also fails, rather than swallowing a lost message", async () => {
    h.send.mockRejectedValue(new Error("down"));
    await expect(
      sendText("c1", "hey", { effect: { type: "screen", name: "confetti" } }),
    ).rejects.toThrow("down");
    expect(h.send).toHaveBeenCalledTimes(2);
  });
});

describe("shareContactCardSafely", () => {
  beforeEach(() => {
    h.shareContactCard.mockReset();
  });

  it("shares the contact card into the chat", async () => {
    h.shareContactCard.mockResolvedValue(undefined);
    await shareContactCardSafely("c1");
    expect(h.shareContactCard).toHaveBeenCalledWith("c1");
  });

  it("swallows a failure instead of throwing", async () => {
    h.shareContactCard.mockRejectedValue(new Error("not configured yet"));
    await expect(shareContactCardSafely("c1")).resolves.toBeUndefined();
  });
});

// Four outages have had the same shape: a call on the webhook path never came
// back, so the person got nothing and the log simply stopped. A bounded
// failure is recoverable. Silence is not.
describe("a hung Linq call gives up instead of hanging the dispatch", () => {
  beforeEach(() => {
    h.send.mockReset();
    h.shareContactCard.mockReset();
    vi.useFakeTimers();
  });

  it("times out rather than waiting forever", async () => {
    h.send.mockImplementation(() => new Promise(() => {}));
    const pending = sendText("c1", "hey");
    const settled = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(LINQ_OP_TIMEOUT_MS + 10);
    await settled;
    vi.useRealTimers();
  });

  it("does not spend the budget twice retrying an effect after a timeout", async () => {
    h.send.mockImplementation(() => new Promise(() => {}));
    const pending = sendText("c1", "nice", { effect: { type: "screen", name: "fireworks" } });
    const settled = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(LINQ_OP_TIMEOUT_MS + 10);
    await settled;
    // One attempt. A timeout means Linq stalled, not that it refused the effect.
    expect(h.send).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("keeps the whole ceiling inside the function's maxDuration", () => {
    expect(LINQ_OP_TIMEOUT_MS).toBeLessThan(30_000);
  });
});
