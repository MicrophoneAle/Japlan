export type AddressingInput = {
  text: string;
  isDm: boolean;
  // TODO: nothing sets this yet; open task-context tracking is later.
  openTaskContext?: boolean;
  wakeKeyword?: string;
};

export type AddressReason =
  | "dm"
  | "open_task_context"
  | "task_code"
  | "wake_keyword"
  | "silent";

export type AddressDecision = {
  respond: boolean;
  reason: AddressReason;
};

const TASK_CODE = /\b[A-Za-z]\d{1,2}\b/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wakeKeywordRe(keyword: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "i");
}

export function evaluateAddress(input: AddressingInput): AddressDecision {
  if (input.isDm) return { respond: true, reason: "dm" };
  if (input.openTaskContext) {
    return { respond: true, reason: "open_task_context" };
  }
  if (TASK_CODE.test(input.text)) {
    return { respond: true, reason: "task_code" };
  }

  const keyword = (
    input.wakeKeyword ??
    process.env.JAPLAN_WAKE_KEYWORD ??
    "japlan"
  ).trim();
  if (keyword && wakeKeywordRe(keyword).test(input.text)) {
    return { respond: true, reason: "wake_keyword" };
  }

  return { respond: false, reason: "silent" };
}

export function shouldRespond(input: AddressingInput): boolean {
  return evaluateAddress(input).respond;
}
