import { getServiceClient } from "@/lib/db/client";
import type { ClaimRow, TaskRow } from "@/lib/db/types";
import { evaluateAddress } from "@/lib/game/addressing";
import {
  CONVERSATION_HISTORY_LIMIT,
  CONVERSATION_MAX_TOOL_ITERS,
  conversationalCapReached,
  foreignSurveySecrets,
  getOffTopicCount,
  isOnTopicExchange,
  nextOffTopicCount,
  offTopicPolicy,
  recordConversationalReply,
  runToolLoop,
  setOffTopicCount,
  stripPointFields,
  surveySliceForConversation,
  toolResultHasInventedPoints,
  finalizeConversationReply,
} from "@/lib/game/conversation";
import {
  CONVERSATION_FALLBACK,
  CONVERSATION_PRIVACY_LINE,
  CONVERSATION_SYSTEM_PROMPT,
  conversationCapLine,
  conversationRedirect,
} from "@/lib/game/copy";
import type { FreeformExtraction } from "@/lib/game/freeform";
import {
  isOpenTask,
  pickLatePhotoTarget,
  photoBonusWindowMs,
  tasksClaimableBy,
} from "@/lib/game/claims";
import type { Axes } from "@/lib/game/scoring";
import type { SurveyAnswers } from "@/lib/game/survey";
import { currentTripDay } from "@/lib/handlers/daily-board";
import {
  applyLatePhotoBonus,
  submitFreeformClaim,
  type ClaimFallthrough,
} from "@/lib/handlers/claims";
import type { LLMProvider, ToolContent, ToolTurn } from "@/lib/llm";
import { GeminiProvider } from "@/lib/llm/gemini";
import {
  chatIdFromData,
  isFromMe,
  textFromParts,
} from "@/lib/linq/payload";
import { sendText } from "@/lib/linq/send";

const CONVERSATION_TOOL_DEFS = [
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
    name: "propose_freeform_claim",
    description:
      "They already did something not on the board. Return title and six axes 1-5. Never include a point value.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        neighborhood: { type: "string" },
        place_name: { type: "string" },
        axes: {
          type: "object",
          properties: {
            boldness: { type: "integer" },
            physical: { type: "integer" },
            time: { type: "integer" },
            scarcity: { type: "integer" },
            cultural: { type: "integer" },
            aesthetics: { type: "integer" },
          },
          required: [
            "boldness",
            "physical",
            "time",
            "scarcity",
            "cultural",
            "aesthetics",
          ],
        },
      },
      required: ["title", "axes"],
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
    name: "no_action",
    description: "Talk without changing game state.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

function clampAxis(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 1;
  return Math.min(5, Math.max(1, n));
}

function axesFromTool(raw: unknown): Axes | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  return {
    boldness: clampAxis(row.boldness),
    physical: clampAxis(row.physical),
    time: clampAxis(row.time),
    scarcity: clampAxis(row.scarcity),
    cultural: clampAxis(row.cultural),
    aesthetics: clampAxis(row.aesthetics),
  };
}

// Codes repeat per owner (everyone has an A1), so only show the sender theirs.
function claimableTasks(miss: ClaimFallthrough): TaskRow[] {
  return tasksClaimableBy(miss.tasks, miss.claimant.id, miss.claimantTeamIds);
}

function openTasksFor(tasks: TaskRow[], claims: ClaimRow[]): TaskRow[] {
  return tasks.filter((task) => isOpenTask(task.id, claims));
}

async function recentChatLines(chatId: string): Promise<{ role: "user" | "model"; text: string }[]> {
  const { data, error } = await getServiceClient()
    .from("events")
    .select("payload, created_at, type")
    .eq("type", "message.received")
    .order("created_at", { ascending: false })
    .limit(80);
  if (error) throw error;
  const lines: { role: "user" | "model"; text: string }[] = [];
  for (const row of data ?? []) {
    const payload = row.payload as { data?: unknown } | null;
    const inner = payload && typeof payload === "object" ? payload.data : payload;
    const eventChat = chatIdFromData(inner);
    if (eventChat !== chatId) continue;
    const text = textFromParts(
      inner && typeof inner === "object"
        ? (inner as { parts?: unknown }).parts
        : undefined,
    );
    if (!text) continue;
    lines.push({
      role: isFromMe(inner) ? "model" : "user",
      text,
    });
    if (lines.length >= CONVERSATION_HISTORY_LIMIT) break;
  }
  return lines.reverse();
}

