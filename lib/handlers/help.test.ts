import { describe, expect, it } from "vitest";
import { HELP_TEXT } from "@/lib/game/copy";
import { sendHelpGuide } from "./help";

describe("sendHelpGuide", () => {
  it("posts group help to the group chat", async () => {
    const sent: { chatId: string; text: string }[] = [];
    const sentHelp = await sendHelpGuide({
      chatId: "group-chat",
      isDm: false,
      ambientRepliesInWindow: 99,
      ambientCap: 1,
      send: async (chatId, text) => {
        sent.push({ chatId, text });
        return { messageId: "m1" };
      },
    });
    expect(sentHelp).toBe(true);
    expect(sent).toEqual([{ chatId: "group-chat", text: HELP_TEXT.group }]);
  });

  it("posts DM help to the DM", async () => {
    const sent: { chatId: string; text: string }[] = [];
    await sendHelpGuide({
      chatId: "dm-chat",
      isDm: true,
      ambientRepliesInWindow: 99,
      ambientCap: 1,
      send: async (chatId, text) => {
        sent.push({ chatId, text });
        return { messageId: "m2" };
      },
    });
    expect(sent).toEqual([{ chatId: "dm-chat", text: HELP_TEXT.dm }]);
  });
});
