import { getServiceClient } from "@/lib/db/client";
import type { ParticipantRow, TripRow } from "@/lib/db/types";
import { defaultWakeKeyword, stripWakeKeyword, wakeKeywordRe } from "@/lib/game/addressing";
import {
  findParticipantOnTrip,
  getTripByChatId,
  listParticipants,
} from "@/lib/handlers/bootstrap";
import { chatIdFromData } from "@/lib/linq/payload";
import { sendText } from "@/lib/linq/send";

type GroupDecision = {
  id: string;
  trip_id: string;
  prompt: string;
  status: "open" | "closed";
  created_by: string;
  selected_option: number | null;
  created_at: string;
  closed_at: string | null;
  last_reminded_at: string | null;
};

type DecisionOption = {
  id: string;
  decision_id: string;
  option_index: number;
  label: string;
  message_id: string | null;
};

type DecisionVote = { participant_id: string; option_index: number };

type DecisionCommand =
  | { kind: "create"; prompt: string; options: string[] }
  | { kind: "vote"; option: number }
  | { kind: "status" }
  | { kind: "close"; option: number | null }
  | { kind: "remind" };

const OPTION_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];

function parseDecisionCommand(text: string): DecisionCommand | null {
  const keyword = defaultWakeKeyword();
  if (!keyword || !wakeKeywordRe(keyword).test(text)) return null;
  const body = stripWakeKeyword(text, keyword).replace(/^[,;:\s-]+/, "").trim();

  const create = body.match(/^decide(?:\s+|$)(.*)$/i);
  if (create) {
    const sections = create[1].split("|").map((part) => part.trim()).filter(Boolean);
    if (sections.length >= 3 && sections.length <= 6) {
      return { kind: "create", prompt: sections[0].slice(0, 180), options: sections.slice(1).map((s) => s.slice(0, 100)) };
    }
    return { kind: "create", prompt: "", options: [] };
  }

  const vote = body.match(/^vote\s+(\d+)$/i);
  if (vote) return { kind: "vote", option: Number(vote[1]) };
  if (/^vote\s+(?:status|results?|tally)$/i.test(body)) return { kind: "status" };
  const close = body.match(/^close\s+vote(?:\s+(\d+))?$/i);
  if (close) return { kind: "close", option: close[1] ? Number(close[1]) : null };
  if (/^(?:remind|remind people|remind everyone)\s+vote$/i.test(body)) return { kind: "remind" };
  return null;
}

function tally(votes: DecisionVote[], options: DecisionOption[]): number[] {
  return options.map((option) => votes.filter((vote) => vote.option_index === option.option_index).length);
}

function tallyLine(counts: number[], options: DecisionOption[]): string {
  return options.map((option, index) => `${option.option_index}. ${option.label} · ${counts[index]}`).join("\n");
}

function pendingNames(people: ParticipantRow[], votes: DecisionVote[]): string[] {
  const voted = new Set(votes.map((vote) => vote.participant_id));
  return people.filter((person) => !voted.has(person.id)).map((person) => person.display_name);
}

async function openDecision(tripId: string): Promise<GroupDecision | null> {
  const { data, error } = await getServiceClient()
    .from("group_decisions")
    .select("id, trip_id, prompt, status, created_by, selected_option, created_at, closed_at, last_reminded_at")
    .eq("trip_id", tripId)
    .eq("status", "open")
    .maybeSingle();
  if (error) throw error;
  return data as GroupDecision | null;
}

async function optionsFor(decisionId: string): Promise<DecisionOption[]> {
  const { data, error } = await getServiceClient()
    .from("group_decision_options")
    .select("id, decision_id, option_index, label, message_id")
    .eq("decision_id", decisionId)
    .order("option_index");
  if (error) throw error;
  return (data ?? []) as DecisionOption[];
}

async function votesFor(decisionId: string): Promise<DecisionVote[]> {
  const { data, error } = await getServiceClient()
    .from("group_decision_votes")
    .select("participant_id, option_index")
    .eq("decision_id", decisionId);
  if (error) throw error;
  return (data ?? []) as DecisionVote[];
}

async function recordVote(decisionId: string, participantId: string, optionIndex: number): Promise<void> {
  const { error } = await getServiceClient().from("group_decision_votes").upsert(
    {
      decision_id: decisionId,
      participant_id: participantId,
      option_index: optionIndex,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "decision_id,participant_id" },
  );
  if (error) throw error;
}

