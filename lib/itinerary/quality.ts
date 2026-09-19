import type { CandidateActivity } from "./schemas";
import type { TripConfig } from "./config";

export type ActivityGroup = "culture" | "food" | "outdoors" | "neighborhood" | "experience" | "attraction";

const cjk = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;

export function isEnglishFacing(value: string): boolean {
  return !cjk.test(value) && !/[\uFFFD]|Â¥|â€|ï½|ãƒ|å/.test(value);
}

/** Excludes only activities whose own researched copy directly contradicts a requested mobility constraint. */
export function isExplicitlyIncompatible(candidate: CandidateActivity, config: Pick<TripConfig, "accessibilityPreferences">): boolean {
  const restrictions = config.accessibilityPreferences.mobilityRestrictions.join(" ").toLocaleLowerCase();
  if (!/avoid.*walking|extensive walking/.test(restrictions)) return false;
  const details = `${candidate.name} ${candidate.description} ${candidate.accessibilityNotes ?? ""}`.toLocaleLowerCase();
  return /walking tour|requires.{0,70}walking|includes.{0,70}walking|walking through.{0,70}(street|alley|bridge|outdoor)/.test(details);
}

export function activityGroup(candidate: Pick<CandidateActivity, "category" | "name" | "description">): ActivityGroup {
  const value = `${candidate.category} ${candidate.name} ${candidate.description}`.toLocaleLowerCase();
  if (/restaurant|cafe|café|dining|food|market.*eat/.test(value)) return "food";
  if (/park|garden|beach|waterfront|viewpoint|scenic|outdoor|nature/.test(value)) return "outdoors";
  if (/neighbou?rhood|district|market|street|quarter/.test(value)) return "neighborhood";
  if (/workshop|class|tour|music|nightlife|performance|game|experience/.test(value)) return "experience";
  if (/museum|gallery|exhibition|art|historic|history|architecture|cultural/.test(value)) return "culture";
  return "attraction";
}

/** Keeps a broad candidate pool while preventing one theme from crowding out viable alternatives. */
export function balanceCandidates(candidates: CandidateActivity[], minimum: number): CandidateActivity[] {
  const byGroup = new Map<ActivityGroup, CandidateActivity[]>();
  for (const candidate of candidates) {
    const group = activityGroup(candidate);
    byGroup.set(group, [...(byGroup.get(group) ?? []), candidate]);
  }
  const groups = [...byGroup.values()];
  const selected: CandidateActivity[] = [];
  const perGroupCap = Math.max(2, Math.ceil(minimum / Math.max(1, groups.length)) + 1);
  for (const group of groups) selected.push(...group.slice(0, perGroupCap));
  if (selected.length < minimum) {
    const selectedIds = new Set(selected.map(candidate => candidate.id));
    for (const candidate of candidates) {
      if (selected.length >= minimum) break;
      if (!selectedIds.has(candidate.id)) { selected.push(candidate); selectedIds.add(candidate.id); }
    }
  }
  return selected;
}

export function hasUsefulTripVariety(candidates: CandidateActivity[]): boolean {
  return new Set(candidates.filter(candidate => activityGroup(candidate) !== "food").map(activityGroup)).size >= 2;
}
