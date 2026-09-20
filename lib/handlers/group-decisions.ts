import { getServiceClient } from "@/lib/db/client";
import type { ParticipantRow, TripRow } from "@/lib/db/types";
import { defaultWakeKeyword, stripWakeKeyword, wakeKeywordRe } from "@/lib/game/addressing";
import {
  findParticipantOnTrip,
  getTripByChatId,
  listParticipants,
} from "@/lib/handlers/bootstrap";
import { chatIdFromData } from "@/lib/linq/payload";
import { getLinqClient } from "@/lib/linq/client";
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
  poll_option_id?: string | null;
};

type DecisionVote = { participant_id: string; option_index: number };

type DecisionCommand =
  | { kind: "create"; prompt: string; options: string[] }
  | { kind: "text_vote" }
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

  if (/^vote\s+\d+$/i.test(body)) return { kind: "text_vote" };
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

function sameVoterHandle(a: string, b: string): boolean {
  const normalized = (value: string) => value.replace(/\D/g, "") || value.trim().toLowerCase();
  return normalized(a) === normalized(b);
}

function pendingNames(people: ParticipantRow[], votes: DecisionVote[]): string[] {
  const voted = new Set(votes.map((vote) => vote.participant_id));
  const pending = people.filter((person) => !voted.has(person.id));
  const names = pending.map((person) => person.display_name?.trim() || person.phone);
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return pending.map((person, index) => {
    const name = names[index];
    return (counts.get(name) ?? 0) > 1 ? `${name} (${person.phone.slice(-4)})` : name;
  });
}

