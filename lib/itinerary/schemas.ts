import { z } from "zod";

export const CandidateActivitySchema = z.object({
  id: z.string().min(1), name: z.string().min(1), category: z.string().min(1), description: z.string().min(1),
  destination: z.string().min(1), address: z.string().nullable(), estimatedDurationMinutes: z.number().int().positive().nullable(),
  estimatedCost: z.string().nullable(), priceLevel: z.enum(["low", "medium", "high", "unknown"]), openingHours: z.string().nullable(),
  accessibilityNotes: z.string().nullable(), dietaryNotes: z.string().nullable(), reservationRequired: z.boolean().nullable(),
  sourceUrls: z.array(z.string().url()).min(1), unverifiedFields: z.array(z.string()), translatedFromSource: z.boolean(),
});
export type CandidateActivity = z.infer<typeof CandidateActivitySchema>;

export const ResearchActionSchema = z.object({ at: z.string(), type: z.enum(["search", "visit", "extract", "error"]), detail: z.string(), url: z.string().url().nullable() });
export type ResearchAction = z.infer<typeof ResearchActionSchema>;

export const ResearchSnapshotSchema = z.object({ mode: z.enum(["real", "mock"]), status: z.enum(["researching", "researched", "failed"]), sessionId: z.string().nullable(), dashboardUrl: z.string().url().nullable(), visitedUrls: z.array(z.string().url()), actions: z.array(ResearchActionSchema), candidates: z.array(CandidateActivitySchema), error: z.string().nullable() });
export type ResearchSnapshot = z.infer<typeof ResearchSnapshotSchema>;

export const ItinerarySelectionSchema = z.object({ candidateActivityId: z.string(), startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), notes: z.string().max(500) });
export const DiningPlanSchema = z.object({ candidateActivityId: z.string().nullable(), startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), notes: z.string().min(1).max(500) });
export const ItineraryModelSchema = z.object({ days: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), dayNumber: z.number().int().positive(), summary: z.string().min(1), activities: z.array(ItinerarySelectionSchema).min(1), diningPlan: DiningPlanSchema })) });
export type ItineraryModel = z.infer<typeof ItineraryModelSchema>;

export type DraftItinerary = { destination: string; startDate: string; endDate: string; status: "draft"; days: Array<{ date: string; dayNumber: number; summary: string; activities: Array<CandidateActivity & { startTime: string; endTime: string; notes: string; verificationStatus: "unvalidated" }>; diningPlan: { candidate: CandidateActivity | null; startTime: string; endTime: string; notes: string; verificationStatus: "unvalidated" } }> };
