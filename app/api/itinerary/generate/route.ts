import { NextResponse } from "next/server";
import { generateItineraryForDevelopmentTrip } from "@/lib/itinerary/controller";
import { resolveDevelopmentTrip } from "@/lib/itinerary/config";
import { latestGeneration } from "@/lib/itinerary/repository";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try { const body = await request.json() as { tripId?: unknown }; if (typeof body.tripId !== "string") return NextResponse.json({ error: "tripId is required" }, { status: 400 }); const result = await generateItineraryForDevelopmentTrip(body.tripId); return NextResponse.json(result); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "generation failed" }, { status: 500 }); }
}

export async function GET(request: Request) {
  try { const tripId = new URL(request.url).searchParams.get("tripId"); if (!tripId) return NextResponse.json({ error: "tripId is required" }, { status: 400 }); resolveDevelopmentTrip(tripId); return NextResponse.json(await latestGeneration(tripId)); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "could not load itinerary" }, { status: 500 }); }
}