function votesFromRoster(people: ParticipantRow[], votes: DecisionVote[]): DecisionVote[] {
  const participantIds = new Set(people.map((person) => person.id));
  return votes.filter((vote) => participantIds.has(vote.participant_id));
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
  // Reaction voting remains one-choice: selecting another option replaces the
  // previous ballot. Native polls use a separate per-option upsert below.
  const { error: deleteError } = await getServiceClient()
    .from("group_decision_votes")
    .delete()
    .eq("decision_id", decisionId)
    .eq("participant_id", participantId);
  if (deleteError) throw deleteError;
  const { error } = await getServiceClient().from("group_decision_votes").insert({
    decision_id: decisionId,
    participant_id: participantId,
    option_index: optionIndex,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

function isUnsupportedPollError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const apiError = error as { code?: unknown; message?: unknown };
  // Linq uses these for an iMessage-only message type sent to an unsupported
  // recipient/service. Other failures must surface instead of silently posting
  // a second, potentially duplicate set of choices.
  if (apiError.code === 2018 || apiError.code === 4005) return true;
  const message = typeof apiError.message === "string" ? apiError.message : "";
  return /poll.{0,40}(unsupported|not supported)|(?:unsupported|not supported).{0,40}poll/i.test(message);
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
  return "🗳️ group decisions happen in the trip chat so everyone sees the same choices. vote there in the poll, or use the option reactions if polls aren’t supported.";
}

function commandHelpLine(): string {
  return [
    "try: japlan decide dinner | ramen | sushi",
    "on iMessage, select every poll option you’d be happy with. if polls aren’t supported, tap ❤️ or 👍 on an option message; reaction votes are one choice. silence abstains.",
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
  if (!opts.prompt || opts.choices.length < 2 || opts.choices.length > 5 || opts.choices.some((choice) => !choice)) {
    await sendText(opts.chatId, commandHelpLine());
    return;
  }
  const refusal = await authorizeOrganizer(opts.trip, opts.participant, opts.people);
  if (refusal) {
    await sendText(opts.chatId, refusal);
    return;
  }
  const existing = await openDecision(opts.trip.id);
  if (existing) {
    await sendText(opts.chatId, `there's already a group vote open: “${existing.prompt}”. close that one before starting another.`);
    return;
  }

  const { data, error } = await getServiceClient()
    .from("group_decisions")
    .insert({
      trip_id: opts.trip.id,
      prompt: opts.prompt,
      created_by: opts.participant.id,
      status: "open",
      voting_mode: "reactions",
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") {
      await sendText(opts.chatId, "there's already a group vote open. close it before starting another.");
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

  // Linq polls have no title field, so send the prompt as its own message.
  await sendText(opts.chatId, `🗳️ ${opts.prompt}\n\nPick every option you’d be happy with. The organizer makes the final call.`);
  try {
    const poll = await getLinqClient().chats.polls.create(opts.chatId, {
      poll: {
        options: opts.choices.map((text) => ({ text })),
        idempotency_key: `japlan-group-decision-${decisionId}`,
      },
    });
    if (poll.poll.options.length !== opts.choices.length) {
      throw new Error("Linq poll response did not include the expected options");
    }
    const { error: decisionUpdateError } = await getServiceClient()
      .from("group_decisions")
      .update({ poll_message_id: poll.message_id, voting_mode: "native_poll" })
      .eq("id", decisionId);
    if (decisionUpdateError) throw decisionUpdateError;
    for (let index = 0; index < opts.choices.length; index += 1) {
      const { error: optionUpdateError } = await getServiceClient()
        .from("group_decision_options")
        .update({ poll_option_id: poll.poll.options[index].option_id })
        .eq("decision_id", decisionId)
        .eq("option_index", index + 1);
      if (optionUpdateError) throw optionUpdateError;
    }
    return;
  } catch (error) {
    if (!isUnsupportedPollError(error)) throw error;
    console.info("[japlan.group_decision] native_poll_unsupported", { tripId: opts.trip.id });
  }

  // SMS/RCS and unsupported recipients keep the existing tapback ballot.
  for (let index = 0; index < opts.choices.length; index += 1) {
    const sent = await sendText(opts.chatId, `${OPTION_EMOJI[index]} ${opts.choices[index]}\ntap ❤️ or 👍 here to vote; tap another option to change your vote.`);
    const { error: messageError } = await getServiceClient()
      .from("group_decision_options")
      .update({ message_id: sent.messageId })
      .eq("decision_id", decisionId)
      .eq("option_index", index + 1);
    if (messageError) throw messageError;
  }
}

// Handle a Linq native-poll vote event. True means its poll belongs to a Japlan
// decision, even when closed or malformed; callers can then stop other routes.
export async function handleGroupDecisionPollVote(
  eventType: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  if (eventType !== "poll.vote.added" && eventType !== "poll.vote.removed") return false;
  const messageId = typeof data.message_id === "string" ? data.message_id : null;
  const optionId = typeof data.option_id === "string" ? data.option_id : null;
  if (!messageId || !optionId) return false;

  const { data: decisionData, error: decisionError } = await getServiceClient()
    .from("group_decisions")
    .select("id, trip_id, status, poll_message_id")
    .eq("poll_message_id", messageId)
    .maybeSingle();
  if (decisionError) throw decisionError;
  if (!decisionData) return false;
  const decision = decisionData as { id: string; trip_id: string; status: string; poll_message_id: string };
  if (decision.status !== "open") return true;

  const { data: optionData, error: optionError } = await getServiceClient()
    .from("group_decision_options")
    .select("option_index")
    .eq("decision_id", decision.id)
    .eq("poll_option_id", optionId)
    .maybeSingle();
  if (optionError) throw optionError;
  if (!optionData) return true;

  const chat = data.chat && typeof data.chat === "object" ? data.chat as { id?: unknown } : null;
  const chatId = typeof chat?.id === "string" ? chat.id : null;
  const senderHandle = data.sender_handle && typeof data.sender_handle === "object"
    ? (data.sender_handle as { handle?: unknown }).handle
    : null;
  if (!chatId || typeof senderHandle !== "string") return true;
  const trip = await getTripByChatId(chatId);
  if (!trip || trip.id !== decision.trip_id) return true;
  const participant = await findParticipantOnTrip(trip.id, senderHandle);
  if (!participant) return true;

  const optionIndex = (optionData as { option_index: number }).option_index;
  // Webhook deliveries may race. Read the poll's current state so an older
  // add event cannot undo a newer removal (or vice versa).
  const currentPoll = await getLinqClient().messages.poll.retrieve(messageId);
  const currentOption = currentPoll.poll.options.find((option) => option.option_id === optionId);
  if (!currentOption) return true;
  const selected = currentOption.voters.some((voter) =>
    typeof voter.handle === "string" && sameVoterHandle(voter.handle, senderHandle),
  );
  const votes = getServiceClient().from("group_decision_votes");
  if (selected) {
    const { error } = await votes.upsert(
      {
        decision_id: decision.id,
        participant_id: participant.id,
        option_index: optionIndex,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "decision_id,participant_id,option_index" },
    );
    if (error) throw error;
  } else {
    const { error } = await votes
      .delete()
      .eq("decision_id", decision.id)
      .eq("participant_id", participant.id)
      .eq("option_index", optionIndex);
    if (error) throw error;
  }
  return true;
}

async function sendVoteStatus(opts: {
  people: ParticipantRow[];
  decision: GroupDecision;
  chatId: string;
}): Promise<void> {
  const [options, rawVotes] = await Promise.all([optionsFor(opts.decision.id), votesFor(opts.decision.id)]);
  const votes = votesFromRoster(opts.people, rawVotes);
  const waiting = pendingNames(opts.people, votes);
  const lines = [`🗳️ ${opts.decision.prompt}`, tallyLine(tally(votes, options), options)];
  lines.push(waiting.length > 0 ? `⏳ not voted yet: ${waiting.join(", ")}` : "✅ everyone has voted");
  lines.push("silence counts as abstaining. only the organizer can close the vote.");
  await sendText(opts.chatId, lines.join("\n"));
}

async function remindDecision(opts: {
  people: ParticipantRow[];
  decision: GroupDecision;
  chatId: string;
}): Promise<void> {
  const rawVotes = await votesFor(opts.decision.id);
  const votes = votesFromRoster(opts.people, rawVotes);
  const waiting = pendingNames(opts.people, votes);
  if (waiting.length === 0) {
    await sendText(opts.chatId, `✅ everyone's weighed in on “${opts.decision.prompt}”. organizer can close it with “japlan close vote”.`);
    return;
  }
  await sendText(opts.chatId, `⏳ quick nudge on “${opts.decision.prompt}”: not voted yet: ${waiting.join(", ")}. vote in the poll (or tap ❤️/👍 on an option if polls aren’t supported); silence counts as abstaining.`);
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
  const [options, rawVotes] = await Promise.all([optionsFor(opts.decision.id), votesFor(opts.decision.id)]);
  const votes = votesFromRoster(opts.people, rawVotes);
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
    `✅ vote closed: ${choice.label}${waiting.length > 0 ? `\nnot voted: ${waiting.join(", ")}; silence counted as abstaining.` : ""}`,
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

  if (command.kind === "text_vote") {
    await sendText(opts.chatId, "vote in the group poll by selecting every option you’d accept. if the chat is using reaction voting, tap ❤️ or 👍 on one option; tap another to change your choice.");
    return true;
  }

  const decision = await openDecision(trip.id);
  if (!decision) {
    await sendText(opts.chatId, "there isn't an open group vote rn. the organizer can start one with “japlan decide dinner | ramen | sushi”.");
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
// tapping another option replaces the participant's existing ballot.
export async function handleGroupDecisionReaction(
  data: Record<string, unknown>,
  action: "added" | "removed" = "added",
): Promise<boolean> {
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
  const decisionId = (decisionRow as { id: string }).id;
  const optionIndex = (optionRow as { option_index: number }).option_index;
  if (action === "added") {
    await recordVote(decisionId, participant.id, optionIndex);
  } else {
    const { data: currentVote, error: voteError } = await getServiceClient()
      .from("group_decision_votes")
      .select("option_index")
      .eq("decision_id", decisionId)
      .eq("participant_id", participant.id)
      .maybeSingle();
    if (voteError) throw voteError;
    // A late removal from the previous option must not erase a newer vote.
    if ((currentVote as { option_index: number } | null)?.option_index === optionIndex) {
      const { error } = await getServiceClient()
        .from("group_decision_votes")
        .delete()
        .eq("decision_id", decisionId)
        .eq("participant_id", participant.id)
        .eq("option_index", optionIndex);
      if (error) throw error;
    }
  }
  console.info("[japlan.group_decision] reaction_vote", {
    tripId: trip.id,
    action,
    option: optionIndex,
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
    const votes = votesFromRoster(people, await votesFor(decision.id));
    const waiting = pendingNames(people, votes);
    if (waiting.length === 0) continue;
    await sendText(trip.linq_chat_id, `⏳ quick nudge on “${decision.prompt}”: not voted yet: ${waiting.join(", ")}. vote in the poll (or tap ❤️/👍 on an option if polls aren’t supported); silence counts as abstaining.`);
    const { error: updateError } = await getServiceClient()
      .from("group_decisions")
      .update({ last_reminded_at: now.toISOString() })
      .eq("id", decision.id)
      .eq("status", "open");
    if (updateError) throw updateError;
  }
}
