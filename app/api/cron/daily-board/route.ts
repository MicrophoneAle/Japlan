import { runDailyBoards } from "@/lib/handlers/daily-board";
import { sweepStalledEvents } from "@/lib/handlers/event-sweep";
import { completeExpiredTrips } from "@/lib/handlers/trip-expiry";

export const maxDuration = 60;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return new Response("unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";
  const tripId = url.searchParams.get("trip_id") ?? undefined;

  try {
    const result = await runDailyBoards({ force, tripId });
    const expiredTrips = await completeExpiredTrips({ tripId });
    await sweepStalledEvents({ force: true }).catch((err) => console.error("[japlan.cron] sweep failed", err));
    return Response.json({ ok: true, ...result, expiredTrips });
  } catch (err) {
    console.error("[japlan.cron.daily-board]", err);
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
