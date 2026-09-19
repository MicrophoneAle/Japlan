import { NextResponse } from "next/server";
import { generateDevelopmentItinerary } from "@/lib/itinerary/controller";

export const runtime = "nodejs";
export async function POST() {
  try { return NextResponse.json(await generateDevelopmentItinerary()); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "generation failed" }, { status: 500 }); }
}
