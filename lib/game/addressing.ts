export type AddressingInput = {
  text: string;
  isDm: boolean;
  // TODO: plan does not define what an "open task context" is or how it is tracked.
  inOpenTaskContext: boolean;
  wakeKeyword?: string;
};

// TODO: plan shows two-character codes like A1/A2; it does not specify the full alphabet, case, or word boundaries.
const TASK_CODE = /\b[A-Za-z][0-9]\b/;

export function shouldRespond(input: AddressingInput): boolean {
  if (input.isDm) return true;
  if (input.inOpenTaskContext) return true;
  if (TASK_CODE.test(input.text)) return true;

  const keyword = (
    input.wakeKeyword ??
    process.env.JAPLAN_WAKE_KEYWORD ??
    "japlan"
  ).toLowerCase();
  if (keyword && input.text.toLowerCase().includes(keyword)) return true;

  return false;
}
