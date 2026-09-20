// Reading a link, by whatever route actually works for it. Adapter only: no
// game logic, no database.
//
// NO SESSIONS. Nothing here calls browserbase.launch() or Stagehand. Every
// route is a stateless request, which is why there is no session to leak, no
// concurrency limit to exhaust and nothing to close in a finally. Measured
// against the live sites (2026-10-04):
//
//   tiktok    oEmbed, keyless GET, ~200ms, full caption including venue.
//             browserbase.fetch is BLOCKED: 2/2 returned TikTok's bot page
//             ("Oops! Something went wrong", 122 chars). Do not retry it
//             through a browser; it is deterministic, not a rate limit.
//   instagram browserbase.fetch, ~1.5s, ~23k chars. The logged-out page keeps
//             the caption, hashtags and often a street address under the
//             "Log In" chrome. A crawler-UA fetch gets NO og tags at all.
//             1 of 4 returned 0 chars: that is a normal miss, not an error.
//   article   browserbase.fetch, ~3s, full body.
//   maps      parsed from the URL; a short link needs one redirect hop.
//
// Nothing here throws. Every route answers with a typed outcome.

import { cleanTrackingParams, isShortMapsLink, type LinkKind } from "@/lib/game/urls";

const OEMBED_TIMEOUT_MS = 6_000;
const FETCH_TIMEOUT_MS = 12_000;
const REDIRECT_TIMEOUT_MS = 6_000;
const MAX_TEXT_CHARS = 12_000;

export type ReadOutcome =
  | { ok: true; text: string; via: string }
  | { ok: false; reason: "blocked" | "empty_page" | "no_api_key" | "timeout" | "failed"; via: string };

function step(step: string, fields: Record<string, unknown> = {}): void {
  console.info("[japlan.social] step", { step, ...fields });
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// TikTok's public oEmbed. No key, no account, no browser. `title` is the whole
// caption, which is where the venue name lives.
export async function readTikTok(url: string): Promise<ReadOutcome> {
  const target = `https://www.tiktok.com/oembed?url=${encodeURIComponent(cleanTrackingParams(url))}`;
  try {
    const res = await withTimeout(
      fetch(target, { headers: { accept: "application/json" } }),
      OEMBED_TIMEOUT_MS,
      "tiktok.oembed",
    );
    if (!res.ok) {
      step("tiktok.not_ok", { status: res.status });
      return { ok: false, reason: res.status === 403 ? "blocked" : "failed", via: "oembed" };
    }
    const json = (await res.json()) as { title?: unknown; author_name?: unknown };
    const caption = typeof json.title === "string" ? json.title.trim() : "";
    const author = typeof json.author_name === "string" ? json.author_name.trim() : "";
    if (!caption) return { ok: false, reason: "empty_page", via: "oembed" };
    return { ok: true, text: author ? `${caption}\n(posted by ${author})` : caption, via: "oembed" };
  } catch (err) {
    step("tiktok.failed", { error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: "timeout", via: "oembed" };
  }
}

// Instagram and ordinary articles. browserbase.fetch is a stateless API call,
// NOT a session: no launch(), nothing to close.
export async function readPage(url: string): Promise<ReadOutcome> {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) {
    step("page.skip", { reason: "no_api_key" });
    return { ok: false, reason: "no_api_key", via: "browserbase.fetch" };
  }
  try {
    const { browserbase } = await import("@browserbasehq/stagehand");
    const page = await withTimeout(
      browserbase.fetch({ apiKey, url, format: "markdown" }),
      FETCH_TIMEOUT_MS,
      "browserbase.fetch",
    );
    const content = typeof page.content === "string" ? page.content : "";
    // TikTok's block page is ~120 chars; a real read is thousands. A short
    // body means we got a wall, not a post.
    if (content.trim().length < 400) {
      step("page.thin", { url, chars: content.length });
      return {
        ok: false,
        reason: /something went wrong|error code|are you a robot/i.test(content)
          ? "blocked"
          : "empty_page",
        via: "browserbase.fetch",
      };
    }
    return { ok: true, text: content.slice(0, MAX_TEXT_CHARS), via: "browserbase.fetch" };
  } catch (err) {
    step("page.failed", { url, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: "failed", via: "browserbase.fetch" };
  }
}

// A short Maps link says nothing until it is followed. One hop, no browser,
// and the destination URL is the whole answer.
export async function followShortLink(url: string): Promise<string | null> {
  if (!isShortMapsLink(url)) return url;
  try {
    const res = await withTimeout(
      fetch(url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (compatible; japlan/1.0)" } }),
      REDIRECT_TIMEOUT_MS,
      "maps.redirect",
    );
    const final = res.url && res.url !== url ? res.url : null;
    step("maps.followed", { from: url, to: final });
    return final;
  } catch (err) {
    step("maps.follow_failed", { url, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export function readerFor(kind: LinkKind): (url: string) => Promise<ReadOutcome> {
  return kind === "tiktok" ? readTikTok : readPage;
}
