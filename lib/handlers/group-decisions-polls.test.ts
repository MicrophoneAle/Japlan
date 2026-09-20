import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";

const CHAT = "chat-group";
const PHONE = "+15550000001";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  sent: [] as { chatId: string; text: string; messageId: string }[],
  pollCreate: vi.fn(),
  pollRetrieve: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ getServiceClient: () => h.db }));
vi.mock("@/lib/linq/client", () => ({
  getLinqClient: () => ({
    chats: { polls: { create: h.pollCreate } },
    messages: { poll: { retrieve: h.pollRetrieve } },
  }),
}));
vi.mock("@/lib/linq/send", () => ({
  sendText: vi.fn(async (chatId: string, text: string) => {
    const messageId = `message-${h.sent.length + 1}`;
    h.sent.push({ chatId, text, messageId });
    return { chatId, messageId };
  }),
}));

import {
  handleGroupDecisionMessage,
  handleGroupDecisionPollVote,
  handleGroupDecisionReaction,
} from "./group-decisions";

function seed(): void {
  h.db.seed("trips", [{
    id: "trip-1",
    linq_chat_id: CHAT,
    name: "Tokyo",
    destination: "Tokyo",
    start_date: "2026-09-19",
    end_date: "2026-09-21",
    state: "active",
    difficulty: null,
    stake_text: null,
    timezone: "Asia/Tokyo",
    is_solo: false,
    organizer_participant_id: "p-organizer",
  }]);
  h.db.seed("participants", [
    {
      id: "p-organizer",
      trip_id: "trip-1",
      phone: PHONE,
      display_name: "Elrich",
      score: 0,
      survey_json: null,
      survey_state: "done",
      sidequests_muted: false,
      consented_at: null,
    },
    {
      id: "p-member",
      trip_id: "trip-1",
      phone: "+15550000002",
      display_name: "Maya",
      score: 0,
      survey_json: null,
      survey_state: "done",
      sidequests_muted: false,
      consented_at: null,
    },
  ]);
}

async function createDecision(): Promise<void> {
  await handleGroupDecisionMessage({
    chatId: CHAT,
    isDm: false,
    phone: PHONE,
    text: "japlan decide tomorrow morning | Tsukiji food crawl | TeamLab | sleep until noon",
  });
}

function voteData(optionId: string, phone = "+15550000002") {
  return {
    message_id: "poll-message-1",
    option_id: optionId,
    chat: { id: CHAT, is_group: true },
    sender_handle: { handle: phone },
  };
}

function pollSnapshot(selectedOptionIds: string[], phone = "+15550000002") {
  return {
    message_id: "poll-message-1",
    chat_id: CHAT,
    poll: {
      total_voters: selectedOptionIds.length > 0 ? 1 : 0,
      options: ["poll-option-1", "poll-option-2", "poll-option-3"].map((option_id) => ({
        option_id,
        text: option_id,
        can_be_edited: false,
        creator_handle: { handle: PHONE },
        voters: selectedOptionIds.includes(option_id) ? [{ handle: phone, voted_at: "2026-09-19T12:00:00.000Z" }] : [],
      })),
    },
    reactions: [],
    created_at: "2026-09-19T12:00:00.000Z",
    updated_at: "2026-09-19T12:00:00.000Z",
  };
}

beforeEach(() => {
  h.db = new FakeSupabase();
  h.sent.length = 0;
  h.pollCreate.mockReset().mockResolvedValue({
    chat_id: CHAT,
    message_id: "poll-message-1",
    created_at: "2026-09-19T12:00:00.000Z",
    updated_at: "2026-09-19T12:00:00.000Z",
    poll: {
      total_voters: 0,
      options: [
        { option_id: "poll-option-1", text: "Tsukiji food crawl", voters: [], creator_handle: {}, can_be_edited: false },
        { option_id: "poll-option-2", text: "TeamLab", voters: [], creator_handle: {}, can_be_edited: false },
        { option_id: "poll-option-3", text: "sleep until noon", voters: [], creator_handle: {}, can_be_edited: false },
      ],
    },
    reactions: [],
  });
  h.pollRetrieve.mockReset().mockResolvedValue(pollSnapshot([]));
  seed();
});

