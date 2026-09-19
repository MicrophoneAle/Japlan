// Trip-local calendar math. Pure: no network, no server-timezone assumptions.
// An invalid or missing timezone falls back to UTC.

function safeZone(timezone: string | null | undefined): string {
  const zone = timezone || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

export function localDateString(now: Date, timezone: string | null | undefined): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: safeZone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function localHour(now: Date, timezone: string | null | undefined): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: safeZone(timezone),
      hour: "numeric",
      hourCycle: "h23",
    }).format(now),
  );
}

// Milliseconds the zone is ahead of UTC at this instant (Tokyo: +9h).
function zoneOffsetMs(instant: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

// A real IANA zone the runtime knows ("Asia/Tokyo"), not "JST" or "UTC+9".
export function isValidTimeZone(zone: string | null | undefined): zone is string {
  if (!zone || !/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function zoneOffsetHours(zone: string, at: Date = new Date()): number {
  return zoneOffsetMs(at, safeZone(zone)) / 3_600_000;
}

// Sanity check a derived zone against the place's longitude: solar time is
// lng/15 hours from UTC, and real zones sit within a few hours of it (China
// and western Spain are the far cases). Catches a model naming the wrong
// continent; says nothing when the longitude is unknown.
export function zonePlausibleForLongitude(
  zone: string,
  lng: number | null,
  at: Date = new Date(),
): boolean {
  if (lng === null) return true;
  return Math.abs(zoneOffsetHours(zone, at) - lng / 15) <= 3.5;
}

// The UTC instant of a wall-clock time in a zone. Two passes settle DST edges.
export function zonedTimeToUtc(
  date: string,
  time: string,
  timezone: string | null | undefined,
): Date {
  const zone = safeZone(timezone);
  const naive = Date.parse(`${date}T${time}Z`);
  let guess = naive - zoneOffsetMs(new Date(naive), zone);
  guess = naive - zoneOffsetMs(new Date(guess), zone);
  return new Date(guess);
}

// Last second of a local calendar day, as a real instant. On Vercel the
// server runs in UTC, so building 23:59:59 without the zone was 9h late in Tokyo.
export function endOfLocalDay(date: string, timezone: string | null | undefined): Date {
  return zonedTimeToUtc(date, "23:59:59", timezone);
}

export function endOfLocalDayContaining(
  instant: Date,
  timezone: string | null | undefined,
): Date {
  return endOfLocalDay(localDateString(instant, timezone), timezone);
}
