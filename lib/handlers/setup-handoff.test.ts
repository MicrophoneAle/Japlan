import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";

// Three symptoms from one live DM, two of them the same cause.
//
// The gate that says "the organizer is setting the shared city..." used to sit
// ABOVE the survey continuation with no exemptions. So the first answer after
// the survey started was swallowed, the survey never advanced, and every later
// message got the identical line forever. The organizer's own name was still a
// phone number precisely BECAUSE the name answer never landed.

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  sent: [] as { chatId: string; text: string }[],
}));

vi.mock("@/lib/db/client", () => ({ getServiceClient: () => h.db }));
vi.mock("@/lib/linq/send", () => ({
  sendText: vi.fn(async (chatId: string, text: string) => {
    h.sent.push({ chatId, text });
    return { chatId, messageId: `m${h.sent.length}` };
  }),
  sendDM: vi.fn(async (phone: string, text: string) => {
    h.sent.push({ chatId: `dm:${phone}`, text });
    return { chatId: `dm:${phone}`, messageId: `m${h.sent.length}` };
  }),
  markRead: vi.fn(async () => {}),
  sendTyping: vi.fn(async () => {}),
  react: vi.fn(async () => {}),
}));
vi.mock("@/lib/llm/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/gemini")>();
  class NoNetwork {
    async complete() {
      return "";
    }
    async completeTurn() {
      return { text: "", functionCalls: [] };
    }
  }
  return {
    ...actual,
    GeminiProvider: NoNetwork,
    interpretSurveyReply: vi.fn(async () => null),
    judgeRelevance: vi.fn(async () => null),
  };
});

import { handleSurveyDm } from "./survey";
import { startSurvey } from "@/lib/game/survey";

const MIKE = "+19057580877";
const SAM = "+15550000002";
const DM_MIKE = `dm:${MIKE}`;
const DM_SAM = `dm:${SAM}`;

// Mid-setup on purpose: setup_state is still a setup question.
function seed(opts: { organizerName?: string; mikeSurveyState?: string | null } = {}) {
  h.db = new FakeSupabase();
  h.db.seed("trips", [
    {
      id: "trip-1",
      linq_chat_id: "chat-group",
      name: "trip",
      destination: null,
      start_date: null,
      end_date: null,
      state: "surveying",
      is_solo: false,
      setup_state: "destination",
      organizer_participant_id: "p-mike",
      timezone: null,
    },
  ]);
  h.db.seed("participants", [
    {
      id: "p-mike",
      trip_id: "trip-1",
      phone: MIKE,
      // Linq gives a phone number when it has no display name.
      display_name: opts.organizerName ?? MIKE,
      score: 0,
      survey_json: {},
      survey_state: opts.mikeSurveyState ?? null,
      setup_pending_told_at: null,
    },
    {
      id: "p-sam",
      trip_id: "trip-1",
      phone: SAM,
      display_name: "Sam",
      score: 0,
      survey_json: {},
      survey_state: null,
      setup_pending_told_at: null,
    },
  ]);
}

const to = (chatId: string) => h.sent.filter((m) => m.chatId === chatId).map((m) => m.text);
const person = (id: string) => h.db.table("participants").find((p) => p.id === id)!;

async function dm(phone: string, chatId: string, text: string) {
  await handleSurveyDm({ phone, chatId, text });
}

beforeEach(() => {
  h.sent.length = 0;
  seed();
});
afterEach(() => vi.clearAllMocks());

describe("the setup handoff does not loop", () => {
  it("lets a survey already in progress continue while setup is pending", async () => {
    // The survey started (the trip went live for them), so they are mid-flight.
    seed({ mikeSurveyState: "first_name" });
    await dm(MIKE, DM_MIKE, "Michael");

    const replies = to(DM_MIKE);
    expect(replies).toHaveLength(1);
    // The name landed, rather than being swallowed by the setup gate.
    expect(person("p-mike").display_name).toBe("Michael");
    expect(person("p-mike").survey_state).not.toBe("first_name");
    expect(replies[0]).not.toMatch(/setting the shared city/);
  });

  it("advances instead of repeating the same line on every message", async () => {
    seed({ mikeSurveyState: "first_name" });
    await dm(MIKE, DM_MIKE, "Michael");
    const afterName = person("p-mike").survey_state;
    await dm(MIKE, DM_MIKE, "1");
    await dm(MIKE, DM_MIKE, "2");

    const replies = to(DM_MIKE);
    expect(replies).toHaveLength(3);
    // Three different replies, not the same line three times.
    expect(new Set(replies).size).toBeGreaterThan(1);
    expect(replies.filter((r) => /setting the shared city/.test(r))).toHaveLength(0);
    expect(person("p-mike").survey_state).not.toBe(afterName);
  });

  it("never tells the organizer they are waiting on themselves", async () => {
    await dm(MIKE, DM_MIKE, "hello");
    expect(to(DM_MIKE).filter((r) => /setting the shared city/.test(r))).toHaveLength(0);
  });

  it("tells everyone else once, then stays quiet", async () => {
    await dm(SAM, DM_SAM, "hey");
    await dm(SAM, DM_SAM, "hello?");
    await dm(SAM, DM_SAM, "anyone there");

    const said = to(DM_SAM).filter((r) => /setting the shared city/.test(r));
    expect(said).toHaveLength(1);
    expect(to(DM_SAM)).toHaveLength(1);
    expect(person("p-sam").setup_pending_told_at).toBeTruthy();
  });

  it("never prints the organizer as a phone number", async () => {
    await dm(SAM, DM_SAM, "hey");
    const said = to(DM_SAM)[0];
    expect(said).not.toContain(MIKE);
    expect(said).not.toMatch(/\+?\d{7,}/);
    expect(said).toContain("the organizer");
  });

  it("uses the organizer's real name once they have given one", async () => {
    seed({ organizerName: "Michael" });
    await dm(SAM, DM_SAM, "hey");
    expect(to(DM_SAM)[0]).toContain("Michael");
  });
});

describe("the opening message is one message", () => {
  it("does not glue the intro and the first question into a run-on", () => {
    const prompt = startSurvey().prompt!;
    // The exact glitch: the intro's last word running into the next block.
    expect(prompt).not.toMatch(/safety detail right\. a few quick ones/);
    // A blank line between two distinct ideas.
    expect(prompt).toMatch(/\n\n/);
    expect(prompt.trimEnd().endsWith("what should i call you?")).toBe(true);
  });

  it("explains skip once, not three times", () => {
    const prompt = startSurvey().prompt!;
    expect((prompt.match(/skip/gi) ?? []).length).toBe(1);
  });

  it("does not open twice", () => {
    const prompt = startSurvey().prompt!;
    expect(prompt).not.toContain("a few quick ones so the tasks fit you");
  });
});
