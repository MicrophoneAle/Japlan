import type { ClaimRow, TaskRow } from "@/lib/db/types";
import { todayFor, zoneNow } from "@/lib/game/legs";
import { findUrls } from "@/lib/game/urls";
import { resolveFirstLinkForContext } from "@/lib/handlers/social-links";
import { evaluateAddress } from "@/lib/game/addressing";
import {
  CONVERSATION_MAX_TOOL_ITERS,
  foreignSurveySecrets,
  recordConversationalReply,
  surveySliceForConversation,
  finalizeConversationReply,
} from "@/lib/game/conversation";
import {
  runJaplanAgent,
  wrapConversationTool,
  type AgentTool,
} from "@/lib/agent";
import {
  BOARD_IN_DM_LINE,
  PROFILE_IN_DM_LINE,
  profileLine,
  profileUnfinishedLine,
  CONVERSATION_FALLBACK,
  CONVERSATION_PRIVACY_LINE,
  CONVERSATION_SYSTEM_PROMPT,
  DASHBOARD_UNAVAILABLE_LINE,
  DISCARD_FALLBACK,
  liveDashboardLine,
  standingsLine,
} from "@/lib/game/copy";
import { isCarRentalRequest, isDashboardRequest, isStandingsRequest } from "@/lib/game/commands";
import { isUnderAge } from "@/lib/game/preferences";
import {
  enterpriseRentalReply,
  findEnterpriseRentals,
} from "@/lib/handlers/enterprise-rentals";
import { liveUrlFor } from "@/lib/urls";
import {
  isOpenTask,
  pickLatePhotoTarget,
  photoBonusWindowMs,
  tasksClaimableBy,
} from "@/lib/game/claims";
import { buildStandingsRows } from "@/lib/game/standings";
import type { SurveyAnswers } from "@/lib/game/survey";
import { localHour } from "@/lib/game/time";
import { currentTripDay } from "@/lib/handlers/daily-board";
import {
  currentBoardPeriod,
  isBoardRequest,
  isRedoRequest,
} from "@/lib/game/board-schedule";
import { answerBoardRequest } from "@/lib/handlers/board-request";
import {
  applyLatePhotoBonus,
  submitFreeformClaim,
  type ClaimFallthrough,
} from "@/lib/handlers/claims";
import { teamsWithMembers } from "@/lib/handlers/teams";
import { lookupOwnProfile } from "@/lib/handlers/profiles";
import { otherPersonAskedAbout } from "@/lib/game/profile";
import { searchTheWeb } from "@/lib/handlers/web-search";
import { getOnDemandLocationContext } from "@/lib/handlers/live-location";
import type { LLMProvider, ToolContent } from "@/lib/llm";
import { GeminiProvider } from "@/lib/llm/gemini";
import { react, sendDM, sendText } from "@/lib/linq/send";
import { recentMessages, TRANSCRIPT_LIMIT } from "@/lib/chat/transcript";
import { changedState, checkReply } from "@/lib/game/reply-check";
import type { DestinationProfile } from "@/lib/game/destination";
import { judgeRelevance } from "@/lib/llm/gemini";
import {
  addSuggestion,
  avoidCategory,
  recordRegroup,
  recordSplit,
  redoToday,
  requestTasks,
  updateMySetting,
  updateTripSetting,
} from "@/lib/handlers/plan-changes";

