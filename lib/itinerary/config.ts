export type TripConfig = {
  destination: string;
  startDate: string;
  endDate: string;
  groupSize: number;
  budget: "low" | "medium" | "high";
  foodPreferences: { dietaryRestrictions: string[]; allergies: string[] };
  accessibilityPreferences: {
    mobilityRestrictions: string[];
    physicalLimitations: string[];
  };
};

export const developmentTripConfig: TripConfig = {
  destination: "Tokyo, Japan",
  startDate: "2026-10-17",
  endDate: "2026-10-20",
  groupSize: 6,
  budget: "medium",
  foodPreferences: {
    dietaryRestrictions: ["vegetarian"],
    allergies: ["peanuts"],
  },
  accessibilityPreferences: {
    mobilityRestrictions: ["Avoid activities requiring extensive walking"],
    physicalLimitations: ["Step-free access preferred"],
  },
};

export function inclusiveTripDates(
  config: Pick<TripConfig, "startDate" | "endDate">,
): string[] {
  const dates: string[] = [];
  const current = new Date(`${config.startDate}T12:00:00Z`);
  const end = new Date(`${config.endDate}T12:00:00Z`);
  if (
    Number.isNaN(current.valueOf()) ||
    Number.isNaN(end.valueOf()) ||
    current > end
  ) {
    throw new Error("invalid development trip dates");
  }
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

export function researchMode(): "real" | "mock" {
  const mode = process.env.ITINERARY_RESEARCH_MODE ?? "real";
  if (mode !== "real" && mode !== "mock")
    throw new Error("ITINERARY_RESEARCH_MODE must be real or mock");
  if (mode === "mock" && process.env.NODE_ENV === "production") {
    throw new Error("mock itinerary research is not permitted in production");
  }
  return mode;
}
