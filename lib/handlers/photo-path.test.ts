import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/test/fake-supabase";
import { fakeHeic, patternJpeg } from "@/lib/test/images";

// End to end through dispatchLinqEvent: webhook payload in, DB rows and
// outbound messages out. Only the network edges are faked: Supabase (in
// memory), Linq sends, the photo CDN fetch, and the Gemini vision call.

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  sent: [] as { chatId: string; text: string }[],
  vision: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ getServiceClient: () => h.db }));
vi.mock("@/lib/linq/send", () => ({
  sendText: vi.fn(async (chatId: string, text: string) => {
    h.sent.push({ chatId, text });
    return { chatId, messageId: `out-${h.sent.length}` };
  }),
  sendDM: vi.fn(async (phone: string, text: string) => {
    h.sent.push({ chatId: `dm:${phone}`, text });
    return { chatId: `dm:${phone}`, messageId: `out-${h.sent.length}` };
  }),
  markRead: vi.fn(async () => {}),
  sendTyping: vi.fn(async () => {}),
}));
vi.mock("@/lib/llm/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/gemini")>();
  class NoNetworkProvider {
    async complete() {
      return "";
    }
  }
  return {
    ...actual,
    GeminiProvider: NoNetworkProvider,
    scorePhotoFidelity: h.vision,
    matchClaimText: vi.fn(async () => null),
    extractFreeformActivity: vi.fn(async () => ""),
  };
});

import { dispatchLinqEvent } from "./dispatch";

const CHAT = "chat-group";
const MIKE = "+15550000001";
const NOON_JST = new Date("2026-09-19T03:00:00Z");
let eventCounter = 0;

function message(parts: Record<string, unknown>[]) {
  eventCounter += 1;
  return {
    event_id: `evt-${eventCounter}`,
    event_type: "message.received",
    data: {
      id: `msg-${eventCounter}`,
      chat_id: CHAT,
      chat: { id: CHAT, is_group: true },
      sender_handle: { handle: MIKE, is_me: false, display_name: "Mike" },
      parts,
    },
  };
}

const photoPart = { type: "media", url: "https://cdn.example/photo-1.heic", mime_type: "image/heic" };
const text = (value: string) => ({ type: "text", value });

function a1Claim() {
  return h.db.table("claims").find((c) => c.task_id === "task-a1");
}

let photoBytes: Buffer;

const verdict = (relates: boolean, fidelity: number) => ({
  shows_task: relates,
  fidelity,
  seen: "a photo",
  raw: { relates: JSON.stringify({ seen: "a photo", relates }), fidelity: relates ? `{"fidelity":${fidelity}}` : null },
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOON_JST);
  process.env.LINQ_FROM_NUMBER = "+15559999999";
  h.sent.length = 0;
  h.vision.mockReset();
  h.db = new FakeSupabase();
  h.db.seed("trips", [
    {
      id: "trip-1",
      linq_chat_id: CHAT,
      name: "tokyo",
      destination: "Tokyo",
      start_date: "2026-09-19",
      end_date: "2026-09-23",
      state: "active",
      timezone: "Asia/Tokyo",
      intro_sent_at: "2026-09-18T00:00:00Z",
    },
  ]);
  h.db.seed("participants", [
    { id: "p-mike", trip_id: "trip-1", phone: MIKE, display_name: "Mike", survey_state: "done" },
  ]);
  const task = (id: string, code: string) => ({
    id,
    trip_id: "trip-1",
    participant_id: "p-mike",
    team_id: null,
    code,
    title: `task ${code}`,
    tier: "Light",
    axes_json: {},
    base_points: 8,
    photo_bonus_max: 3,
    verification: "photo",
    day: 1,
  });
  h.db.seed("tasks", [task("task-a1", "A1"), task("task-a2", "A2")]);
  photoBytes = fakeHeic();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array(photoBytes), {
      status: 200,
      headers: { "content-type": "image/heic" },
    })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("photo with a code as the caption", () => {
  it("awards the base points and the photo bonus in one confirmation", async () => {
    h.vision.mockResolvedValue(verdict(true, 2));
    await dispatchLinqEvent(message([photoPart, text("A1")]));

    const claim = a1Claim();
    expect(claim?.status).toBe("awarded");
    expect(claim?.awarded_points).toBe(10);
    expect(claim?.photo_claimed_at).toBeTruthy();
    expect(String(claim?.image_hash)).toMatch(/^sha256:/); // HEIC: exact-hash fallback
    expect(h.vision).toHaveBeenCalledOnce();
    expect(h.vision.mock.calls[0][0].image.mime).toBe("image/heic");
    expect(h.sent.map((m) => m.text)).toEqual(["✅ A1 · Mike +8 +2 photo · 10"]);
  });

  it("still awards the code when the vision call times out", async () => {
    h.vision.mockRejectedValue(new Error("gemini.vision.shows_task timed out after 20000ms"));
    await dispatchLinqEvent(message([photoPart, text("A1")]));

    expect(a1Claim()?.awarded_points).toBe(8);
    expect(a1Claim()?.photo_claimed_at).toBeNull();
    expect(h.sent.map((m) => m.text)).toEqual(["✅ A1 · Mike +8 · 8\nphoto for bonus points?"]);
  });

  it("still awards the code when the photo cannot be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 403 })));
    await dispatchLinqEvent(message([photoPart, text("A1")]));

    expect(a1Claim()?.awarded_points).toBe(8);
    expect(h.vision).not.toHaveBeenCalled();
    expect(h.sent[0]?.text).toContain("✅ A1 · Mike +8");
  });
});