async function authorizeOrganizer(
  trip: TripRow,
  participant: ParticipantRow,
  people: ParticipantRow[],
): Promise<string | null> {
  if (!trip.organizer_participant_id) {
    const { data, error } = await getServiceClient()
      .from("trips")
      .update({ organizer_participant_id: participant.id })
      .eq("id", trip.id)
      .is("organizer_participant_id", null)
      .select("organizer_participant_id")
      .maybeSingle();
    if (error) throw error;
    if (data) {
      trip.organizer_participant_id = participant.id;
    } else {
      const { data: current, error: readError } = await getServiceClient()
        .from("trips")
        .select("organizer_participant_id")
        .eq("id", trip.id)
        .maybeSingle();
      if (readError) throw readError;
      trip.organizer_participant_id = (current as { organizer_participant_id: string | null } | null)?.organizer_participant_id ?? null;
    }
  }
  if (trip.organizer_participant_id === participant.id) return null;
  const name = people.find((person) => person.id === trip.organizer_participant_id)?.display_name ?? "the organizer";
  return `👑 ${name} controls shared trip decisions and makes the final call. ask them to open or close this vote.`;
}

function groupOnlyLine(): string {
  return "🗳️ group decisions happen in the trip chat so everyone sees the same choices. vote there with “japlan vote 1” or tap ❤️/👍 on an option.";
}

function commandHelpLine(): string {
  return [
    "try: japlan decide dinner | ramen | sushi",
    "everyone can tap ❤️/👍 on an option or send “japlan vote 1”. votes can be changed; silence abstains.",
    "the organizer can send “japlan remind vote” or “japlan close vote 2”. without a number, close picks a clear leader and leaves ties open.",
  ].join("\n");
}

async function createDecision(opts: {
  trip: TripRow;
  participant: ParticipantRow;
  people: ParticipantRow[];
  prompt: string;
  choices: string[];
  chatId: string;
}): Promise<void> {
  const send = sendText;
  if (!opts.prompt || opts.choices.length < 2 || opts.choices.length > 5 || opts.choices.some((choice) => !choice)) {
    await send(opts.chatId, commandHelpLine());
    return;
  }
  const refusal = await authorizeOrganizer(opts.trip, opts.participant, opts.people);
  if (refusal) {
    await send(opts.chatId, refusal);
    return;
  }
  const existing = await openDecision(opts.trip.id);
  if (existing) {
    await send(opts.chatId, `there's already a group vote open: “${existing.prompt}”. close that one before starting another.`);
    return;
  }

  const { data, error } = await getServiceClient()
    .from("group_decisions")
    .insert({ trip_id: opts.trip.id, prompt: opts.prompt, created_by: opts.participant.id })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") {
      await send(opts.chatId, "there's already a group vote open. close it before starting another.");
      return;
    }
    throw error;
  }
  const decisionId = (data as { id: string }).id;
  const optionRows = opts.choices.map((label, index) => ({
    decision_id: decisionId,
    option_index: index + 1,
    label,
  }));
  const { error: optionError } = await getServiceClient().from("group_decision_options").insert(optionRows);
  if (optionError) throw optionError;

  await send(
    opts.chatId,
    `🗳️ ${opts.prompt}\n\nreply “japlan vote 1” or tap ❤️/👍 on an option below. votes can be changed. silence counts as abstaining; the organizer makes the final call if we're stuck.`,
  );
  for (let index = 0; index < opts.choices.length; index += 1) {
    const sent = await send(opts.chatId, `${OPTION_EMOJI[index]} ${opts.choices[index]}\nreact ❤️/👍 here, or send “japlan vote ${index + 1}”.`);
    const { error: messageError } = await getServiceClient()
      .from("group_decision_options")
      .update({ message_id: sent.messageId })
      .eq("decision_id", decisionId)
      .eq("option_index", index + 1);
    if (messageError) throw messageError;
  }
}

async function sendVoteStatus(opts: {
  people: ParticipantRow[];
  decision: GroupDecision;
  chatId: string;
}): Promise<void> {
  const [options, votes] = await Promise.all([optionsFor(opts.decision.id), votesFor(opts.decision.id)]);
  const waiting = pendingNames(opts.people, votes);
  const lines = [`🗳️ ${opts.decision.prompt}`, tallyLine(tally(votes, options), options)];
  lines.push(waiting.length > 0 ? `⏳ still waiting: ${waiting.join(", ")}` : "✅ everyone has voted (or there is nobody else to hear from)");
  lines.push("silence is an abstention. only the organizer can close the vote.");
  await sendText(opts.chatId, lines.join("\n"));
}

