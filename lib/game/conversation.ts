import type { ClaimDecision } from "./claims";
import { QUESTIONS, type QuestionId } from "./survey-questions";
import type { SurveyAnswers } from "./survey";
import { answerValue } from "./survey";

export const CONVERSATION_REPLY_CAP = 6;
export const CONVERSATION_WINDOW_MS = 60 * 60 * 1000;
export const CONVERSATION_MAX_TOOL_ITERS = 3;
export const CONVERSATION_HISTORY_LIMIT = 15;

export const CONVERSATION_TOOLS = [
  "get_standings",
  "get_open_tasks",
  "propose_freeform_claim",
  "request_photo_bonus",
  "react_to_message",
  "no_action",
] as const;

export type ConversationToolName = (typeof CONVERSATION_TOOLS)[number];

export const POINT_FIELD_KEYS = [
  "points",
  "base_points",
  "awarded_points",
  "score",
  "total",
  "photo_bonus",
  "photoBonus",
] as const;

export const PRIVATE_SURVEY_IDS: QuestionId[] = [
  "budget",
  "dietary",
  "dietary_detail",
  "dietary_strictness",
  "sociability",
  "age_bracket",
  "mobility",
  "blackout",
  "social_with",
  "social_travelled",
  "social_couples",
];

// The ONLY survey answers that may reach a group prompt. An allowlist, not a
// denylist: a question id in neither this nor PRIVATE_SURVEY_IDS is excluded
// from every slice, so a new survey field is private until somebody decides
// otherwise. conversation-privacy.test.ts pins that.
//
// must_have is here deliberately. "this trip is a waste if we don't ___" is
// the one answer a person is making TO the group: it is their pitch, not a
// fact about their body, their money or who they want to be with. Everything
// in PRIVATE_SURVEY_IDS stays in DM.
export const PUBLIC_SURVEY_IDS: QuestionId[] = [
  "first_name",
  "interests",
  "interest_picks",
  "pace",
  "chaos",
  "nightlife",
  "competitiveness",
  "attractions",
  "must_have",
];

const GAME_TOOLS = new Set<string>([
  "get_standings",
  "get_open_tasks",
  "propose_freeform_claim",
  "request_photo_bonus",
  "record_split",
  "record_regroup",
  "add_suggestion",
  "avoid_category",
]);

export type ConversationStore = {
  offTopic: Map<string, number>;
  replies: Map<string, number[]>;
};

const defaultStore: ConversationStore = {
  offTopic: new Map(),
  replies: new Map(),
};

export function getConversationStore(): ConversationStore {
  return defaultStore;
}

export function resetConversationStore(
  store: ConversationStore = defaultStore,
): void {
  store.offTopic.clear();
  store.replies.clear();
}

export function shouldEnterConversation(claim: ClaimDecision): boolean {
  if (claim.type === "code") return false;
  if (claim.type === "silent") {
    return claim.reason === "no_match";
  }
  return claim.type === "fuzzy" || claim.type === "vision";
}

export function stripPointFields(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if ((POINT_FIELD_KEYS as readonly string[]).includes(key)) continue;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      out[key] = stripPointFields(entry as Record<string, unknown>);
    } else {
      out[key] = entry;
    }
  }
  return out;
}

export function toolResultHasInventedPoints(
  result: Record<string, unknown>,
): boolean {
  for (const key of POINT_FIELD_KEYS) {
    if (key in result) return true;
  }
  return false;
}

export function isGameTool(name: string): boolean {
  return GAME_TOOLS.has(name);
}

export function looksOnTopic(opts: {
  text: string;
  destination?: string | null;
  taskTitles?: string[];
  neighborhoods?: string[];
}): boolean {
  const blob = [
    opts.text,
    opts.destination ?? "",
    ...(opts.taskTitles ?? []),
    ...(opts.neighborhoods ?? []),
  ]
    .join(" ")
    .toLowerCase();
  const text = opts.text.toLowerCase();
  if (
    /\b(task|board|standings?|score|claim|photo|bonus|points?|leaderboard|nearby|neighborhood|itinerary)\b/.test(
      text,
    )
  ) {
    return true;
  }
  if (opts.destination && text.includes(opts.destination.toLowerCase())) {
    return true;
  }
  for (const title of opts.taskTitles ?? []) {
    if (title && text.includes(title.toLowerCase())) return true;
  }
  for (const hood of opts.neighborhoods ?? []) {
    if (hood && text.includes(hood.toLowerCase())) return true;
  }
  void blob;
  return false;
}