function userPrompt(opts: {
  text: string;
  senderName: string;
  survey: SurveyAnswers;
  openTasks: { code: string; title: string; neighborhood: string | null }[];
  people: string[];
  destination: string | null;
  day: number;
  history: { role: string; text: string }[];
  offTopicCount: number;
}): string {
  const history = opts.history
    .map((line) => `${line.role}: ${line.text}`)
    .join("\n");
  return [
    `sender: ${opts.senderName}`,
    `destination: ${opts.destination ?? "unknown"}`,
    `day: ${opts.day}`,
    `people: ${opts.people.join(", ") || "(none)"}`,
    `sender survey: ${JSON.stringify(opts.survey)}`,
    `open tasks: ${opts.openTasks.map((t) => `${t.code} ${t.title}`).join("; ") || "(none)"}`,
    `consecutive off-topic: ${opts.offTopicCount}`,
    `recent chat:\n${history || "(none)"}`,
    `message:\n${opts.text}`,
  ].join("\n");
}

export async function handleConversation(
  miss: ClaimFallthrough,
  deps: { provider?: LLMProvider } = {},
): Promise<void> {
  const addressed = evaluateAddress({
    text: miss.text,
    isDm: miss.isDm,
    openTaskContext: miss.hasPhoto,
  }).respond;
  if (!addressed) return;

  const now = miss.now ?? Date.now();
  const send = miss.send ?? sendText;
  if (conversationalCapReached(miss.chatId, now)) {
    console.info("[japlan.conversation] hourly cap", {
      chatId: miss.chatId,
      at: new Date(now).toISOString(),
    });
    // Addressed means answered: a fixed line, no model call, not counted.
    await send(miss.chatId, conversationCapLine(miss.nextStep));
    return;
  }

  const provider = deps.provider ?? miss.provider ?? new GeminiProvider();
  const open = openTasksFor(claimableTasks(miss), miss.claims);
  const day = currentTripDay(miss.trip, new Date(now));
  const survey = surveySliceForConversation(
    (miss.claimant.survey_json ?? {}) as SurveyAnswers,
    miss.isDm,
  );
  const others = foreignSurveySecrets(miss.people, miss.claimant.id);
  const history = await recentChatLines(miss.chatId);
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
          openTasks: open.map((task) => ({
            code: task.code,
            title: task.title,
            neighborhood: task.neighborhood,
          })),
          people: miss.people.map((person) => person.display_name),
          destination: miss.trip.destination,
          day,
          history,
          offTopicCount: getOffTopicCount(miss.chatId),
        }),
      },
    ],
  });

  const generate = async (input: {
    iteration: number;
    forceReply: boolean;
  }): Promise<ToolTurn> => {
    if (!provider.completeTurn) {
      const text = await provider.complete({
        system: CONVERSATION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: miss.text }],
        tier: "fast",
        thinkingBudget: 0,
      });
      return { text, functionCalls: [] };
    }
    return provider.completeTurn({
      system: CONVERSATION_SYSTEM_PROMPT,
      contents,
      tools: CONVERSATION_TOOL_DEFS,
      toolMode: input.forceReply ? "none" : "auto",
      tier: "fast",
      thinkingBudget: 0,
    });
  };

  const loop = await runToolLoop({
    maxIterations: CONVERSATION_MAX_TOOL_ITERS,
    generate: async (input) => {
      const turn = await generate(input);
      if (turn.functionCalls.length > 0) {
        contents.push({
          role: "model",
          parts: turn.functionCalls.map((call) => ({
            functionCall: {
              id: call.id,
              name: call.name,
              args: stripPointFields(call.args ?? {}),
            },
          })),
        });
      } else if (turn.text) {
        contents.push({ role: "model", parts: [{ text: turn.text }] });
      }
      return {
        text: turn.text,
        calls: turn.functionCalls.map((call) => ({
          id: call.id,
          name: call.name,
          args: stripPointFields(call.args ?? {}),
        })),
      };
    },
    execute: async (call) => {
      const result = await executeConversationTool(call.name, call.args, miss);
      if (toolResultHasInventedPoints(result.result)) {
        throw new Error("conversation tool returned an invented point value");
      }
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              id: call.id,
              name: call.name,
              response: result.result,
            },
          },
        ],
      });
      return result;
    },
  });

  const onTopic = isOnTopicExchange({
    toolNames: loop.toolNames,
    text: miss.text,
    destination: miss.trip.destination,
    taskTitles: open.map((task) => task.title),
    neighborhoods: open
      .map((task) => task.neighborhood)
      .filter((value): value is string => Boolean(value)),
  });
  const next = nextOffTopicCount(getOffTopicCount(miss.chatId), !onTopic);
  setOffTopicCount(miss.chatId, next);
  const policy = offTopicPolicy(next);
  const trailing = [...miss.people].sort((a, b) => a.score - b.score)[0];
  const redirect = conversationRedirect({
    task: open[0] ? { code: open[0].code } : null,
    nearby: open[0]?.neighborhood || miss.trip.destination,
    trailingName: trailing?.display_name ?? null,
  });

  if (loop.sentByTool) {
    return;
  }

  const reply = finalizeConversationReply({
    text: loop.text,
    others,
    policy,
    redirect,
    fallback: CONVERSATION_FALLBACK,
    privacyLine: CONVERSATION_PRIVACY_LINE,
  });

  recordConversationalReply(miss.chatId, now);
  await send(miss.chatId, reply);
}

