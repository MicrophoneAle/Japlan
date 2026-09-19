import { NextResponse } from "next/server";
import { generateItineraryForDevelopmentTrip } from "@/lib/itinerary/controller";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try { const body = await request.json() as { tripId?: unknown }; if (typeof body.tripId !== "string") return NextResponse.json({ error: "tripId is required" }, { status: 400 }); const result = await generateItineraryForDevelopmentTrip(body.tripId); return NextResponse.json(result); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "generation failed" }, { status: 500 }); }
}