afterEach(() => vi.restoreAllMocks());

describe("native group decision polls", () => {
  it("lets one person select multiple options and removes only the toggled option", async () => {
    await createDecision();
    h.pollRetrieve
      .mockResolvedValueOnce(pollSnapshot(["poll-option-1"]))
      .mockResolvedValueOnce(pollSnapshot(["poll-option-1", "poll-option-2"]))
      .mockResolvedValueOnce(pollSnapshot(["poll-option-2"]));
    expect(await handleGroupDecisionPollVote("poll.vote.added", voteData("poll-option-1"))).toBe(true);
    expect(await handleGroupDecisionPollVote("poll.vote.added", voteData("poll-option-2"))).toBe(true);
    expect(h.db.table("group_decision_votes").map((vote) => vote.option_index)).toEqual([1, 2]);

    expect(await handleGroupDecisionPollVote("poll.vote.removed", voteData("poll-option-1"))).toBe(true);
    expect(h.db.table("group_decision_votes").map((vote) => vote.option_index)).toEqual([2]);
  });

  it("treats repeated add and remove webhook deliveries as idempotent", async () => {
    await createDecision();
    const data = voteData("poll-option-2");
    h.pollRetrieve
      .mockResolvedValueOnce(pollSnapshot(["poll-option-2"]))
      .mockResolvedValueOnce(pollSnapshot(["poll-option-2"]))
      .mockResolvedValueOnce(pollSnapshot([]))
      .mockResolvedValueOnce(pollSnapshot([]));
    await handleGroupDecisionPollVote("poll.vote.added", data);
    await handleGroupDecisionPollVote("poll.vote.added", data);
    expect(h.db.table("group_decision_votes")).toHaveLength(1);

    await handleGroupDecisionPollVote("poll.vote.removed", data);
    await handleGroupDecisionPollVote("poll.vote.removed", data);
    expect(h.db.table("group_decision_votes")).toHaveLength(0);
  });

  it("uses the current poll snapshot when an older add arrives after a removal", async () => {
    await createDecision();
    h.pollRetrieve
      .mockResolvedValueOnce(pollSnapshot([]))
      .mockResolvedValueOnce(pollSnapshot([]));

    await handleGroupDecisionPollVote("poll.vote.removed", voteData("poll-option-1"));
    await handleGroupDecisionPollVote("poll.vote.added", voteData("poll-option-1"));

    expect(h.db.table("group_decision_votes")).toHaveLength(0);
  });

  it("recognizes its poll but ignores votes from people outside the trip roster", async () => {
    await createDecision();
    expect(await handleGroupDecisionPollVote("poll.vote.added", voteData("poll-option-1", "+15559999999"))).toBe(true);
    expect(h.db.table("group_decision_votes")).toHaveLength(0);
  });

  it("recognizes a closed poll and ignores late vote events", async () => {
    await createDecision();
    h.db.table("group_decisions")[0].status = "closed";
    expect(await handleGroupDecisionPollVote("poll.vote.added", voteData("poll-option-1"))).toBe(true);
    expect(h.db.table("group_decision_votes")).toHaveLength(0);
  });

  it("falls back to one-choice reaction voting when Linq rejects polls for the chat", async () => {
    h.pollCreate.mockRejectedValueOnce({ code: 4005, message: "RecipientUnsupportedMessageType" });
    await createDecision();

    const options = h.db.table("group_decision_options");
    expect(h.db.table("group_decisions")[0].voting_mode).toBe("reactions");
    expect(options.every((option) => typeof option.message_id === "string")).toBe(true);
    expect(h.sent).toHaveLength(4); // prompt plus three reaction choices

    const firstMessageId = options[0].message_id as string;
    const secondMessageId = options[1].message_id as string;
    await handleGroupDecisionReaction({
      message_id: firstMessageId,
      reaction_type: "like",
      chat: { id: CHAT },
      from_handle: { handle: "+15550000002" },
    });
    await handleGroupDecisionReaction({
      message_id: secondMessageId,
      reaction_type: "love",
      chat: { id: CHAT },
      from_handle: { handle: "+15550000002" },
    });
    expect(h.db.table("group_decision_votes").map((vote) => vote.option_index)).toEqual([2]);
  });
});
