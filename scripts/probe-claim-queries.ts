import { loadEnvConfig } from "@next/env";
import { getServiceClient } from "../lib/db/client";

loadEnvConfig(process.cwd(), true);

const TRIP_ID = "e82337ce-644e-4b29-bd28-c2a2c4f89c8d";
const CHAT_ID = "b730244d-7ba1-46ab-8a57-03debcd122d8";
const TIMEOUT_MS = 15_000;

const TRIP_COLS =
  "id, linq_chat_id, name, destination, start_date, end_date, state, difficulty, stake_text, timezone, destination_profile_json, is_solo, daily_points_cap";
const TASK_COLS =
  "id, trip_id, participant_id, team_id, code, title, tier, axes_json, base_points, photo_bonus_max, verification, day, expires_at, neighborhood, source";
const PARTICIPANT_COLS =
  "id, trip_id, phone, display_name, score, survey_json, survey_state, sidequests_muted, consented_at";
const CLAIM_COLS =
  "id, task_id, participant_id, evidence_url, image_hash, status, awarded_points, resolved_by, resolution_json, capped, created_at";

async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  console.log(`[probe] ${label} before`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timeout after ${TIMEOUT_MS}ms`)),
          TIMEOUT_MS,
        );
      }),
    ]);
    console.log(`[probe] ${label} after ${Date.now() - started}ms`);
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[probe] ${label} throw ${Date.now() - started}ms`, {
      name: error.name,
      message: error.message,
    });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const supabase = getServiceClient();
  console.log("[probe] client ready", {
    tripId: TRIP_ID,
    chatId: CHAT_ID,
    urlSet: Boolean(process.env.SUPABASE_URL),
  });

  const tripRes = await timed("trip.lookup by linq_chat_id", async () =>
    supabase
      .from("trips")
      .select(TRIP_COLS)
      .eq("linq_chat_id", CHAT_ID)
      .maybeSingle(),
  );
  if (tripRes.error) throw tripRes.error;
  console.log("[probe] trip", {
    found: Boolean(tripRes.data),
    id: tripRes.data?.id ?? null,
    is_solo: tripRes.data?.is_solo ?? null,
    state: tripRes.data?.state ?? null,
    matchesExpected: tripRes.data?.id === TRIP_ID,
  });

  const tasksRes = await timed("tasks.lookup by trip_id", async () =>
    supabase.from("tasks").select(TASK_COLS).eq("trip_id", TRIP_ID),
  );
  if (tasksRes.error) throw tasksRes.error;
  const tasks = tasksRes.data ?? [];
  console.log("[probe] tasks", {
    count: tasks.length,
    codes: tasks.map((row) => (row as { code: string }).code),
    a1: tasks.find((row) => (row as { code: string }).code === "A1") ?? null,
  });

  const peopleRes = await timed("people.lookup by trip_id", async () =>
    supabase.from("participants").select(PARTICIPANT_COLS).eq("trip_id", TRIP_ID),
  );
  if (peopleRes.error) throw peopleRes.error;
  const people = peopleRes.data ?? [];
  console.log("[probe] people", {
    count: people.length,
    rows: people.map((row) => ({
      id: (row as { id: string }).id,
      phone: (row as { phone: string }).phone,
      display_name: (row as { display_name: string }).display_name,
      score: (row as { score: number }).score,
      survey_state: (row as { survey_state: string | null }).survey_state,
    })),
  });

  const taskIds = tasks.map((row) => (row as { id: string }).id);
  if (taskIds.length === 0) {
    console.log("[probe] open_claims.lookup skip (no tasks)");
  } else {
    const claimsRes = await timed(
      "open_claims.lookup by task_id in (...)",
      async () =>
        supabase.from("claims").select(CLAIM_COLS).in("task_id", taskIds),
    );
    if (claimsRes.error) throw claimsRes.error;
    console.log("[probe] claims", {
      count: (claimsRes.data ?? []).length,
      rows: claimsRes.data ?? [],
    });
  }

  const phone = (people[0] as { phone?: string } | undefined)?.phone;
  if (phone) {
    const personRes = await timed(
      "participant.lookup by (trip_id, phone)",
      async () =>
        supabase
          .from("participants")
          .select(PARTICIPANT_COLS)
          .eq("trip_id", TRIP_ID)
          .eq("phone", phone)
          .maybeSingle(),
    );
    if (personRes.error) throw personRes.error;
    console.log("[probe] participant", {
      found: Boolean(personRes.data),
      id: personRes.data?.id ?? null,
      phone,
    });

    const a1 = tasks.find((row) => (row as { code: string }).code === "A1") as
      | { id: string; day: number }
      | undefined;
    if (a1) {
      const existing = await timed("already_claimed by task_id A1", async () =>
        supabase.from("claims").select(CLAIM_COLS).eq("task_id", a1.id),
      );
      if (existing.error) throw existing.error;
      console.log("[probe] already_claimed A1", existing.data ?? []);

      const dayTasks = await timed("daily_cap.tasks by trip_id+day", async () =>
        supabase.from("tasks").select("id").eq("trip_id", TRIP_ID).eq("day", a1.day),
      );
      if (dayTasks.error) throw dayTasks.error;
      const dayIds = (dayTasks.data ?? []).map((row) => (row as { id: string }).id);
      if (dayIds.length === 0) {
        console.log("[probe] daily_cap.claims skip (no day tasks)");
      } else {
        const capClaims = await timed(
          "daily_cap.claims by participant+status+task_ids",
          async () =>
            supabase
              .from("claims")
              .select("awarded_points")
              .eq("participant_id", personRes.data?.id)
              .eq("status", "awarded")
              .in("task_id", dayIds),
        );
        if (capClaims.error) throw capClaims.error;
        console.log("[probe] daily_cap.claims", capClaims.data ?? []);
      }
    } else {
      console.log("[probe] no A1 task on this trip");
    }
  } else {
    console.log("[probe] no participants on this trip");
  }

  console.log("[probe] done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