export const CONVERSATION_TOOL_DEFS = [
  {
    name: "get_standings",
    description:
      "Read current standings from the database. Call this before stating any score.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_open_tasks",
    description:
      "List existing open tasks. Never invent a task that is not in this list.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_live_nearby_options",
    description:
      "Use only when the group explicitly asks what to do right now, where everyone is, or for nearby options. Fetches fresh locations only from participants who consented, then returns names with approximate areas and nearby places. Never use for a general itinerary or in a private DM.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "propose_freeform_claim",
    description:
      "Check a possible claim only after they clearly say they completed an activity that is not on the board. Never call for a plan, intention, or activity still in progress; the server checks the original message.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "request_photo_bonus",
    description: "Try to add a photo bonus to a recently claimed task.",
    parameters: {
      type: "object",
      properties: { code: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "record_split",
    description:
      "Someone says the group is splitting up, now or on a coming day: 'me and jess are doing shimokita, boys are going to akihabara', 'i'm sleeping in, you guys go ahead', 'we're splitting after lunch', 'some of us want an early start'. Extract who, where and when, words as said. who: 'me' for the sender, names as said, 'everyone else' for the rest, descriptions like 'the boys' as said. Code places people and asks about anyone it cannot place.",
    parameters: {
      type: "object",
      properties: {
        groups: {
          type: "array",
          items: {
            type: "object",
            properties: {
              who: { type: "array", items: { type: "string" } },
              where: { type: "string" },
              starts: { type: "string" },
            },
            required: ["who"],
          },
        },
        from: { type: "string", description: "when the split starts for everyone, as said" },
        rejoin_time: { type: "string" },
        rejoin_place: { type: "string" },
        day: { type: "string", description: "only if not today: 'tomorrow', 'day 3', 'friday'" },
      },
      required: ["groups"],
      additionalProperties: false,
    },
  },
  {
    name: "record_regroup",
    description: "The group says it is back together today ('we're all back', 'regrouped', 'meeting up again').",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "add_suggestion",
    description:
      "Someone names a place or thing they want to do: 'we should go to teamLab', 'there's a jazz bar in golden gai i want to hit', 'put the fish market on day 3'. place: the name as said. neighborhood if they gave one. day only if they named one.",
    parameters: {
      type: "object",
      properties: {
        place: { type: "string" },
        neighborhood: { type: "string" },
        day: { type: "string" },
      },
      required: ["place"],
      additionalProperties: false,
    },
  },
  {
    name: "avoid_category",
    description: "The group does not want a kind of thing: 'we don't want to do temples', 'no more museums'. category: in their words.",
    parameters: {
      type: "object",
      properties: { category: { type: "string" } },
      required: ["category"],
      additionalProperties: false,
    },
  },
  {
    name: "update_my_setting",
    description:
      "The sender wants to change one of their own settings, any time, for any reason: pace, tasks per day, talking to strangers, interests, budget, chaos, diet, mobility, drinking, off-limits times, food adventure. setting: which one. value: what they want it to BE now, in their words ('faster', 'chaotic', '150', 'museums', 'fine with strangers', 'more'). mode for interests: add, remove or set. Code writes it and sends the reply.",
    parameters: {
      type: "object",
      properties: {
        setting: { type: "string" },
        value: { type: "string" },
        mode: { type: "string", enum: ["set", "add", "remove"] },
      },
      required: ["setting", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "update_trip_setting",
    description:
      "Change a trip-level setting: destination, dates, difficulty, board time, stake. value in their words. Code checks who can and sends the reply.",
    parameters: {
      type: "object",
      properties: { setting: { type: "string" }, value: { type: "string" } },
      required: ["setting", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "request_tasks",
    description:
      "The sender wants MORE tasks on top of their current board, or a specific number ('7 attractions', 'give me more', 'a packed day'). count: the number they asked for, if they gave one. day: only if not today. Code adds as many as fit in the day and sends the reply with their board. Never for different or new tasks instead of these: that is redo_today.",
    parameters: {
      type: "object",
      properties: { count: { type: "integer" }, day: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "redo_today",
    description:
      "Replace the sender's board with a different one: they want different or new tasks ('these are boring', 'give me something else', 'completely new tasks', 'redo today', 'reroll'), or say yes to a redo after a settings change. Claimed tasks stay; the rest is replaced with tasks that do not repeat the old ones. day: only if not today. everyone: true only for a trip-level change for the whole group. Code sends the reply, saying what changed.",
    parameters: {
      type: "object",
      properties: { everyone: { type: "boolean" }, day: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "get_my_profile",
    description:
      "What the bot knows about the SENDER only: their own survey answers and learned preferences, as a short summary. Call it before saying anything about what you know of them, and never say you know nothing about them without calling it. Never for anyone else. In a group chat, code sends it to their DM and replies for you; in a DM it returns the summary for you to answer from.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "react_to_message",
    description:
      "Tapback the message they just sent instead of (or in addition to) texting back. Use this for something funny, unhinged, or hype-worthy where a reaction hits harder than words. Not for every message, and not instead of answering a real question.",
    parameters: {
      type: "object",
      properties: {
        emoji: {
          type: "string",
          description: "A single emoji to react with, e.g. 💀 😭 🔥 😂 🫡 👑.",
        },
      },
      required: ["emoji"],
      additionalProperties: false,
    },
  },
  {
    name: "search_web",
    description:
      "Search the live web for something real and specific: restaurants, cafes, tickets, booking sites, or a place to look up on google maps. Call this before naming any specific place, restaurant, or link that is not already an open task or a trip landmark. query: a real search query in their words plus the destination, e.g. 'best teriyaki restaurants osaka' or 'universal studios japan tickets'.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "find_car_rental",
    description:
      "Find Enterprise Rent-A-Car for the trip city (or another city they named). Code sends a real booking/search link. Never invent prices or claim a reservation. city: optional override. pickup_date / return_date: optional yyyy-mm-dd from trip dates or what they said.",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string" },
        pickup_date: { type: "string" },
        return_date: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "no_action",
    description: "Talk without changing game state.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

function stringArg(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// A word, never a digit: reply-check discards any number in a reply that
// didn't come from a tool or the sender's own message, so the model gets a
// time-of-day label to reason with, not a clock time it could echo back.
function timeOfDayLabel(hour: number): string {
  if (hour < 5) return "late night";
  if (hour < 8) return "early morning";
  if (hour < 12) return "morning";
  if (hour < 14) return "midday";
  if (hour < 18) return "afternoon";
  if (hour < 22) return "evening";
  return "late night";
}

// Codes repeat per owner (everyone has an A1), so only show the sender theirs.
function claimableTasks(miss: ClaimFallthrough): TaskRow[] {
  return tasksClaimableBy(miss.tasks, miss.claimant.id, miss.claimantTeamIds);
}

function openTasksFor(tasks: TaskRow[], claims: ClaimRow[]): TaskRow[] {
  return tasks.filter((task) => isOpenTask(task.id, claims));
}


function userPrompt(opts: {
  text: string;
  senderName: string;
  survey: SurveyAnswers;
  openTasks: { code: string; title: string; neighborhood: string | null }[];
  people: string[];
  destination: string | null;
  day: number;
  timeOfDay: string;
  history: { role: string; text: string }[];
  // The first link in this message, already read. Without it the model sees a
  // bare URL, has no venue to pass to add_suggestion, and reaches for
  // search_web on the shortcode, which can never return anything.
  link: { url: string; name: string; city: string | null; address: string | null } | null;
}): string {
  const history = opts.history
    .map((line) => `${line.role}: ${line.text}`)
    .join("\n");
  return [
    `sender: ${opts.senderName}`,
    `destination: ${opts.destination ?? "unknown"}`,
    `day: ${opts.day}`,
    `local time of day: ${opts.timeOfDay}`,
    `people: ${opts.people.join(", ") || "(none)"}`,
    // Their own settings, all editable by them any time (update_my_setting).
    // Not rules: never quote one back as a reason something cannot happen.
    `sender's own settings (editable by them any time, not rules): ${JSON.stringify(opts.survey)}`,
    `open tasks: ${opts.openTasks.map((t) => `${t.code} ${t.title}`).join("; ") || "(none)"}`,
    ...(opts.link
      ? [
          `the link in this message is about: ${opts.link.name}${opts.link.city ? `, ${opts.link.city}` : ""}${opts.link.address ? ` (${opts.link.address})` : ""}. this is a real place read from the link itself: pass it to add_suggestion if they want to do it. never search_web for a url.`,
        ]
      : []),
    `recent chat:\n${history || "(none)"}`,
    `message:\n${opts.text}`,
  ].join("\n");
}

// Board facts for the get_open_tasks tool. Read-only: making a board is
// answerBoardRequest's job, reached before the model for any board request.
function boardInfo(miss: ClaimFallthrough, now: number): Record<string, unknown> {
  const at = new Date(now);
  const day = currentTripDay(miss.trip, at);
  const todays = claimableTasks(miss).filter((task) => task.day === day);
  const openToday = todays.filter((task) => isOpenTask(task.id, miss.claims));
  return {
    day,
    today_open: openToday.map((task) => ({ code: task.code, title: task.title })),
    today_cleared: todays.length > 0 && openToday.length === 0,
    current_period: currentBoardPeriod(miss.trip, at),
    board_commands: {
      current_period: "japlan show",
      all_periods: "japlan show all",
      morning: "japlan show morning",
      afternoon: "japlan show afternoon",
      evening: "japlan show night",
    },
  };
}

// "japlan lb": the same numbers get_standings would fetch, sent directly,
// same as answerBoardRequest short-circuits a plans/tasks request.
async function sendStandingsReply(miss: ClaimFallthrough): Promise<void> {
  const send = miss.send ?? sendText;
  const teams = await teamsWithMembers(miss.trip.id);
  const rows = buildStandingsRows(miss.people, teams).sort(
    (a, b) => b.score - a.score || a.display_name.localeCompare(b.display_name),
  );
  await send(miss.chatId, standingsLine(rows));
}

// "japlan dashboard" / "live board": the link, nothing else. The live
// dashboard only ever answers for an active trip (loadLiveTrip), which this
// always is by the time anyone can ask.
async function sendDashboardReply(miss: ClaimFallthrough): Promise<void> {
  const send = miss.send ?? sendText;
  const url = liveUrlFor(miss.trip.id);
  await send(miss.chatId, url ? liveDashboardLine(url) : DASHBOARD_UNAVAILABLE_LINE);
}

export async function handleConversation(
  miss: ClaimFallthrough,
  deps: { provider?: LLMProvider } = {},
): Promise<void> {
  const addressed = evaluateAddress({
    text: miss.text,
    isDm: miss.isDm,
    openTaskContext: miss.hasPhoto,
    engaged: miss.engaged,
  }).respond;
  if (!addressed) return;

  const now = miss.now ?? Date.now();
  const send = miss.send ?? sendText;

  // "japlan plans", "japlan tomorrow": the board for that day, made now if it
  // does not exist yet. No model; asking before a board exists is normal.
  // "different tasks", "these are boring", "redo today": replace the board,
  // before the plain board request (which only shows the stored one).
  if (isRedoRequest(miss.text)) {
    console.info("[japlan.board] step", { step: "redo.request", via: "matcher", text: miss.text.slice(0, 80) });
    await executeConversationTool("redo_today", { day: redoDayFrom(miss) }, miss);
    return;
  }
  if (isBoardRequest(miss.text)) {
    await answerBoardRequest(miss, now);
    return;
  }
  // "lb", "leader", "leaderboard", "standings", "scores": read straight from
  // the database and reply, same numbers get_standings would give the model,
  // without spending a model call on a request this unambiguous.
  // Someone else's profile: DM privacy, decided in code before any model
  // sees the question.
  const other = otherPersonAskedAbout(miss.text, miss.people, miss.claimant.id);
  if (other) {
    console.info("[japlan.profile] step", { step: "other_person.refused", asker: miss.claimant.id, about: other.id });
    await send(miss.chatId, CONVERSATION_PRIVACY_LINE);
    return;
  }
  if (isStandingsRequest(miss.text)) {
    await sendStandingsReply(miss);
    return;
  }
  // "japlan dashboard" / "live board": just the link, same short-circuit as
  // the standings request above.
  if (isDashboardRequest(miss.text)) {
    await sendDashboardReply(miss);
    return;
  }
  if (isCarRentalRequest(miss.text)) {
    await executeConversationTool("find_car_rental", {}, miss);
    return;
  }
  // No hourly reply cap: it refused people who had addressed the bot, which
  // is exactly who should get an answer. The model prompt keeps replies brief
  // when the message itself calls for a short answer.

  const provider = deps.provider ?? miss.provider ?? new GeminiProvider();
  const day = currentTripDay(miss.trip, new Date(now));
  const survey = surveySliceForConversation(
    (miss.claimant.survey_json ?? {}) as SurveyAnswers,
    miss.isDm,
  );
  const others = foreignSurveySecrets(miss.people, miss.claimant.id);
  // The last 15 messages of THIS chat, the bot's own replies included, with
  // who said what. A bot replying to nothing is usually a bot given nothing,
  // so the length is logged on every call.
  const transcript = await recentMessages(miss.chatId, TRANSCRIPT_LIMIT);
  const lines = transcript.at(-1)?.text === miss.text ? transcript.slice(0, -1) : transcript;
  const history = lines.map((l) => ({
    role: l.role === "bot" ? ("model" as const) : ("user" as const),
    text: l.role === "bot" ? l.text : `${l.sender ?? "someone"}: ${l.text}`,
  }));
  console.info("[japlan.conversation] context", {
    chatId: miss.chatId,
    lines: history.length,
    empty: history.length === 0,
  });
  // The first link in this message, read inline before the turn. Without it
  // the model sees a bare URL, has no venue to pass to add_suggestion, and
  // reaches for search_web on the shortcode. ~1.4s for a stateless read,
  // comparable to the search_web call already allowed here, and a miss just
  // leaves the model with what it had before.
  const link = findUrls(miss.text).length
    ? await resolveFirstLinkForContext({
        trip: miss.trip,
        text: miss.text,
        date: todayFor(miss.trip, new Date(now)),
      }).catch(() => null)
    : null;
  if (link) {
    console.info("[japlan.conversation] link context", {
      chatId: miss.chatId,
      kind: link.kind,
      place: link.name,
    });
  }

  const contents: ToolContent[] = [];
  for (const line of history) {
    contents.push({ role: line.role, parts: [{ text: line.text }] });
  }
  contents.push({
    role: "user",
    parts: [
      {
        text: userPrompt({
          text: miss.text,
          senderName: miss.claimant.display_name,
          survey,
          // No task list here: tasks are facts, and facts come from
          // get_open_tasks in this turn, not from the prompt.
          openTasks: [],
          people: miss.people.map((person) => person.display_name),
          destination: miss.trip.destination,
          day,
          timeOfDay: timeOfDayLabel(localHour(new Date(now), zoneNow(miss.trip, new Date(now)))),
          history,
          link,
        }),
      },
    ],
  });

  // Same Gemini agent loop as the itinerary lab, but with the ORIGINAL game
  // tool set only. Research tools (search_places, search_events, …) stay on
  // the lab path so chat tool-choice cannot regress.
  const tools: AgentTool[] = CONVERSATION_TOOL_DEFS.map((def) =>
    wrapConversationTool({
      name: def.name,
      description: def.description,
      geminiParameters: def.parameters,
      execute: (args) => executeConversationTool(def.name, args, miss),
    }),
  );

  const loop = await runJaplanAgent({
    capability: "webhook",
    system: CONVERSATION_SYSTEM_PROMPT,
    contents,
    tools,
    maxIterations: CONVERSATION_MAX_TOOL_ITERS,
    provider,
    trip: miss.trip,
    miss,
    photo: null,
    tier: "fast",
  });

  const toolText: string[] = [];
  for (const entry of contents) {
    for (const part of entry.parts) {
      if ("functionResponse" in part) {
        toolText.push(JSON.stringify(part.functionResponse.response));
      }
    }
  }

  // Record tool names for tracing, but never their arguments (which can
  // contain private settings) or message/profile contents.
  if (loop.toolNames.length > 0) {
    console.info("[japlan.conversation] tools", {
      chatId: miss.chatId,
      tools: loop.toolNames,
      via: "runJaplanAgent",
      browserbaseInvoked: loop.browserbaseInvoked,
    });
  }

  if (loop.sentByTool) {
    return;
  }

  const reply = finalizeConversationReply({
    text: loop.text,
    others,
    policy: { consecutive: 0, redirect: false, oneLine: false },
    redirect: "",
    fallback: CONVERSATION_FALLBACK,
    privacyLine: CONVERSATION_PRIVACY_LINE,
  });

  // Checked against reality before it goes out: nothing untrue, nothing
  // empty, and actually a reply to what was said. Code-written lines (the
  // fallback, the privacy line) are not model text and skip the checks.
  const fromModel = reply !== CONVERSATION_FALLBACK && reply !== CONVERSATION_PRIVACY_LINE;
  const verdict = fromModel
    ? await vetReply(reply, miss, toolText, history, loop.toolNames)
    : { ok: true as const };
  const out = verdict.ok ? reply : DISCARD_FALLBACK;
  if (!verdict.ok) {
    console.warn("[japlan.conversation] discard", { chatId: miss.chatId, reason: verdict.reason, reply: reply.slice(0, 300) });
  }

  recordConversationalReply(miss.chatId, now);
  await send(miss.chatId, out);
}

// The trip's own names (places, task titles and neighborhoods) a reply may
// mention without a tool having returned them this turn.
function tripContextText(miss: ClaimFallthrough, history: { text: string }[]): string {
  const profile = (miss.trip.destination_profile_json ?? null) as DestinationProfile | null;
  return [
    ...history.map((h) => h.text),
    ...(profile?.landmarks ?? []).map((l) => l.name),
    ...(profile?.neighborhoods ?? []).map((n) => n.name),
    ...miss.tasks.flatMap((t) => [t.title, t.neighborhood ?? ""]),
    miss.trip.destination ?? "",
  ].join(" | ");
}

async function vetReply(
  reply: string,
  miss: ClaimFallthrough,
  toolText: string[],
  history: { text: string }[],
  toolNames: string[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const facts = checkReply(reply, {
    taskCodes: miss.tasks.map((t) => t.code),
    people: miss.people.map((p) => p.display_name),
    toolText: toolText.join(" "),
    userText: miss.text,
    contextText: tripContextText(miss, history),
    // "i'll add that to day 3" is only allowed to go out if something
    // actually wrote it.
    stateChanged: changedState(toolNames),
  });
  if (!facts.ok) return facts;
  // One cheap check: does it respond to what was actually said?
  const recent = [...history.slice(-5).map((h) => h.text), `${miss.claimant.display_name}: ${miss.text}`].join("\n");
  const relevant = await judgeRelevance({ provider: miss.provider, transcript: recent, reply });
  if (relevant === null) {
    console.info("[japlan.conversation] relevance unchecked", { chatId: miss.chatId });
    return { ok: true };
  }
  return relevant.decision ? { ok: true } : { ok: false, reason: `irrelevant: ${relevant.reason}` };
}

async function executeConversationTool(
  name: string,
  args: Record<string, unknown>,
  miss: ClaimFallthrough,
): Promise<{ result: Record<string, unknown>; sent: boolean }> {
  if (name === "get_standings") {
    const teams = await teamsWithMembers(miss.trip.id);
    const rows = buildStandingsRows(miss.people, teams)
      .map((row) => ({ name: row.display_name, score: row.score }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return { result: { standings: rows }, sent: false };
  }
  if (name === "get_open_tasks") {
    const tasks = openTasksFor(claimableTasks(miss), miss.claims).map((task) => ({
      code: task.code,
      title: task.title,
      neighborhood: task.neighborhood,
    }));
    // The board state too, so "what's the plan" can say when the next board
    // lands instead of guessing.
    const board = boardInfo(miss, miss.now ?? Date.now());
    return { result: { tasks, board }, sent: false };
  }
  if (name === "get_live_nearby_options") {
    if (miss.isDm) {
      return {
        result: {
          status: "group_only",
          note: "Ask for live nearby options in the trip group so Japlan can respect each person's consent.",
        },
        sent: false,
      };
    }
    if (!/\b(?:what (?:should|can|could) we do (?:right now|now|nearby)|what(?:'s| is) (?:nearby|near us|near here|the move)|where (?:are we|is everyone|are people)|anything (?:good )?nearby|nearby (?:options|ideas|places)|live location|japlan nearby)\b/i.test(miss.text)) {
      return {
        result: { status: "not_requested", note: "Only read live locations after an explicit right-now or nearby request in the trip group." },
        sent: false,
      };
    }
    return {
      result: await getOnDemandLocationContext({
        trip: miss.trip,
        now: new Date(miss.now ?? Date.now()),
      }),
      sent: false,
    };
  }
  if (name === "no_action") {
    return { result: { ok: true }, sent: false };
  }
  if (name === "propose_freeform_claim") {
    // The model's tool call is only a suggestion to check for a claim. The
    // claim handler re-extracts the activity from the original message and
    // rejects plans or intentions that are not completed activities.
    const sent = await submitFreeformClaim({
      text: miss.text,
      claimChatId: miss.chatId,
      hasPhoto: miss.hasPhoto,
      photo: miss.photo,
      claimant: miss.claimant,
      people: miss.people,
      trip: miss.trip,
      tasks: miss.tasks,
      claims: miss.claims,
      send: miss.send,
      provider: miss.provider,
      nextStep: miss.nextStep,
    });
    return { result: { ok: sent }, sent };
  }
  if (name === "request_photo_bonus") {
    if (!miss.photo) {
      return { result: { ok: false, reason: "no_photo" }, sent: false };
    }
    const code =
      typeof args.code === "string" && args.code.trim()
        ? args.code.trim().toUpperCase()
        : null;
    const bind = pickLatePhotoTarget({
      hasPhoto: true,
      code,
      claimantId: miss.claimant.id,
      claims: miss.claims,
      tasks: claimableTasks(miss),
      now: miss.now ?? Date.now(),
      windowMs: photoBonusWindowMs(),
    });
    if (bind.kind !== "bonus") {
      return { result: { ok: false, reason: bind.kind }, sent: false };
    }
    const task = miss.tasks.find((row) => row.id === bind.taskId);
    const claim = miss.claims.find((row) => row.id === bind.claimId);
    if (!task || !claim) {
      return { result: { ok: false, reason: "missing" }, sent: false };
    }
    await applyLatePhotoBonus({
      task,
      claim,
      claimant: miss.claimant,
      trip: miss.trip,
      photo: miss.photo,
      replyChatId: miss.chatId,
      send: miss.send,
      provider: miss.provider,
      sourceMessageId: typeof miss.data.id === "string" ? miss.data.id : null,
    });
    return { result: { ok: true, code: task.code }, sent: true };
  }
  if (
    name === "update_my_setting" ||
    name === "update_trip_setting" ||
    name === "request_tasks" ||
    name === "redo_today"
  ) {
    const ctx = {
      trip: miss.trip,
      people: miss.people,
      sender: miss.claimant,
      now: new Date(miss.now ?? Date.now()),
      text: miss.text,
    };
    const send = miss.send ?? sendText;
    if (name === "update_my_setting") {
      const setting = stringArg(args.setting);
      const value = stringArg(args.value);
      if (!setting || !value) return { result: { ok: false, reason: "need_setting_and_value" }, sent: false };
      const mode = args.mode === "add" || args.mode === "remove" ? args.mode : "set";
      const out = await updateMySetting({ ...ctx, isDm: miss.isDm }, { setting, value, mode });
      await send(miss.chatId, out.reply);
      if (out.dm) await sendDM(miss.claimant.phone, out.dm);
      return { result: { ok: true }, sent: true };
    }
    let reply: string;
    if (name === "update_trip_setting") {
      const setting = stringArg(args.setting);
      const value = stringArg(args.value);
      if (!setting || !value) return { result: { ok: false, reason: "need_setting_and_value" }, sent: false };
      reply = await updateTripSetting(ctx, { setting, value });
    } else if (name === "request_tasks") {
      const count = Number(args.count);
      const text = await requestTasks(ctx, {
        count: Number.isFinite(count) && count > 0 ? Math.round(count) : null,
        day: stringArg(args.day),
      });
      // The board is personal: in a group it goes to their DM.
      if (!miss.isDm) {
        await sendDM(miss.claimant.phone, text);
        await send(miss.chatId, BOARD_IN_DM_LINE);
        return { result: { ok: true }, sent: true };
      }
      reply = text;
    } else {
      reply = await redoToday(ctx, { everyone: args.everyone === true, day: stringArg(args.day) });
      if (!miss.isDm && args.everyone !== true) {
        await sendDM(miss.claimant.phone, reply);
        await send(miss.chatId, BOARD_IN_DM_LINE);
        return { result: { ok: true }, sent: true };
      }
    }
    await send(miss.chatId, reply);
    return { result: { ok: true }, sent: true };
  }
  if (
    name === "record_split" ||
    name === "record_regroup" ||
    name === "add_suggestion" ||
    name === "avoid_category"
  ) {
    const ctx = {
      trip: miss.trip,
      people: miss.people,
      sender: miss.claimant,
      now: new Date(miss.now ?? Date.now()),
      text: miss.text,
    };
    let reply: string;
    if (name === "record_split") {
      const groups = Array.isArray(args.groups) ? args.groups : [];
      reply = await recordSplit(ctx, {
        groups: groups
          .filter((g): g is Record<string, unknown> => Boolean(g) && typeof g === "object")
          .map((g) => ({
            who: Array.isArray(g.who) ? g.who.filter((w): w is string => typeof w === "string") : [],
            where: stringArg(g.where),
            starts: stringArg(g.starts),
          })),
        from: stringArg(args.from),
        rejoinTime: stringArg(args.rejoin_time),
        rejoinPlace: stringArg(args.rejoin_place),
        day: stringArg(args.day),
      });
    } else if (name === "record_regroup") {
      reply = await recordRegroup(ctx);
    } else if (name === "add_suggestion") {
      const place = stringArg(args.place);
      if (!place) return { result: { ok: false, reason: "need_place" }, sent: false };
      reply = await addSuggestion(ctx, {
        place,
        neighborhood: stringArg(args.neighborhood),
        day: stringArg(args.day),
      });
    } else {
      const category = stringArg(args.category);
      if (!category) return { result: { ok: false, reason: "need_category" }, sent: false };
      reply = await avoidCategory(ctx, category);
    }
    await (miss.send ?? sendText)(miss.chatId, reply);
    return { result: { ok: true }, sent: true };
  }
  if (name === "get_my_profile") {
    // miss.claimant was resolved by (trip_id, phone) in loadTripContext.
    const own = await lookupOwnProfile(miss.trip, miss.claimant.id);
    const text = own && !own.finished && own.nextQuestion
      ? profileUnfinishedLine(own.nextQuestion)
      : profileLine(own?.text ?? null);
    if (!miss.isDm) {
      // DM-private: the content never goes to the model in a group, so it
      // can never end up in a group reply.
      await sendDM(miss.claimant.phone, text);
      await (miss.send ?? sendText)(miss.chatId, PROFILE_IN_DM_LINE);
      console.info("[japlan.conversation] profile", { chatId: miss.chatId, passedToModel: 0, sentTo: "dm" });
      return { result: { ok: true, sent_to: "dm" }, sent: true };
    }
    console.info("[japlan.conversation] profile", { chatId: miss.chatId, passedToModel: (own?.text ?? "").length, finished: own?.finished ?? false });
    return {
      result: {
        finished: own?.finished ?? false,
        profile: own?.text ?? null,
        next_question: own?.nextQuestion ?? null,
      },
      sent: false,
    };
  }
  if (name === "search_web") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return { result: { ok: false, reason: "need_query" }, sent: false };
    }
    const outcome = await searchTheWeb(query);
    if (!outcome.ok) {
      return { result: { ok: false, reason: outcome.reason }, sent: false };
    }
    return { result: { ok: true, results: outcome.results }, sent: false };
  }
  if (name === "find_car_rental") {
    const city =
      stringArg(args.city) ??
      miss.trip.destination ??
      null;
    const pickup =
      stringArg(args.pickup_date) ?? miss.trip.start_date ?? null;
    const ret = stringArg(args.return_date) ?? miss.trip.end_date ?? null;
    const underAge = isUnderAge(
      (miss.claimant.survey_json ?? {}) as SurveyAnswers,
    );
    const outcome = await findEnterpriseRentals({
      city,
      pickupDate: pickup,
      returnDate: ret,
      underAge,
    });
    const reply = enterpriseRentalReply(outcome);
    await (miss.send ?? sendText)(miss.chatId, reply);
    return {
      result: {
        ok: outcome.ok,
        reason: outcome.ok ? undefined : outcome.reason,
        booking_url: outcome.bookingUrl,
        links: outcome.ok ? outcome.links : [],
        notes: outcome.notes,
      },
      sent: true,
    };
  }
  if (name === "react_to_message") {
    const emoji = typeof args.emoji === "string" ? args.emoji.trim() : "";
    const messageId = typeof miss.data.id === "string" ? miss.data.id : null;
    if (!emoji || !messageId) {
      return { result: { ok: false, reason: "no_message" }, sent: false };
    }
    try {
      await react(messageId, { emoji });
    } catch (err) {
      console.error("[japlan.conversation] reaction failed", { messageId, err });
      return { result: { ok: false, reason: "failed" }, sent: false };
    }
    // A reaction alone can be the whole response: it does not force a text
    // reply, but doesn't block one either if the model still has something
    // to say this turn.
    return { result: { ok: true, emoji }, sent: false };
  }
  return { result: { ok: false, reason: "unknown_tool" }, sent: false };
}

// The day a redo request names ("redo tomorrow", "different tasks for day 3"),
// or null for today.
function redoDayFrom(miss: ClaimFallthrough): string | null {
  const m = miss.text
    .toLowerCase()
    .match(/\b(tomorrow|tmrw|day\s*\d{1,2}|monday|tuesday|wednesday|thursday|friday|saturday|sunday|(?:the\s+)?(?:first|last|final)\s+day)\b/);
  return m?.[1] ?? null;
}
