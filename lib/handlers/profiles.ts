import { getServiceClient } from "@/lib/db/client";
import type { ParticipantRow, TripRow } from "@/lib/db/types";
import {
  compatAnswers,
  dimsForInterests,
  nudge,
  prefsFromAnswers,
  prefsOf,
  profileStale,
  setWeight,
  withBasis,
  type PrefDim,
  type Prefs,
} from "@/lib/game/prefs";
import { groupProfile, personProfile } from "@/lib/game/profile";
import { matchPerson } from "@/lib/game/split";
import { answerValue, type SurveyAnswers } from "@/lib/game/survey";
import type { InterestKey } from "@/lib/game/templates";

// Saving and updating what the bot knows about people: weights, the old
// survey shape every filter reads, and the written profiles (person and
// group). All DM-private, like survey_json.

type PersonRow = ParticipantRow & { prefs_json?: unknown; profile_md?: string | null };

function profileStep(step: string, fields: Record<string, unknown>): void {
  console.info("[japlan.profile] step", { step, ...fields });
}

// "someone you want to stick with?" named a trip member: that's who.
function partnerOf(answers: SurveyAnswers, self: PersonRow, people: PersonRow[]): string | null {
  const said = answerValue(answers, "fu_split");
  if (!said) return null;
  const others = people
    .filter((p) => p.id !== self.id)
    .map((p) => ({ id: p.id, display_name: p.display_name, answers: {} }));
  for (const word of said.split(/[\s,]+/)) {
    const hit = matchPerson(word, others);
    if (hit) return hit.display_name;
  }
  return null;
}

async function tripPeople(tripId: string): Promise<PersonRow[]> {
  const { data, error } = await getServiceClient().from("participants").select("*").eq("trip_id", tripId);
  if (error) throw error;
  return (data ?? []) as PersonRow[];
}

// The group's aggregate profile, stored on the trip. Never names who has
// which constraint.
export async function refreshGroupProfile(trip: TripRow): Promise<string> {
  const people = (await tripPeople(trip.id)).filter((p) => p.survey_json);
  const text = groupProfile(
    people.map((p) => ({ answers: (p.survey_json ?? {}) as SurveyAnswers, prefs: prefsOf(p.prefs_json, (p.survey_json ?? {}) as SurveyAnswers) })),
  );
  const { error } = await getServiceClient().from("trips").update({ group_profile_md: text }).eq("id", trip.id);
  if (error) throw error;
  return text;
}

async function saveProfile(
  person: PersonRow,
  answers: SurveyAnswers,
  prefs: Prefs,
  partner: string | null,
): Promise<{ answers: SurveyAnswers; profile: string }> {
  const merged = compatAnswers(answers, prefs, partner);
  const profile = personProfile({ name: person.display_name, answers: merged, prefs, partnerName: partner });
  const { error } = await getServiceClient()
    .from("participants")
    .update({ survey_json: merged, prefs_json: withBasis(prefs), profile_md: profile })
    .eq("id", person.id);
  if (error) throw error;
  profileStep("written", { participantId: person.id, chars: profile.length });
  return { answers: merged, profile };
}

// Survey finished (or a sidequest answer given): weights from the answers,
// the old keys filled in, the profile written, the group profile refreshed.
export async function saveSurveyResult(
  trip: TripRow,
  person: PersonRow,
  answers: SurveyAnswers,
): Promise<SurveyAnswers> {
  const people = await tripPeople(trip.id);
  const learned = person.prefs_json ? prefsOf(person.prefs_json, answers) : null;
  // A fresh survey sets the weights; a later answer (sidequests) keeps what
  // was learned since.
  const prefs = learned ?? prefsFromAnswers(answers);
  const saved = await saveProfile(person, answers, prefs, partnerOf(answers, person, people));
  await refreshGroupProfile(trip);
  return saved.answers;
}

async function freshPerson(id: string): Promise<PersonRow | null> {
  const { data, error } = await getServiceClient().from("participants").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as PersonRow | null) ?? null;
}

// Behaviour moves weights a little (a task claimed, a place suggested, a
// category avoided). The profile is rewritten only once the weights have
// moved meaningfully since it was last written, not on every message.
export async function learnFrom(
  trip: TripRow,
  personId: string,
  signal: { interests?: InterestKey[]; dims?: PrefDim[]; direction: 1 | -1; why: string },
): Promise<void> {
  const person = await freshPerson(personId);
  if (!person) return;
  const answers = (person.survey_json ?? {}) as SurveyAnswers;
  const dims = [...new Set([...(signal.dims ?? []), ...dimsForInterests(signal.interests ?? [])])];
  if (dims.length === 0) return;
  const prefs = nudge(prefsOf(person.prefs_json, answers), dims, signal.direction);
  profileStep("nudge", { participantId: personId, dims, direction: signal.direction, why: signal.why });
  if (profileStale(prefs)) {
    await saveProfile(person, answers, prefs, null);
    await refreshGroupProfile(trip);
    return;
  }
  const { error } = await getServiceClient().from("participants").update({ prefs_json: prefs }).eq("id", personId);
  if (error) throw error;
}

// "i'm not that into food", "more nightlife": stated outright, high
// confidence, profile rewritten.
export async function statePreference(trip: TripRow, personId: string, dims: PrefDim[], w: number): Promise<string | null> {
  const person = await freshPerson(personId);
  if (!person) return null;
  const answers = (person.survey_json ?? {}) as SurveyAnswers;
  const prefs = setWeight(prefsOf(person.prefs_json, answers), dims, w);
  const saved = await saveProfile(person, answers, prefs, null);
  await refreshGroupProfile(trip);
  return saved.profile;
}

// What the bot knows about someone, for "japlan what do you know about me".
export async function profileFor(trip: TripRow, personId: string): Promise<string | null> {
  const person = await freshPerson(personId);
  if (!person) return null;
  if (person.profile_md) return person.profile_md;
  if (!person.survey_json) return null;
  const answers = person.survey_json as SurveyAnswers;
  const saved = await saveProfile(person, answers, prefsOf(person.prefs_json, answers), null);
  void trip;
  return saved.profile;
}
