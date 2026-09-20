// The live trip dashboard's shareable link. Mirrors wrappedUrlFor in
// lib/handlers/trip-lifecycle.ts (same origin-resolution rule: APP_URL, else
// the Vercel production URL), kept separate here since /live is its own
// experience, not part of the trip lifecycle module. The trip id is the
// whole "token", the same convention /wrapped/[tripId] already uses, and
// loadLiveTrip only ever answers for a trip that is currently active, so the
// link stops meaning anything once the trip ends.
export function liveUrlFor(tripId: string): string | null {
  const origin = (
    process.env.APP_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null)
  )?.replace(/\/+$/, "");
  return origin ? `${origin}/live/${tripId}` : null;
}
