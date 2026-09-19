import type { SurveyAnswers } from "./survey";

let loggedSoloModeRaw = false;

export function soloModeEnabled(
  value = process.env.JAPLAN_SOLO_MODE,
): boolean {
  const raw = value ?? null;
  const normalized = raw?.trim().toLowerCase() ?? "";
  const enabled =
    normalized === "true" || normalized === "1" || normalized === "yes";
  if (!loggedSoloModeRaw) {
    loggedSoloModeRaw = true;
    console.info("[japlan.solo] JAPLAN_SOLO_MODE", {
      raw,
      enabled,
    });
  }
  return enabled;
}

export function isSoloBootstrapPhrase(text: string): boolean {
  return /\bjaplan\s+solo\b/i.test(text);
}

export function isSoloSkipSurveyPhrase(text: string): boolean {
  return /\bjaplan\s+skipsurvey\b/i.test(text);
}

export function shouldRunSoloBootstrap(opts: {
  enabled: boolean;
  isDm: boolean;
  text: string;
}): boolean {
  return opts.enabled && opts.isDm && isSoloBootstrapPhrase(opts.text);
}

export function shouldRunSoloSkipSurvey(opts: {
  enabled: boolean;
  isDm: boolean;
  text: string;
}): boolean {
  return opts.enabled && opts.isDm && isSoloSkipSurveyPhrase(opts.text);
}

export function verificationForSolo(
  verification: "photo" | "honor" | "peer",
  isSolo: boolean,
): "photo" | "honor" | "peer" {
  if (isSolo && verification === "peer") return "honor";
  return verification;
}

export function applySoloVerification<
  T extends { title?: string; verification: "photo" | "honor" | "peer" },
>(tasks: T[], isSolo: boolean): T[] {
  if (!isSolo) return tasks;
  return tasks.map((task) => {
    const next = verificationForSolo(task.verification, true);
    if (next !== task.verification) {
      console.info("[japlan.solo] peer verification downgraded to honor", {
        title: task.title ?? null,
      });
    }
    return { ...task, verification: next };
  });
}

export type SoloDmRoute = "solo_bootstrap" | "solo_skip" | "solo_claim";

export function routeSoloDm(opts: {
  enabled: boolean;
  text: string;
  soloTripState: string | null;
}): SoloDmRoute | null {
  if (!opts.enabled) return null;
  if (isSoloBootstrapPhrase(opts.text)) return "solo_bootstrap";
  if (isSoloSkipSurveyPhrase(opts.text)) return "solo_skip";
  if (opts.soloTripState === "active") return "solo_claim";
  return null;
}

export function soloParticipantCount(phones: string[]): number {
  return new Set(phones.filter((phone) => phone.trim())).size;
}

export function defaultSoloSurveyAnswers(): SurveyAnswers {
  return {
    age_bracket: { value: "25-34" },
    dietary: { value: "none" },
    mobility: { skipped: true },
    budget: { value: "medium" },
    blackout: { skipped: true },
    interests: { value: "balanced" },
    nightlife: { value: "yes" },
    drinking: { value: "sometimes" },
    pace: { value: "two_things_and_lunch" },
    chaos: { value: "high" },
    chaos_dares: { value: "strangers, unidentifiable food" },
    competitiveness: { value: "along_for_the_ride" },
    attractions: { skipped: true },
    social_with: { skipped: true },
    social_travelled: { skipped: true },
    social_couples: { value: "n/a" },
  };
}