export function isOnTopicExchange(opts: {
  toolNames: string[];
  text: string;
  destination?: string | null;
  taskTitles?: string[];
  neighborhoods?: string[];
}): boolean {
  if (opts.toolNames.some((name) => isGameTool(name))) return true;
  return looksOnTopic(opts);
}

export function nextOffTopicCount(prev: number, offTopic: boolean): number {
  if (!offTopic) return 0;
  return prev + 1;
}

export type OffTopicPolicy = {
  consecutive: number;
  redirect: boolean;
  oneLine: boolean;
};

export function offTopicPolicy(consecutive: number): OffTopicPolicy {
  if (consecutive <= 0) {
    return { consecutive: 0, redirect: false, oneLine: false };
  }
  if (consecutive <= 2) {
    return { consecutive, redirect: false, oneLine: false };
  }
  if (consecutive === 3) {
    return { consecutive, redirect: true, oneLine: false };
  }
  return { consecutive, redirect: true, oneLine: true };
}

export function shapeOffTopicReply(
  reply: string,
  policy: OffTopicPolicy,
  redirect: string,
): string {
  const trimmed = reply.trim();
  if (!policy.redirect) return trimmed;
  const body = policy.oneLine
    ? trimmed.split(/\n/)[0]?.trim() || trimmed
    : trimmed;
  if (!redirect) return body;
  if (body.toLowerCase().includes(redirect.toLowerCase())) return body;
  return `${body} ${redirect}`.trim();
}

export function recordConversationalReply(
  chatId: string,
  now: number,
  store: ConversationStore = defaultStore,
): void {
  const prior = store.replies.get(chatId) ?? [];
  store.replies.set(chatId, [...prior, now]);
}

export function conversationalRepliesInWindow(
  chatId: string,
  now: number,
  windowMs = CONVERSATION_WINDOW_MS,
  store: ConversationStore = defaultStore,
): number {
  const cutoff = now - windowMs;
  const kept = (store.replies.get(chatId) ?? []).filter((at) => at > cutoff);
  store.replies.set(chatId, kept);
  return kept.length;
}

export function conversationalCapReached(
  chatId: string,
  now: number,
  cap = CONVERSATION_REPLY_CAP,
  store: ConversationStore = defaultStore,
): boolean {
  return conversationalRepliesInWindow(chatId, now, CONVERSATION_WINDOW_MS, store) >= cap;
}

export function getOffTopicCount(
  chatId: string,
  store: ConversationStore = defaultStore,
): number {
  return store.offTopic.get(chatId) ?? 0;
}

export function setOffTopicCount(
  chatId: string,
  count: number,
  store: ConversationStore = defaultStore,
): void {
  store.offTopic.set(chatId, count);
}

export function resetOffTopicOnClaim(
  chatId: string,
  store: ConversationStore = defaultStore,
): void {
  store.offTopic.set(chatId, 0);
}

export function surveySliceForConversation(
  answers: SurveyAnswers | null | undefined,
  isDm: boolean,
): SurveyAnswers {
  const source = answers ?? {};
  const ids = isDm
    ? [...PUBLIC_SURVEY_IDS, ...PRIVATE_SURVEY_IDS]
    : PUBLIC_SURVEY_IDS;
  const slice: SurveyAnswers = {};
  for (const id of ids) {
    const value = source[id];
    if (value) slice[id] = value;
  }
  return slice;
}

// Values too generic to identify anyone ("no", "none"). Matching these made
// every reply containing "not" or "below" look like a leak.
const TRIVIAL_ANSWER_RE = /^(no|none|nope|nothing|yes|n\/?a|na|skip)$/i;

// What an enum answer is about. An enum value like "low" only leaks when the
// reply names the person AND the topic ("sarah's budget is low"); on its own
// it is an ordinary word.
const ENUM_TOPIC_RE: Partial<Record<QuestionId, RegExp>> = {
  budget: /\b(budget|money|spend\w*|afford\w*|cheap|broke|price\w*)\b/i,
  dietary: /\b(diet\w*|allerg\w*|restriction\w*|vegan|vegetarian|eat)\b/i,
  dietary_strictness: /\b(diet\w*|allerg\w*|restriction\w*|strict)\b/i,
  mobility: /\b(mobility|walk\w*|knee\w*|stairs|wheelchair|physical|limits?)\b/i,
  social_couples: /\b(couples?|partner\w*|together|split)\b/i,
};