async function executeConversationTool(
  name: string,
  args: Record<string, unknown>,
  miss: ClaimFallthrough,
): Promise<{ result: Record<string, unknown>; sent: boolean }> {
  if (name === "get_standings") {
    const rows = [...miss.people]
      .sort((a, b) => b.score - a.score || a.display_name.localeCompare(b.display_name))
      .map((person) => ({ name: person.display_name, score: person.score }));
    return { result: { standings: rows }, sent: false };
  }
  if (name === "get_open_tasks") {
    const tasks = openTasksFor(claimableTasks(miss), miss.claims).map((task) => ({
      code: task.code,
      title: task.title,
      neighborhood: task.neighborhood,
    }));
    return { result: { tasks }, sent: false };
  }
  if (name === "no_action") {
    return { result: { ok: true }, sent: false };
  }
  if (name === "propose_freeform_claim") {
    const clean = stripPointFields(args);
    const title = typeof clean.title === "string" ? clean.title.trim() : "";
    const axes = axesFromTool(clean.axes);
    if (!title || !axes) {
      return { result: { ok: false, reason: "need_title_and_axes" }, sent: false };
    }
    const extraction: FreeformExtraction = {
      is_completed_activity: true,
      title,
      place_name:
        typeof clean.place_name === "string" ? clean.place_name : null,
      neighborhood:
        typeof clean.neighborhood === "string" ? clean.neighborhood : null,
      duration_minutes: null,
      lat: null,
      lng: null,
      category: null,
      axes,
    };
    const sent = await submitFreeformClaim({
      text: miss.text,
      hasPhoto: miss.hasPhoto,
      photo: miss.photo,
      claimant: miss.claimant,
      people: miss.people,
      trip: miss.trip,
      tasks: miss.tasks,
      claims: miss.claims,
      send: miss.send,
      provider: miss.provider,
      extraction,
      nextStep: miss.nextStep,
    });
    return { result: { ok: sent, title }, sent };
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
      send: miss.send,
      provider: miss.provider,
    });
    return { result: { ok: true, code: task.code }, sent: true };
  }
  return { result: { ok: false, reason: "unknown_tool" }, sent: false };
}