describe("photo sent alone after claiming", () => {
  it("binds to the recent claim inside the bonus window", async () => {
    h.vision.mockResolvedValue(verdict(true, 3));
    await dispatchLinqEvent(message([text("A1")]));
    expect(a1Claim()?.awarded_points).toBe(8);

    // 30 minutes later: well past the old 60s in-memory binding.
    vi.setSystemTime(new Date(NOON_JST.getTime() + 30 * 60 * 1000));
    photoBytes = await patternJpeg("vertical", { exifDate: "2026:09:19 11:40:00" });
    await dispatchLinqEvent(message([{ ...photoPart, mime_type: "image/jpeg" }]));

    expect(a1Claim()?.awarded_points).toBe(11);
    expect(a1Claim()?.photo_claimed_at).toBeTruthy();
    expect(String(a1Claim()?.image_hash)).not.toMatch(/^sha256:/); // JPEG: perceptual
    expect(h.sent.at(-1)?.text).toBe("📸 A1 · +3 bonus · 11");
  });

  it("stays silent for a bare photo that matches no open task", async () => {
    // A bare group photo may be checked against open tasks (a way into the
    // conversation), but a miss is silence, not a reply.
    h.vision.mockResolvedValue(verdict(false, 0));
    await dispatchLinqEvent(message([photoPart]));
    expect(h.sent).toEqual([]);
  });

  it("stays silent once the bonus window has closed", async () => {
    await dispatchLinqEvent(message([text("A1")]));
    h.sent.length = 0;
    vi.setSystemTime(new Date(NOON_JST.getTime() + 3 * 60 * 60 * 1000));
    h.vision.mockResolvedValue(verdict(false, 0));
    await dispatchLinqEvent(message([photoPart]));
    expect(h.sent).toEqual([]);
  });

  it("answers when the photo does not show the task", async () => {
    h.vision.mockResolvedValue(verdict(false, 0));
    await dispatchLinqEvent(message([text("A1")]));
    vi.setSystemTime(new Date(NOON_JST.getTime() + 10 * 60 * 1000));
    await dispatchLinqEvent(message([photoPart]));
    expect(a1Claim()?.awarded_points).toBe(8);
    expect(h.sent.at(-1)?.text).toBe(
      "doesn't look like A1, so no photo bonus. a clearer shot still counts.",
    );
  });
  it("says the check failed, not 'doesn't look like', when the model answer is unreadable", async () => {
    h.vision.mockResolvedValue(null);
    await dispatchLinqEvent(message([text("A1")]));
    vi.setSystemTime(new Date(NOON_JST.getTime() + 10 * 60 * 1000));
    await dispatchLinqEvent(message([photoPart]));
    expect(h.sent.at(-1)?.text).toBe("couldn't check that photo for A1. send it again in a minute.");
  });

  it("sends the model an upright, downscaled jpeg", async () => {
    h.vision.mockResolvedValue(verdict(true, 2));
    await dispatchLinqEvent(message([text("A1")]));
    photoBytes = await patternJpeg("vertical", { exifDate: "2026:09:19 11:40:00" });
    await dispatchLinqEvent(message([{ ...photoPart, mime_type: "image/jpeg" }]));
    const image = h.vision.mock.calls[0][0].image as { data: string; mime: string };
    expect(image.mime).toBe("image/jpeg");
    expect(Buffer.from(image.data, "base64").subarray(0, 3).toString("hex")).toBe("ffd8ff");
  });
});
