import { defaultWakeKeyword, stripWakeKeyword, wakeKeywordRe } from "./addressing";
import { parseBoardTime } from "./board-schedule";

export type TripCommand = "end_trip" | "end_trip_confirm" | "new_trip" | "setup" | "settings" | "resurvey" | "profile";

const COMMANDS: [TripCommand, RegExp][] = [
  ["end_trip_confirm", /^end (the )?trip,? confirm(ed)?$/],
  ["end_trip", /^end (the |this )?trip$/],
  ["new_trip", /^(new|start a new|start another|another) trip$/],
  ["setup", /^(setup|set up|trip setup|change setup)$/],
  // Anyone's own answers: see them all, or go through the questions again.
  ["settings", /^(my )?(settings|preferences|prefs|profile)$/],
  ["resurvey", /^(resurvey|re-?survey|redo (my )?survey|survey again|retake (the )?survey)$/],
  // "what do u know about me", "what can you tell me about myself", "what can
  // you tell me based on my survey answers" (all live, 2026-09-19).
  [
    "profile",
    /^(?:(?:hi|hey|yo|ok|okay|so|and)\s+)?(?:(?:what|wat|wht)\s+(?:do|did|can|does)\s+(?:you|u|ya)\s+(?:know|tell me|remember|have)\s+(?:about|on)\s+(?:me|myself)(?:\s.*)?|what can (?:you|u) tell me (?:about myself|based on my (?:survey|answers|survey answers))|my profile|show (?:me )?my profile|whats my profile|who am i(?: to you)?)$/,
  ],
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

const TEAM_NAME_TRIGGERS = [
  // "we're team sigmas" only: a bare "we're ..." is ordinary talk ("we're
  // splitting up", "we're back together") and belongs to the conversation.
  /^(?:we'?re|we are)\s+(team\s+.*)$/i,
  /^call us\s+(.*)$/i,
  /^name us\s+(.*)$/i,
  /^our team(?:'s| is)\s+(.*)$/i,
  /^team name(?:'s| is)\s+(.*)$/i,
];

// "japlan we're team sigmas" / "japlan call us the chuds" / "japlan our
// team is sigmas". null: not this command. { name: null }: the command, but
// nothing readable followed it.
export function detectTeamNameCommand(
  text: string,
  keyword: string = defaultWakeKeyword(),
): { name: string | null } | null {
  if (!keyword || !wakeKeywordRe(keyword).test(text)) return null;
  const body = stripWakeKeyword(text, keyword)
    .replace(/^[,:\-\s]+/, "")
    .replace(/[.!]+$/, "")
    .trim();
  for (const re of TEAM_NAME_TRIGGERS) {
    const m = body.match(re);
    if (m) {
      const name = m[1].trim();
      return { name: name.length > 0 ? name : null };
    }
  }
  return null;
}

// "lb", "leader", "leaderboard", "standings", "scores", "rankings", with or
// without the wake keyword (a bare DM already counts as addressed) and a
// small set of filler prefixes ("what's the", "show me"). Deliberately a
// bare-command match, not a substring search: "leader" or "score" appearing
// inside an ordinary sentence should not hijack it.
const STANDINGS_WORDS = "(?:lb|leaders?|leaderboards?|standings?|scores?|rankings?)";
const STANDINGS_RE = new RegExp(
  `^(?:(?:what'?s|whats|show me|send|give me|check|see)\\s+)*(?:the\\s+)?${STANDINGS_WORDS}[?.!]*$`,
  "i",
);

export function isStandingsRequest(
  text: string,
  keyword: string = defaultWakeKeyword(),
): boolean {
  const body = stripWakeKeyword(text, keyword)
    .replace(/^[,:\-\s]+/, "")
    .trim();
  return STANDINGS_RE.test(body);
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
