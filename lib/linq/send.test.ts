import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock("@/lib/chat/transcript", () => ({ recordMessage: vi.fn(async () => {}) }));
vi.mock("./client", () => ({
  getLinqClient: () => ({ chats: { messages: { send: h.send } } }),
}));

import { sendText } from "./send";

describe("sendText effects", () => {
  beforeEach(() => {
    h.send.mockReset();
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
