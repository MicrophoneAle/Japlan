"use client";

import { useState } from "react";
import styles from "./itinerary.module.css";

type Activity = {
  id: string;
  name: string;
  category: string;
  description: string;
  startTime: string;
  endTime: string;
  notes: string;
  accessibilityNotes: string | null;
  dietaryNotes: string | null;
  sourceUrls: string[];
};
type Day = {
  date: string;
  dayNumber: number;
  summary: string;
  activities: Activity[];
  diningPlan: {
    candidate: Pick<Activity, "name" | "description" | "dietaryNotes"> | null;
    startTime: string;
    endTime: string;
    notes: string;
  };
};
type ResearchAction = {
  at: string;
  type: string;
  detail: string;
  url: string | null;
  iteration?: number;
  tool?: string;
  args?: Record<string, unknown>;
  durationMs?: number;
  candidateCount?: number;
  cached?: boolean;
  browserbaseInvoked?: boolean;
};
type Result = {
  itinerary: { destination: string; status: string; days: Day[] };
  research: {
    mode: string;
    sessionId: string | null;
    dashboardUrl: string | null;
    visitedUrls: string[];
    actions: ResearchAction[];
    candidates: Array<{
      id: string;
      name: string;
      category: string;
      description: string;
      priceLevel: string;
      estimatedDurationMinutes: number | null;
      accessibilityNotes: string | null;
      dietaryNotes: string | null;
      sourceUrls: string[];
      unverifiedFields: string[];
      translatedFromSource: boolean;
    }>;
    browserbaseInvoked?: boolean;
    selectedCandidateIds?: string[];
    agentSummary?: string | null;
  };
};
type State = "idle" | "researching" | "complete" | "error";

function Stop({ activity }: { activity: Activity }) {
  return (
    <div className={styles.stop}>
      <time>
        {activity.startTime} - {activity.endTime}
      </time>
      <div>
        <b>{activity.name}</b>
        <span>{activity.category}</span>
        <p>{activity.description}</p>
        <small>{activity.notes}</small>
        {activity.accessibilityNotes && <small>Access: {activity.accessibilityNotes}</small>}
        {activity.dietaryNotes && <small>Food: {activity.dietaryNotes}</small>}
      </div>
    </div>
  );
}

function Timeline({ day }: { day: Day }) {
  const stops = [
    ...day.activities.map((activity) => ({
      start: activity.startTime,
      key: activity.id,
      content: <Stop activity={activity} />,
    })),
    {
      start: day.diningPlan.startTime,
      key: "dining",
      content: (
        <div className={styles.stop}>
          <time>
            {day.diningPlan.startTime} - {day.diningPlan.endTime}
          </time>
          <div>
            <b>{day.diningPlan.candidate?.name ?? "Vegetarian dining to confirm"}</b>
            <span>DINING PLAN</span>
            <p>
              {day.diningPlan.candidate?.description ??
                "Choose a nearby vegetarian option appropriate to this day’s area."}
            </p>
            <small>{day.diningPlan.notes}</small>
            {day.diningPlan.candidate?.dietaryNotes && (
              <small>Food: {day.diningPlan.candidate.dietaryNotes}</small>
            )}
          </div>
        </div>
      ),
    },
  ].sort((left, right) => left.start.localeCompare(right.start));
  return (
    <>
      {stops.map((stop) => (
        <div key={stop.key}>{stop.content}</div>
      ))}
    </>
  );
}

function formatAction(action: ResearchAction): string {
  const bits: string[] = [];
  if (action.iteration !== undefined) bits.push(`iter ${action.iteration}`);
  if (action.tool) bits.push(action.tool);
  if (action.durationMs !== undefined) bits.push(`${action.durationMs}ms`);
  if (action.candidateCount !== undefined) bits.push(`${action.candidateCount} candidates`);
  if (action.cached) bits.push("cached");
  if (action.browserbaseInvoked) bits.push("browserbase");
  const meta = bits.length ? ` [${bits.join(" · ")}]` : "";
  return `${action.type}${meta} · ${action.detail}`;
}

