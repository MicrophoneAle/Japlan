export type AddressingInput = {
  text: string;
  isDm: boolean;
  // Photo within 60s of a task code, set by dispatch from recentCodeFor.
  openTaskContext?: boolean;
  wakeKeyword?: string;
};

export type AddressReason =
  | "dm"
  | "open_task_context"
  | "task_code"
  | "wake_keyword"
  | "help"
  | "silent";

export type AddressIntent = "help" | "none";

export type AddressDecision = {
  respond: boolean;
  reason: AddressReason;
  intent: AddressIntent;
  bypassRateLimit: boolean;
};

const TASK_CODE = /\b[A-Za-z]\d{1,2}\b/;
const FILLER_PREFIX = /^(hey|hi|ok|okay|please|um+|uh|so)[, ]+/i;
const HELP_BODY_RE = [
  /^help(?:\s+me)?(?:\s+please)?\??$/i,
  /^commands?\??$/i,
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

function wakeKeywordOf(input: AddressingInput): string {
  return (
    input.wakeKeyword ??
    process.env.JAPLAN_WAKE_KEYWORD ??
    "japlan"
  ).trim();
}

export function wakeKeywordRe(keyword: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "i");
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
  if (TASK_CODE.test(input.text)) {
    return {
      respond: true,
      reason: "task_code",
      intent: "none",
      bypassRateLimit: false,
    };
  }

  const keyword = wakeKeywordOf(input);
  if (keyword && wakeKeywordRe(keyword).test(input.text)) {
    return {
      respond: true,
      reason: "wake_keyword",
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
