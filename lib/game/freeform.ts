import type { Axes } from "./scoring";

export const FREEFORM_PHOTO_BONUS_MAX = 2;
export const FREEFORM_SOURCE = "freeform";

export type FreeformExtraction = {
  is_completed_activity: boolean;
  title: string;
  place_name: string | null;
  neighborhood: string | null;
  duration_minutes: number | null;
  lat: number | null;
  lng: number | null;
  category: string | null;
  axes: Axes;
};

export function parseFreeformExtraction(raw: string): FreeformExtraction | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const row = parsed as Record<string, unknown>;
  if (row.is_completed_activity !== true) return null;
  if (typeof row.title !== "string" || !row.title.trim()) return null;
  const axesRaw = row.axes;
  if (typeof axesRaw !== "object" || axesRaw === null) return null;
  const axesObj = axesRaw as Record<string, unknown>;
  const clamp = (value: unknown): number => {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return 1;
    return Math.min(5, Math.max(1, n));
  };
  return {
    is_completed_activity: true,
    title: row.title.trim(),
    place_name:
      typeof row.place_name === "string" && row.place_name.trim()
        ? row.place_name.trim()
        : null,
    neighborhood:
      typeof row.neighborhood === "string" && row.neighborhood.trim()
        ? row.neighborhood.trim()
        : null,
    duration_minutes:
      typeof row.duration_minutes === "number" && Number.isFinite(row.duration_minutes)
        ? row.duration_minutes
        : null,
    lat: typeof row.lat === "number" && Number.isFinite(row.lat) ? row.lat : null,
    lng: typeof row.lng === "number" && Number.isFinite(row.lng) ? row.lng : null,
    category:
      typeof row.category === "string" && row.category.trim()
        ? row.category.trim()
        : null,
    axes: {
      boldness: clamp(axesObj.boldness),
      physical: clamp(axesObj.physical),
      time: clamp(axesObj.time),
      scarcity: clamp(axesObj.scarcity),
      cultural: clamp(axesObj.cultural),
      aesthetics: clamp(axesObj.aesthetics),
    },
  };
}

export function hasFreeformClaimToday(opts: {
  tasks: { id: string; source?: string | null; day: number; participant_id?: string | null }[];
  claims: { task_id: string; participant_id: string; status: string }[];
  participantId: string;
  day: number;
}): boolean {
  const freeformIds = new Set(
    opts.tasks
      .filter(
        (task) =>
          task.source === FREEFORM_SOURCE &&
          task.day === opts.day &&
          task.participant_id === opts.participantId,
      )
      .map((task) => task.id),
  );
  return opts.claims.some(
    (claim) =>
      freeformIds.has(claim.task_id) &&
      claim.participant_id === opts.participantId &&
      (claim.status === "awarded" || claim.status === "pending_peer"),
  );
}

export function isClaimantTapback(
  fromHandle: string | null | undefined,
  claimantPhone: string,
): boolean {
  if (!fromHandle) return false;
  return fromHandle.trim().toLowerCase() === claimantPhone.trim().toLowerCase();
}

export function openPersonalTaskIds(
  tasks: { id: string; participant_id: string | null; source?: string | null }[],
  claims: { task_id: string; status: string }[],
  participantId: string,
): string[] {
  return tasks
    .filter(
      (task) =>
        task.participant_id === participantId &&
        task.source !== FREEFORM_SOURCE,
    )
    .filter((task) => {
      return !claims.some(
        (claim) =>
          claim.task_id === task.id &&
          (claim.status === "awarded" || claim.status === "pending_peer"),
      );
    })
    .map((task) => task.id);
}
