import { NextResponse } from "next/server";
import { loadLiveTrip } from "@/lib/live/load";

// Polled by the client page (app/live/[tripId]/live-experience.tsx) so new
// claims/tasks/teams show up without a full reload. Read-only: the game
// backend stays authoritative, this only reflects it.
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params;
  const data = await loadLiveTrip(tripId);
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(data);
}