async function remindDecision(opts: {
  people: ParticipantRow[];
  decision: GroupDecision;
  chatId: string;
}): Promise<void> {
  const votes = await votesFor(opts.decision.id);
  const waiting = pendingNames(opts.people, votes);
  if (waiting.length === 0) {
    await sendText(opts.chatId, `✅ everyone's weighed in on “${opts.decision.prompt}”. organizer can close it with “japlan close vote”.`);
    return;
  }
  await sendText(opts.chatId, `⏳ quick nudge on “${opts.decision.prompt}”: still waiting on ${waiting.join(", ")}. vote “japlan vote 1”, react to an option, or sit this one out — silence abstains.`);
  const { error } = await getServiceClient()
    .from("group_decisions")
    .update({ last_reminded_at: new Date().toISOString() })
    .eq("id", opts.decision.id)
    .eq("status", "open");
  if (error) throw error;
}

async function closeDecision(opts: {
  trip: TripRow;
  participant: ParticipantRow;
  people: ParticipantRow[];
  decision: GroupDecision;
  requestedOption: number | null;
  chatId: string;
}): Promise<void> {
  const refusal = await authorizeOrganizer(opts.trip, opts.participant, opts.people);
  if (refusal) {
    await sendText(opts.chatId, refusal);
    return;
  }
  const [options, votes] = await Promise.all([optionsFor(opts.decision.id), votesFor(opts.decision.id)]);
  let selected: number;
  if (opts.requestedOption !== null) {
    if (!options.some((option) => option.option_index === opts.requestedOption)) {
      await sendText(opts.chatId, `that option isn't on this vote. choose ${options.map((option) => option.option_index).join(" or ")}.`);
      return;
    }
    selected = opts.requestedOption;
  } else {
    const counts = tally(votes, options);
    const high = Math.max(0, ...counts);
    const leaders = options.filter((_, index) => counts[index] === high);
    if (high === 0 || leaders.length !== 1) {
      await sendText(opts.chatId, `this one's tied (or nobody voted):\n${tallyLine(counts, options)}\n👑 as organizer, pick the final call with “japlan close vote 1”.`);
      return;
    }
    selected = leaders[0].option_index;
  }
  const choice = options.find((option) => option.option_index === selected);
  if (!choice) return;
  const { data, error } = await getServiceClient()
    .from("group_decisions")
    .update({ status: "closed", selected_option: selected, closed_at: new Date().toISOString() })
    .eq("id", opts.decision.id)
    .eq("status", "open")
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) {
    await sendText(opts.chatId, "that vote was already closed.");
    return;
  }
  const waiting = pendingNames(opts.people, votes);
  await sendText(
    opts.chatId,
    `✅ vote closed: ${choice.label}${waiting.length > 0 ? `\n${waiting.join(", ")} didn't weigh in; silence counted as abstaining.` : ""}`,
  );
}

// Handles the explicit shared-decision commands before ordinary group chat.
export async function handleGroupDecisionMessage(opts: {
  chatId: string;
  isDm: boolean;
  phone: string | null;
  text: string;
}): Promise<boolean> {
  const command = parseDecisionCommand(opts.text);
  if (!command) return false;
  if (opts.isDm) {
    await sendText(opts.chatId, groupOnlyLine());
    return true;
  }
  const trip = await getTripByChatId(opts.chatId);
  if (!trip || trip.is_solo) {
    await sendText(opts.chatId, "there's no group trip running here to vote on yet.");
    return true;
  }
  const participant = opts.phone ? await findParticipantOnTrip(trip.id, opts.phone) : null;
  if (!participant) {
    await sendText(opts.chatId, "i can only count votes from people in this trip chat.");
    return true;
  }
  if (trip.state !== "active") {
    await sendText(opts.chatId, "🧭 finish the shared setup and private surveys first; group votes open once the trip is live.");
    return true;
  }
  const people = await listParticipants(trip.id);

  if (command.kind === "create") {
    await createDecision({
      trip,
      participant,
      people,
      prompt: command.prompt,
      choices: command.options,
      chatId: opts.chatId,
    });
    return true;
  }

  const decision = await openDecision(trip.id);
  if (!decision) {
    await sendText(opts.chatId, "there isn't an open group vote rn. the organizer can start one with “japlan decide dinner | ramen | sushi”.");
    return true;
  }
  const options = await optionsFor(decision.id);

  if (command.kind === "vote") {
    const option = options.find((candidate) => candidate.option_index === command.option);
    if (!option) {
      await sendText(opts.chatId, `pick an option from ${options.map((candidate) => candidate.option_index).join(" or ")}.`);
      return true;
    }
    await recordVote(decision.id, participant.id, option.option_index);
    const votes = await votesFor(decision.id);
    await sendText(opts.chatId, `✅ ${participant.display_name} voted for ${option.label}.\n${tallyLine(tally(votes, options), options)}\nchange your vote any time with “japlan vote N”.`);
    return true;
  }
  if (command.kind === "status") {
    await sendVoteStatus({ people, decision, chatId: opts.chatId });
    return true;
  }
  if (command.kind === "remind") {
    const refusal = await authorizeOrganizer(trip, participant, people);
    if (refusal) await sendText(opts.chatId, refusal);
    else await remindDecision({ people, decision, chatId: opts.chatId });
    return true;
  }
  await closeDecision({
    trip,
    participant,
    people,
    decision,
    requestedOption: command.option,
    chatId: opts.chatId,
  });
  return true;
}

