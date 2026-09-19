import { localDateString, localHour } from "./time";

// When the next board posts, mirroring runDailyBoards exactly so the bot never
// promises a board that will not come:
//  - the cron fires once a day at CRON_UTC_HOUR (vercel.json "0 23 * * *")
//  - a trip posts only if it is active, has a destination, and its local hour
//    is BOARD_LOCAL_HOUR at that moment, and today's board does not exist yet.
// So only zones at UTC+9 (Tokyo, Seoul) ever get a board on their own today.
// TODO: runDailyBoards does not check start_date, so boards also post before
// the trip starts; this mirrors that rather than the intent.

export const CRON_UTC_HOUR = 23;
export const BOARD_LOCAL_HOUR = 8;

export type NextBoard =
  | { at: Date }
  | { at: null; reason: "not_active" | "no_destination" | "timezone_unscheduled" };

export function nextScheduledBoard(opts: {
  state: string;
  destination: string | null;
  timezone: string | null;
  now: Date;
  // A board already exists for the current local day.
  todayBoardExists: boolean;
}): NextBoard {
  if (opts.state !== "active") return { at: null, reason: "not_active" };
  if (!opts.destination?.trim()) return { at: null, reason: "no_destination" };
  const zone = opts.timezone || "UTC";
  const today = localDateString(opts.now, zone);
  for (let k = 0; k < 3; k++) {
    const fire = new Date(
      Date.UTC(
        opts.now.getUTCFullYear(),
        opts.now.getUTCMonth(),
        opts.now.getUTCDate() + k,
        CRON_UTC_HOUR,
      ),
    );
    if (fire.getTime() <= opts.now.getTime()) continue;
    if (localHour(fire, zone) !== BOARD_LOCAL_HOUR) continue;
    // The cron skips a day whose board already exists.
    if (opts.todayBoardExists && localDateString(fire, zone) === today) continue;
    return { at: fire };
  }
  return { at: null, reason: "timezone_unscheduled" };
}

// "today at 8am", "tomorrow at 8am", "oct 17 at 8am", in the trip's zone.
export function describeBoardTime(at: Date, now: Date, timezone: string | null): string {
  const zone = timezone || "UTC";
  const day = localDateString(at, zone);
  const today = localDateString(now, zone);
  const tomorrow = localDateString(new Date(now.getTime() + 86_400_000), zone);
  const hour = localHour(at, zone);
  const clock = hour === 0 ? "12am" : hour < 12 ? `${hour}am` : hour === 12 ? "12pm" : `${hour - 12}pm`;
  if (day === today) return `today at ${clock}`;
  if (day === tomorrow) return `tomorrow at ${clock}`;
  const label = new Date(`${day}T00:00:00Z`)
    .toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    .toLowerCase();
  return `${label} at ${clock}`;
}

// "give me the first day plans", "what's on the board", "any tasks today?"
// A request for the board, not a claim ("did the ramen task") or chatter.
export function isBoardRequest(text: string): boolean {
  const t = text.toLowerCase();
  if (!/\b(plans?|board|tasks?|agenda|itinerary|schedule|to-?dos?)\b/.test(t)) return false;
  if (/\b(did|done|finished|completed|claimed|got)\b/.test(t)) return false;
  return /\?|\b(give|show|send|what|whats|what's|where|when|any|my|today|tomorrow|first|next|day \d+|list)\b/.test(t);
}
