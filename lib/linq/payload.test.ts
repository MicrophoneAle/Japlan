import { describe, expect, it } from "vitest";
import {
  chatIdFromData,
  isDirectChat,
  isFromMe,
  isGroupChat,
  mediaFromParts,
  membersFromChatJson,
  senderFromData,
  textFromParts,
} from "./payload";

describe("chat id resolution", () => {
  it("reads data.chat.id", () => {
    expect(chatIdFromData({ chat: { id: "nested-id", is_group: true } })).toBe(
      "nested-id",
    );
  });

  it("reads data.chat_id when chat.id is missing", () => {
    expect(chatIdFromData({ chat_id: "flat-id" })).toBe("flat-id");
  });

  it("prefers data.chat.id when both are present", () => {
    expect(
      chatIdFromData({ chat_id: "flat-id", chat: { id: "nested-id" } }),
    ).toBe("nested-id");
  });
});

describe("sender_handle", () => {
  it("reads E.164 handle and is_me", () => {
    expect(
      senderFromData({
        sender_handle: { handle: "+19055550100", is_me: false },
      }),
    ).toEqual({ handle: "+19055550100", is_me: false, display_name: null });
  });

  it("reads a contact display name when it is not a phone number", () => {
    expect(
      senderFromData({
        sender_handle: {
          handle: "+19055550100",
          is_me: false,
          display_name: "Michael",
        },
      }),
    ).toEqual({
      handle: "+19055550100",
      is_me: false,
      display_name: "Michael",
    });
    expect(
      senderFromData({
        sender_handle: {
          handle: "+19055550100",
          is_me: false,
          display_name: "+19055550100",
        },
      }),
    ).toEqual({
      handle: "+19055550100",
      is_me: false,
      display_name: null,
    });
  });

  it("treats is_me true as the bot's own event", () => {
    expect(
      isFromMe({ sender_handle: { handle: "+19055550199", is_me: true } }),
    ).toBe(true);
    expect(
      isFromMe({ sender_handle: { handle: "+19055550100", is_me: false } }),
    ).toBe(false);
    expect(isFromMe({})).toBe(false);
  });
});

describe("group vs parts", () => {
  it("detects a group from data.chat.is_group", () => {
    expect(isGroupChat({ chat: { id: "c1", is_group: true } })).toBe(true);
    expect(isGroupChat({ chat: { id: "c1", is_group: false } })).toBe(false);
    expect(isDirectChat({ chat: { id: "c1", is_group: false } })).toBe(true);
    expect(isDirectChat({ chat: { id: "c1", is_group: true } })).toBe(false);
    expect(isGroupChat({ chat_id: "c1" })).toBe(false);
  });

  it("reads text parts and media parts with mime + url", () => {
    expect(
      textFromParts([
        { type: "text", value: "hello" },
        { type: "media", mime: "image/jpeg", url: "https://cdn.example/a.jpg" },
      ]),
    ).toBe("hello");
    expect(
      mediaFromParts([
        {
          type: "media",
          mime: "image/jpeg",
          url: "https://cdn.example/a.jpg",
        },
      ]),
    ).toEqual([
      {
        type: "media",
        mime: "image/jpeg",
        url: "https://cdn.example/a.jpg",
      },
    ]);
  });

  it("does not crash on a media-only message with no text part", () => {
    const parts = [
      { type: "media", mime: "image/jpeg", url: "https://cdn.example/a.jpg" },
    ];
    expect(textFromParts(parts)).toBe("");
    expect(mediaFromParts(parts)).toHaveLength(1);
  });
});

describe("membersFromChatJson", () => {
  it("reads SDK-shaped handles", () => {
    const result = membersFromChatJson({
      handles: [
        { handle: "+19055550100", is_me: false },
        { handle: "+19055550199", is_me: true },
      ],
    });
    expect(result.sourcePath).toBe("handles");
    expect(result.parsed).toEqual([
      { handle: "+19055550100", is_me: false, display_name: null },
      { handle: "+19055550199", is_me: true, display_name: null },
    ]);
  });

  it("finds handle arrays under a different parent key", () => {
    const result = membersFromChatJson({
      participants: [{ handle: "+19055550100", is_me: false }],
    });
    expect(result.sourcePath).toBe("participants");
    expect(result.parsed).toHaveLength(1);
  });

  it("returns empty on an unexpected shape", () => {
    const result = membersFromChatJson({ id: "c1", display_name: "Trip" });
    expect(result.parsed).toEqual([]);
    expect(result.sourcePath).toBeNull();
  });
});
