"use client";

import { useEffect, useRef, useState } from "react";
import type { LiveTask, LiveTripData } from "@/lib/live/data";
import styles from "./live.module.css";

const POLL_MS = 15_000;

function initials(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "?";
}

function TaskCard({ task }: { task: LiveTask }) {
  return (
    <li className={`${styles.taskCard} ${task.status === "completed" ? styles.taskCardDone : ""}`}>
      <div className={styles.taskTop}>
        <span className={styles.taskCode}>{task.code}</span>
        <span className={styles.taskTier}>{task.tier.toLowerCase()}</span>
      </div>
      <p className={styles.taskTitle}>{task.title}</p>
      <div className={styles.taskMeta}>
        {task.status === "completed" ? (
          <>
            <span className={styles.taskDone}>✓ {task.completedBy}</span>
            <span className={styles.taskPoints}>+{task.awardedPoints}</span>
          </>
        ) : (
          <>
            <span className={styles.taskPoints}>
              {task.points} pts
              {task.multiplier ? <span className={styles.multiplierBadge}>{task.multiplier.label}</span> : null}
            </span>
            {task.assignee ? <span className={styles.taskAssignee}>{task.assignee}</span> : null}
          </>
        )}
      </div>
      {task.neighborhood ? <p className={styles.taskFoot}>{task.neighborhood}</p> : null}
      {task.photo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.taskPhoto} src={task.photo} alt={`${task.completedBy}'s proof for ${task.code}`} loading="lazy" />
      ) : null}
    </li>
  );
}

export function LiveExperience({
  initialData,
  personId,
  poll = true,
}: {
  initialData: LiveTripData;
  personId?: string | null;
  poll?: boolean;
}) {
  const [data, setData] = useState(initialData);
  const pollUrl = useRef(`/api/live/${initialData.trip.id}`);

  useEffect(() => {
    // A lightweight polling fallback stands in for true realtime here: the
    // project keeps RLS off and reads only through the service role, so a
    // browser-side Supabase subscription has no grant to authenticate
    // against yet. Polling this read-only endpoint gets the same visible
    // effect (new claims/tasks/teams appear without a reload) without
    // opening that up. See docs/superpowers/specs for the write-up.
    if (!poll) return;
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const res = await fetch(pollUrl.current, { cache: "no-store" });
        if (!res.ok) return;
        const fresh = (await res.json()) as LiveTripData;
        if (!cancelled) setData(fresh);
      } catch {
        // Silent: the page just keeps showing the last good data until the
        // next poll succeeds.
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [poll]);

  const me = personId ? data.standings.find((s) => s.id === personId) : null;

  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.heroTop}>
          <span className={styles.planeIcon} aria-hidden>✈️</span>
        </div>
        <h1 className={styles.destination}>{data.trip.destination.toUpperCase()}</h1>
        <p className={styles.dayLine}>
          DAY {data.trip.day}
          {data.trip.totalDays ? ` OF ${data.trip.totalDays}` : ""}
          {data.trip.route ? ` · ${data.trip.route}` : ""}
        </p>
        <p className={styles.heroSub}>
          {data.trip.peopleCount} friends
          {data.trip.teamCount > 0 ? ` · ${data.trip.teamCount} teams` : ""} · {data.stats.questsCompleted} quests completed
        </p>
      </section>

      {me ? (
        <section className={styles.card}>
          <h2 className={styles.sectionTitle}>your trip</h2>
          <div className={styles.personalGrid}>
            <div><span className={styles.bigNumber}>#{me.rank}</span><span className={styles.bigLabel}>rank</span></div>
            <div><span className={styles.bigNumber}>{me.score}</span><span className={styles.bigLabel}>score</span></div>
            <div><span className={styles.bigNumber}>{me.tasksCompleted}</span><span className={styles.bigLabel}>completed</span></div>
            <div><span className={styles.bigNumber}>+{me.pointsToday}</span><span className={styles.bigLabel}>today</span></div>
          </div>
        </section>
      ) : null}

      <section className={styles.card}>
        <h2 className={styles.sectionTitle}>🏆 leaderboard</h2>
        <ol className={styles.leaderboard}>
          {data.standings.map((row) => {
            const leaderScore = data.standings[0]?.score || 1;
            return (
              <li key={row.id} className={`${styles.leaderRow} ${row.id === personId ? styles.leaderRowMe : ""}`}>
                <span className={styles.rank}>{row.rank}</span>
                <span className={styles.avatar} aria-hidden>{initials(row.name)}</span>
                <span className={styles.leaderName}>
                  {row.name}
                  {row.teamName ? <span className={styles.teamTag}>{row.teamName}</span> : null}
                </span>
                <span className={styles.score}>{row.score}</span>
                {row.pointsToday > 0 ? <span className={styles.pointsToday}>+{row.pointsToday} today</span> : null}
                <span className={styles.raceTrack} aria-hidden>
                  <span className={styles.raceFill} style={{ width: `${Math.max(4, Math.round((row.score / leaderScore) * 100))}%` }} />
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      {data.tasks.active.length > 0 ? (
        <section className={styles.card}>
          <h2 className={styles.sectionTitle}>active quests</h2>
          <ul className={styles.taskGrid}>
            {data.tasks.active.map((task) => <TaskCard key={task.id} task={task} />)}
          </ul>
        </section>
      ) : null}

      {data.proof.length > 0 ? (
        <section className={styles.card}>
          <h2 className={styles.sectionTitle}>proof</h2>
          <div className={styles.proofGrid}>
            {data.proof.map((task) => (
              <figure key={task.id} className={styles.proofItem}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={task.photo!} alt={`${task.completedBy}'s proof for ${task.code}`} loading="lazy" />
                <figcaption>
                  <span>{task.completedBy}</span>
                  <span>{task.code} · +{task.awardedPoints}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      ) : null}

      {data.itinerary.length > 0 ? (
        <section className={styles.card}>
          <h2 className={styles.sectionTitle}>today</h2>
          <ol className={styles.itineraryList}>
            {data.itinerary.map((anchor) => (
              <li key={anchor.order} className={styles.itineraryRow}>
                <span className={styles.itineraryMark} data-status={anchor.status}>
                  {anchor.status === "done" ? "✓" : anchor.status === "current" ? "→" : "○"}
                </span>
                {anchor.time ? <span className={styles.itineraryTime}>{anchor.time}</span> : null}
                <span className={styles.itineraryPlace}>{anchor.place}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

    </main>
  );
}
