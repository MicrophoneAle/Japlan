// Links people drop in the chat: finding them, working out what kind they are,
// and reading a Google Maps URL without asking anyone anything.
//
// Pure: no network. The handlers do the fetching.
//
// Which kind matters because each one is reached a different way, measured
// against the live sites before this was built:
//   tiktok    -> the keyless oEmbed endpoint. A headless fetch is BLOCKED
//                (2/2 attempts returned TikTok's bot page), but oEmbed hands
//                over the whole caption in about 200ms.
//   instagram -> browserbase.fetch(). The logged-out page still carries the
//                caption, hashtags and often a street address underneath the
//                "Log In" chrome. A plain crawler-UA fetch gets NO og tags.
//   maps      -> parsed here, or one redirect hop for a short link. No browser.
//   article   -> browserbase.fetch(), same as the holiday scraper.

export type LinkKind = "tiktok" | "instagram" | "maps" | "article";

// Deliberately loose: iMessage sends bare domains and trailing punctuation.
const URL_PATTERN = /\bhttps?:\/\/[^\s<>()[\]{}"']+/gi;

// Trailing punctuation a person typed, not part of the link.
function trimTrailing(url: string): string {
  return url.replace(/[.,;:!?]+$/, "").replace(/\)+$/, "");
}

export function findUrls(text: string): string[] {
  const found = (text.match(URL_PATTERN) ?? []).map(trimTrailing).filter(Boolean);
  return [...new Set(found)];
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function classifyUrl(url: string): LinkKind | null {
  const host = hostOf(url);
  if (!host) return null;
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return "tiktok";
  if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram";
  if (
    host === "google.com" ||
    host.endsWith(".google.com") ||
    host === "maps.app.goo.gl" ||
    host === "goo.gl"
  ) {
    return url.includes("/maps") || host === "maps.app.goo.gl" ? "maps" : "article";
  }
  return "article";
}

// A short link has to be followed before it says anything. One redirect hop,
// no browser.
export function isShortMapsLink(url: string): boolean {
  const host = hostOf(url);
  return host === "maps.app.goo.gl" || host === "goo.gl";
}

export type MapsPlace = {
  name: string | null;
  lat: number | null;
  lng: number | null;
};

// Everything a Google Maps URL says on its face:
//   /maps/place/Ramen+Break+Beats/@35.63,139.69,17z   -> name and coords
//   /maps/search/?api=1&query=35.63,139.69            -> coords
//   ?q=Tokyo+Tower                                    -> name
// Null fields where the URL does not say. Never guesses.
export function parseGoogleMapsUrl(url: string): MapsPlace | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const out: MapsPlace = { name: null, lat: null, lng: null };

  const placeMatch = /\/maps\/place\/([^/@?]+)/.exec(parsed.pathname);
  if (placeMatch) out.name = decodePlaceSegment(placeMatch[1]);

  // @lat,lng,zoom anywhere in the path.
  const at = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(parsed.pathname + parsed.search);
  if (at) {
    out.lat = Number(at[1]);
    out.lng = Number(at[2]);
  }

  const query = parsed.searchParams.get("query") ?? parsed.searchParams.get("q");
  if (query) {
    const coords = /^(-?\d+\.\d+),\s*(-?\d+\.\d+)$/.exec(query.trim());
    if (coords) {
      out.lat ??= Number(coords[1]);
      out.lng ??= Number(coords[2]);
    } else if (!out.name) {
      out.name = decodePlaceSegment(query);
    }
  }

  if (!out.name && out.lat === null) return null;
  if (out.lat !== null && (!Number.isFinite(out.lat) || Math.abs(out.lat) > 90)) {
    out.lat = null;
    out.lng = null;
  }
  if (out.lng !== null && (!Number.isFinite(out.lng) || Math.abs(out.lng) > 180)) {
    out.lat = null;
    out.lng = null;
  }
  return out;
}

function decodePlaceSegment(segment: string): string | null {
  try {
    const name = decodeURIComponent(segment.replace(/\+/g, " ")).trim();
    // "35.6,139.7" is a coordinate pair, not a name.
    if (/^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(name)) return null;
    return name || null;
  } catch {
    return segment.replace(/\+/g, " ").trim() || null;
  }
}

// TikTok's oEmbed wants the canonical video URL; the share links people paste
// carry tracking junk that it handles, but stripping it keeps the log clean.
export function cleanTrackingParams(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(_t|_r|utm_|igsh|igshid|si|fbclid|share_)/i.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}
