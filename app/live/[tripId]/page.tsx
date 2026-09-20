import { notFound } from "next/navigation";
import { loadLiveTrip } from "@/lib/live/load";
import { LiveExperience } from "./live-experience";

export const dynamic = "force-dynamic";

export default async function LiveTripPage({
  params,
  searchParams,
}: {
  params: Promise<{ tripId: string }>;
  searchParams: Promise<{ p?: string }>;
}) {
  const { tripId } = await params;
  const { p: personId } = await searchParams;
  const data = await loadLiveTrip(tripId);
  if (!data) notFound();
  return <LiveExperience initialData={data} personId={personId ?? null} />;
}
