import { notFound } from "next/navigation";
import { WrappedExperience } from "../wrapped-experience";
import { loadWrapped } from "@/lib/wrapped/load";
import type { WrappedSlide } from "../data";

export const dynamic = "force-dynamic";

export default async function LiveWrappedPage({ params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params;
  const data = await loadWrapped(tripId);
  if (!data) notFound();
  const slides: WrappedSlide[] = [
    { type: "intro" }, { type: "stats" }, { type: "places" }, { type: "quests" }, { type: "leaderboard" },
    ...data.people.map((person, index) => ({ type: "person" as const, person, layout: (index % 3) as 0 | 1 | 2 })),
    { type: "photos" }, { type: "finale" },
  ];
  return <WrappedExperience data={{ ...data, slides }} />;
}
