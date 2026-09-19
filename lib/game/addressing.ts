export type AddressingInput = {
  text: string;
  isDm: boolean;
  // Photo within 60s of a task code, set by dispatch from recentCodeFor.
  openTaskContext?: boolean;
  wakeKeyword?: string;
  // The group is in a conversation with the bot (lib/handlers/engagement):
  // follow-ups need no "japlan".
  engaged?: boolean;
};

export type AddressReason =
  | "dm"
  | "open_task_context"
  | "task_code"
  // Code-shaped token in a short unaddressed group message. Tentative: the
  // claim handler stays silent unless it resolves to the sender's own task.
  | "loose_task_code"
  | "wake_keyword"
  | "engaged"
  | "help"
  | "silent";

export type AddressIntent = "help" | "none";

export type AddressDecision = {
  respond: boolean;
  reason: AddressReason;
  intent: AddressIntent;
  bypassRateLimit: boolean;
};

const TASK_CODE_BODY = "[A-Za-z]\\d{1,2}";
const WHOLE_MESSAGE_CODE_RE = new RegExp(`^\\s*(${TASK_CODE_BODY})\\s*[.!?]*\\s*$`);
const CODE_TOKEN_RE = new RegExp(`^${TASK_CODE_BODY}$`);
// "done with A1" is a claim; a long message with a code-shaped token is chat.
export const LOOSE_CODE_MAX_WORDS = 6;
const FILLER_PREFIX = /^(hey|hi|ok|okay|please|um+|uh|so)[, ]+/i;
const HELP_BODY_RE = [
  /^help(?:\s+me)?(?:\s+please)?\??$/i,
  /^commands?\??$/i,
  /^cmds?\??$/i,
  /^menu\??$/i,
  /^options?\??$/i,
  /^what do you do\??$/i,
  /^how does (this|it) work\??$/i,
  /^how do (i|you|we)\b/i,
  /^what can you do\??$/i,
  /^(what is|what's) (this|japlan)\??$/i,
  /^\?$/,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function defaultWakeKeyword(): string {
  return (process.env.JAPLAN_WAKE_KEYWORD ?? "japlan").trim();
}

function wakeKeywordOf(input: AddressingInput): string {
  return input.wakeKeyword?.trim() ?? defaultWakeKeyword();
}

export function wakeKeywordRe(keyword: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "i");
}

export type TaskCodeMatch = {
  code: string;
  // strict: the whole message, or anywhere in a message with the keyword.
  // loose: a standalone token in a short message with no keyword.
  strict: boolean;
};

function normalizeCode(raw: string): string {
  return `${raw[0].toUpperCase()}${raw.slice(1)}`;
}

function firstCodeToken(text: string): string | null {
  for (const word of text.split(/\s+/)) {
    const token = word.replace(/^[^\w]+|[^\w]+$/g, "");
    if (CODE_TOKEN_RE.test(token)) return token;
  }
  return null;
}

export function findTaskCode(
  text: string,
  keyword: string = defaultWakeKeyword(),
): TaskCodeMatch | null {
  const whole = text.match(WHOLE_MESSAGE_CODE_RE)?.[1];
  if (whole) return { code: normalizeCode(whole), strict: true };

  if (keyword && wakeKeywordRe(keyword).test(text)) {
    const afterKeyword = new RegExp(
      `\\b${escapeRegExp(keyword)}\\b[\\s,:;-]*(${TASK_CODE_BODY})\\b`,
      "i",
    );
    const raw = text.match(afterKeyword)?.[1] ?? firstCodeToken(text);
    return raw ? { code: normalizeCode(raw), strict: true } : null;
  }

  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length > LOOSE_CODE_MAX_WORDS) return null;
  const raw = firstCodeToken(text);
  return raw ? { code: normalizeCode(raw), strict: false } : null;
}

export function extractTaskCode(
  text: string,
  keyword: string = defaultWakeKeyword(),
): string | null {
  return findTaskCode(text, keyword)?.code ?? null;
}

export function stripWakeKeyword(text: string, keyword: string): string {
  if (!keyword) return text.trim();
  return text.replace(wakeKeywordRe(keyword), " ").replace(/\s+/g, " ").trim();
}

function helpBody(text: string, keyword: string, hasKeyword: boolean): string {
  let body = hasKeyword ? stripWakeKeyword(text, keyword) : text;
  body = body.replace(/[!.]+$/g, "").replace(/^[,:\-]+/, "").trim();
  body = body.replace(FILLER_PREFIX, "").trim();
  return body.replace(/\s+/g, " ");
}

export function isHelpIntent(input: AddressingInput): boolean {
  const keyword = wakeKeywordOf(input);
  const hasKeyword = Boolean(keyword && wakeKeywordRe(keyword).test(input.text));
  if (!input.isDm && !hasKeyword) return false;
  const body = helpBody(input.text, keyword, hasKeyword);
  if (!body) return false;
  return HELP_BODY_RE.some((re) => re.test(body));
}

export function evaluateAddress(input: AddressingInput): AddressDecision {
  if (isHelpIntent(input)) {
    return {
      respond: true,
      reason: "help",
      intent: "help",
      bypassRateLimit: true,
    };
  }
  if (input.isDm) {
    return {
      respond: true,
      reason: "dm",
      intent: "none",
      bypassRateLimit: false,
    };
  }
  if (input.openTaskContext) {
    return {
      respond: true,
      reason: "open_task_context",
      intent: "none",
      bypassRateLimit: false,
    };
  }
  const keyword = wakeKeywordOf(input);
  const code = findTaskCode(input.text, keyword);
  if (code?.strict) {
    return {
      respond: true,
      reason: "task_code",
      intent: "none",
      bypassRateLimit: false,
    };
  }

  if (keyword && wakeKeywordRe(keyword).test(input.text)) {
    return {
      respond: true,
      reason: "wake_keyword",
      intent: "none",
      bypassRateLimit: false,
    };
  }

  if (input.engaged) {
    return {
      respond: true,
      reason: "engaged",
      intent: "none",
      bypassRateLimit: false,
    };
  }

  if (code) {
    return {
      respond: true,
      reason: "loose_task_code",
      intent: "none",
      bypassRateLimit: false,
    };
  }

  return {
    respond: false,
    reason: "silent",
    intent: "none",
    bypassRateLimit: false,
  };
}

export function shouldRespond(input: AddressingInput): boolean {
  return evaluateAddress(input).respond;
}

export function allowsOutbound(opts: {
  kind: "help" | "ambient";
  repliesInWindow: number;
  cap: number;
}): boolean {
  if (opts.kind === "help") return true;
  return opts.repliesInWindow < opts.cap;
}
