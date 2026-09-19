import { defaultWakeKeyword, stripWakeKeyword, wakeKeywordRe } from "./addressing";
import { parseBoardTime } from "./board-schedule";

export type TripCommand = "end_trip" | "end_trip_confirm" | "new_trip" | "setup";

const COMMANDS: [TripCommand, RegExp][] = [
  ["end_trip_confirm", /^end (the )?trip,? confirm(ed)?$/],
  ["end_trip", /^end (the |this )?trip$/],
  ["new_trip", /^(new|start a new|start another|another) trip$/],
  ["setup", /^(setup|set up|trip setup|change setup)$/],
];

// "japlan board time 7am" / "japlan board time 10:30".
// null: not this command. { time: null }: the command, but an unreadable time.
export function detectBoardTimeCommand(
  text: string,
  keyword: string = defaultWakeKeyword(),
): { time: string | null } | null {
  if (!keyword || !wakeKeywordRe(keyword).test(text)) return null;
  const body = stripWakeKeyword(text, keyword).toLowerCase().replace(/^[,:\-\s]+/, "").trim();
  const m = body.match(/^(?:set\s+)?(?:the\s+)?board\s*time(?:\s+(?:to|at))?\s*(.*?)[.!]*$/);
  if (!m) return null;
  return { time: parseBoardTime(m[1]) };
}

// Lifecycle commands always need the keyword, in groups and DMs alike, so
// "end trip" in ordinary chat or a survey answer can never end a trip.
export function detectTripCommand(
  text: string,
  keyword: string = defaultWakeKeyword(),
): TripCommand | null {
  if (!keyword || !wakeKeywordRe(keyword).test(text)) return null;
  const body = stripWakeKeyword(text, keyword)
    .toLowerCase()
    .replace(/^[,:\-\s]+/, "")
    .replace(/['".!?]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  for (const [command, re] of COMMANDS) {
    if (re.test(body)) return command;
  }
  return null;
}
