// Whether the bot is part of a group conversation right now. Groups do not
// say "japlan" in every message; nobody says someone's name in every
// sentence. The bot joins when addressed, or when a message is plainly about
// the game; stays while the exchange is with it; and leaves on its own,
// biased toward leaving early. The judgement calls go to the model (see
// lib/llm/gemini.ts judgeStillEngaged / judgeShouldJoin); the obvious ones
// are decided here. DMs are always addressed and never come through here.

export type EngagementState = {
  engaged: boolean;
  // "japlan chill": only a direct mention brings it back.
  stopped: boolean;
  reason: string;
  at: string;
};

export const IDLE: EngagementState = { engaged: false, stopped: false, reason: "idle", at: "" };

// A long gap since the bot last spoke ends the conversation.
export const ENGAGED_GAP_MS = 20 * 60 * 1000;
// This many messages in a row from people, without the bot, and it is
// clearly a conversation between them.
export const OTHERS_IN_A_ROW = 4;

// "japlan chill", "shut up japlan", "stop japlan", "we're good japlan",
// "japlan that's all". Needs the name: "stop" alone is chat.
const STOP_WORDS = "(?:chill|stop|shut up|shush|be quiet|quiet|pipe down|enough|go away|leave us|we'?re good|that'?s all|thanks,? we'?re good|not now|mute)";
const STOP_RE = new RegExp(
  `(?:\\bjaplan\\b[,!. ]*${STOP_WORDS}[.! ]*$)|(?:^[a-z ,']*?${STOP_WORDS}[,!. ]*\\bjaplan\\b[.!]*$)`,
  "i",
);

export function isStopCommand(text: string): boolean {
  return STOP_RE.test(text.trim().toLowerCase());
}

// Reasons to consider joining a message nobody addressed. Only a reason to
// ask the model, never enough on its own: most trip chatter is not for the
// bot.
const SIGNALS: [string, RegExp][] = [
  ["score", /\b(score|points?|standings|who'?s winning|leaderboard|winning|losing|in the lead)\b/i],
  ["plan", /\b(what'?s the plan|the plan (?:for|today|tomorrow)|today'?s (?:board|tasks?|plan)|what are we doing|what'?s on (?:today|tomorrow)|tasks? (?:today|tomorrow)|the board)\b/i],
  ["claim", /\b(?:we|i) (?:just )?(?:did|finished|got|completed|nailed|managed)\b|\bdone with\b|\bticked off\b/i],
  ["split", /\b(splitting|split up|sleeping in|you guys go ahead|go ahead without|meet (?:you|back)|regroup|back together)\b/i],
  ["suggestion", /\b(we should (?:go|do|try|hit|check)|let'?s (?:go to|do|hit|try)|i (?:want|wanna) (?:to )?(?:go|hit|try|see|do)|there'?s an? .{2,40} (?:i|we) (?:want|should|need))\b/i],
];

export function entrySignal(text: string, placeNames: string[] = []): string | null {
  for (const [name, re] of SIGNALS) if (re.test(text)) return name;
  const lower = text.toLowerCase();
  const place = placeNames.find((p) => p.length >= 4 && lower.includes(p.toLowerCase()));
  return place ? "place" : null;
}

export type TranscriptLike = { role: "user" | "bot"; at: string }[];

// The obvious reasons to stop following, before asking the model.
export function obviousDisengage(lines: TranscriptLike, now: number): string | null {
  const lastBot = [...lines].reverse().find((l) => l.role === "bot");
  if (!lastBot) return "bot_not_in_recent_chat";
  if (now - Date.parse(lastBot.at) > ENGAGED_GAP_MS) return "long_gap";
  const since = lines.length - 1 - lines.lastIndexOf(lastBot);
  if (since >= OTHERS_IN_A_ROW) return "others_talking";
  return null;
}