export type EnumSecret = { value: string; topic: RegExp };

function enumValueOf(id: QuestionId, value: string): string | null {
  const question = QUESTIONS[id];
  if (question.kind !== "choice") return null;
  const choice = (question.choices ?? []).find(
    (c) => c.id.toLowerCase() === value.trim().toLowerCase(),
  );
  if (!choice) return null;
  // Match the words people would actually write ("has restriction").
  return choice.id.replace(/_/g, " ");
}

export function foreignSurveySecrets(
  people: { id: string; display_name: string; survey_json?: unknown }[],
  senderId: string,
): { name: string; secrets: string[]; enums: EnumSecret[] }[] {
  return people
    .filter((person) => person.id !== senderId)
    .map((person) => {
      const answers = (person.survey_json ?? {}) as SurveyAnswers;
      // secrets: real free text (free-text answers, or raw text left in a
      // choice answer by older rows). enums: shared option values, which only
      // count with the person's name and the question's topic.
      const secrets: string[] = [];
      const enums: EnumSecret[] = [];
      for (const id of PRIVATE_SURVEY_IDS) {
        const value = answerValue(answers, id)?.trim();
        if (!value) continue;
        const enumValue = enumValueOf(id, value);
        if (enumValue) {
          const topic = ENUM_TOPIC_RE[id];
          if (topic) enums.push({ value: enumValue, topic });
          continue;
        }
        if (value.length < 3 || TRIVIAL_ANSWER_RE.test(value)) continue;
        secrets.push(value);
      }
      return { name: person.display_name, secrets, enums };
    });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsPhrase(text: string, phrase: string): boolean {
  const words = phrase.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  if (!words) return false;
  // Word boundaries that also work for phrases starting or ending in a symbol.
  return new RegExp(`(^|[^\\p{L}\\p{N}])${words}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

export function leaksForeignSurvey(
  text: string,
  others: { name: string; secrets: string[]; enums?: EnumSecret[] }[],
): boolean {
  const budgetTalk = /\bbudget\b|\ballerg|\bdiet|\bsurvey\b/i.test(text);
  for (const person of others) {
    const named = containsPhrase(text, person.name);
    for (const secret of person.secrets) {
      if (!containsPhrase(text, secret)) continue;
      if (named || budgetTalk) return true;
    }
    if (!named) continue;
    for (const secret of person.enums ?? []) {
      if (secret.topic.test(text) && containsPhrase(text, secret.value)) return true;
    }
  }
  return false;
}

export type ConversationTurn = {
  text: string;
  calls: { id?: string; name: string; args: Record<string, unknown> }[];
};

export function finalizeConversationReply(opts: {
  text: string;
  others: { name: string; secrets: string[]; enums?: EnumSecret[] }[];
  policy: OffTopicPolicy;
  redirect: string;
  fallback: string;
  privacyLine: string;
}): string {
  let reply = opts.text.trim() || opts.fallback;
  if (leaksForeignSurvey(reply, opts.others)) {
    return opts.privacyLine;
  }
  reply = shapeOffTopicReply(reply, opts.policy, opts.redirect);
  return reply.trim() || opts.fallback;
}

export async function runToolLoop(opts: {
  maxIterations?: number;
  generate: (input: {
    iteration: number;
    forceReply: boolean;
  }) => Promise<ConversationTurn>;
  execute: (
    call: ConversationTurn["calls"][number],
  ) => Promise<{ result: Record<string, unknown>; sent: boolean }>;
}): Promise<{
  text: string;
  toolNames: string[];
  sentByTool: boolean;
}> {
  const max = opts.maxIterations ?? CONVERSATION_MAX_TOOL_ITERS;
  const toolNames: string[] = [];
  let sentByTool = false;
  let text = "";
  for (let iteration = 0; iteration < max; iteration += 1) {
    const turn = await opts.generate({ iteration, forceReply: false });
    if (turn.calls.length === 0) {
      return { text: turn.text.trim(), toolNames, sentByTool };
    }
    for (const call of turn.calls) {
      toolNames.push(call.name);
      const executed = await opts.execute(call);
      if (executed.sent) sentByTool = true;
    }
  }
  const last = await opts.generate({ iteration: max, forceReply: true });
  text = last.text.trim();
  return { text, toolNames, sentByTool };
}