export function ItineraryExperience() {
  const [state, setState] = useState<State>("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inspector, setInspector] = useState(false);
  const generate = async () => {
    setError(null);
    setResult(null);
    setState("researching");
    try {
      const response = await fetch("/api/itinerary/generate", { method: "POST" });
      const payload = (await response.json()) as Result & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Generation failed");
      setResult(payload);
      setState("complete");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Generation failed");
      setState("error");
    }
  };
  return (
    <main className={styles.page}>
      <header>
        <p className={styles.brand}>
          JAPLAN <span>ITINERARY LAB</span>
        </p>
        <p className={styles.badge}>DEVELOPMENT ONLY</p>
      </header>
      <section className={styles.hero}>
        <p className={styles.eyebrow}>DURATION-AWARE · REAL RESEARCH · GEMINI TOOL LOOP</p>
        <h1>
          PLAN LESS.
          <br />
          <i>GO MORE.</i>
        </h1>
        <p className={styles.intro}>
          A researched, unvalidated draft with varied pacing and visible dietary/accessibility
          uncertainty.
        </p>
        <button className={styles.generate} onClick={generate} disabled={state === "researching"}>
          {state === "researching" ? "JAPLAN IS WORKING..." : "GENERATE ITINERARY"}
        </button>
        {state !== "idle" && (
          <p className={styles.status}>
            <span />{" "}
            {state === "researching"
              ? "Research and draft generation are running."
              : state === "complete"
                ? "Draft generated."
                : "Generation stopped."}
          </p>
        )}
        {error && (
          <div className={styles.error}>
            <b>Couldn’t generate the draft.</b>
            <p>{error}</p>
            <button onClick={generate}>Try again</button>
          </div>
        )}
      </section>
      {result && (
        <>
          <section className={styles.draft}>
            <div>
              <p className={styles.eyebrow}>STATUS · DRAFT / UNVALIDATED</p>
              <h2>{result.itinerary.destination}</h2>
            </div>
            {result.itinerary.days.map((day) => (
              <article key={day.date} className={styles.day}>
                <p>
                  DAY {day.dayNumber} · {day.date}
                </p>
                <h3>{day.summary}</h3>
                <Timeline day={day} />
              </article>
            ))}
          </section>
          <section className={styles.inspector}>
            <button onClick={() => setInspector((value) => !value)}>
              {inspector ? "HIDE" : "SHOW"} RESEARCH INSPECTOR
            </button>
            {inspector && (
              <div className={styles.inspectBody}>
                <p>
                  Mode: <b>{result.research.mode}</b>
                </p>
                <p>
                  Browserbase invoked:{" "}
                  <b>{result.research.browserbaseInvoked ? "yes" : "no"}</b>
                </p>
                {result.research.agentSummary && (
                  <p>
                    Agent summary: {result.research.agentSummary}
                  </p>
                )}
                {result.research.selectedCandidateIds && (
                  <p>
                    Final selection:{" "}
                    <b>{result.research.selectedCandidateIds.join(", ") || "(none)"}</b>
                  </p>
                )}
                {result.research.dashboardUrl && (
                  <a href={result.research.dashboardUrl} target="_blank" rel="noreferrer">
                    Open Browserbase session {result.research.sessionId} →
                  </a>
                )}
                <h3>Visited sites</h3>
                {result.research.visitedUrls.map((url) => (
                  <a key={url} href={url} target="_blank" rel="noreferrer">
                    {url}
                  </a>
                ))}
                <h3>Agent / research log</h3>
                {result.research.actions.map((action, index) => (
                  <p key={index}>
                    <b>{formatAction(action)}</b>
                    {action.args && (
                      <small> args: {JSON.stringify(action.args)}</small>
                    )}
                  </p>
                ))}
                <h3>Candidate activity ledger</h3>
                {result.research.candidates.map((candidate) => {
                  const selected =
                    result.research.selectedCandidateIds?.includes(candidate.id) ||
                    result.itinerary.days.some(
                      (day) =>
                        day.activities.some((activity) => activity.id === candidate.id) ||
                        day.diningPlan.candidate?.name === candidate.name,
                    );
                  return (
                    <article key={candidate.id}>
                      <p className={selected ? styles.selected : styles.excluded}>
                        {selected ? "SELECTED" : "EXCLUDED"}
                      </p>
                      <b>{candidate.name}</b>
                      <p>{candidate.description}</p>
                      <small>
                        id: {candidate.id} · {candidate.priceLevel} ·{" "}
                        {candidate.estimatedDurationMinutes
                          ? `${candidate.estimatedDurationMinutes} min`
                          : "duration unknown"}
                      </small>
                      <small>
                        Access: {candidate.accessibilityNotes ?? "unknown"} · Food:{" "}
                        {candidate.dietaryNotes ?? "unknown"}
                      </small>
                      <small>
                        {candidate.translatedFromSource ? "Translated from source · " : ""}
                        Unverified: {candidate.unverifiedFields.join(", ") || "none"}
                      </small>
                      {candidate.sourceUrls.map((url) => (
                        <a key={url} href={url} target="_blank" rel="noreferrer">
                          Source →
                        </a>
                      ))}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