// Route option-message tapbacks before peer-claim tapbacks. Only 👍/❤️ count;
// a text vote can change the same participant's vote to any option.
export async function handleGroupDecisionReaction(data: Record<string, unknown>): Promise<boolean> {
  const messageId = typeof data.message_id === "string" ? data.message_id : null;
  if (!messageId) return false;
  const { data: optionRow, error: optionError } = await getServiceClient()
    .from("group_decision_options")
    .select("id, decision_id, option_index")
    .eq("message_id", messageId)
    .maybeSingle();
  if (optionError) throw optionError;
  if (!optionRow) return false;

  const { data: decisionRow, error: decisionError } = await getServiceClient()
    .from("group_decisions")
    .select("id, trip_id, status")
    .eq("id", (optionRow as { decision_id: string }).decision_id)
    .maybeSingle();
  if (decisionError) throw decisionError;
  if (!decisionRow || (decisionRow as { status: string }).status !== "open") return true;
  const chatId = chatIdFromData(data);
  const reactionType = typeof data.reaction_type === "string" ? data.reaction_type : "";
  const fromHandle = data.from_handle && typeof data.from_handle === "object"
    ? (data.from_handle as { handle?: unknown }).handle
    : typeof data.from === "string" ? data.from : null;
  if (!chatId || typeof fromHandle !== "string") return true;

  const trip = await getTripByChatId(chatId);
  if (!trip || trip.id !== (decisionRow as { trip_id: string }).trip_id) return true;
  const participant = await findParticipantOnTrip(trip.id, fromHandle);
  if (!participant) return true;
  if (reactionType !== "like" && reactionType !== "love") return true;
  await recordVote(
    (decisionRow as { id: string }).id,
    participant.id,
    (optionRow as { option_index: number }).option_index,
  );
  console.info("[japlan.group_decision] reaction_vote", {
    tripId: trip.id,
    option: (optionRow as { option_index: number }).option_index,
  });
  return true;
}

// Called by the existing daily-board tick. A vote gets its first automatic
// reminder after 12 hours, then at most once per 24 hours while people wait.
export async function remindOpenGroupDecisions(trip: TripRow, now: Date): Promise<void> {
  const { data, error } = await getServiceClient()
    .from("group_decisions")
    .select("id, trip_id, prompt, status, created_by, selected_option, created_at, closed_at, last_reminded_at")
    .eq("trip_id", trip.id)
    .eq("status", "open");
  if (error) throw error;
  const people = await listParticipants(trip.id);
  for (const decision of (data ?? []) as GroupDecision[]) {
    const createdAt = Date.parse(decision.created_at);
    const remindedAt = decision.last_reminded_at ? Date.parse(decision.last_reminded_at) : null;
    if (!Number.isFinite(createdAt) || now.getTime() - createdAt < 12 * 60 * 60 * 1000) continue;
    if (remindedAt !== null && now.getTime() - remindedAt < 24 * 60 * 60 * 1000) continue;
    const votes = await votesFor(decision.id);
    const waiting = pendingNames(people, votes);
    if (waiting.length === 0) continue;
    await sendText(trip.linq_chat_id, `⏳ quick nudge on “${decision.prompt}”: still waiting on ${waiting.join(", ")}. vote with “japlan vote 1”, react to an option, or sit this one out — silence abstains.`);
    const { error: updateError } = await getServiceClient()
      .from("group_decisions")
      .update({ last_reminded_at: now.toISOString() })
      .eq("id", decision.id)
      .eq("status", "open");
    if (updateError) throw updateError;
  }
}
