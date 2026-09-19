import { getServiceClient } from "@/lib/db/client";

// Every message in and out, per chat. The context every conversational call
// reads: the last 10-15 lines of THIS chat, the bot's own replies included.
// (The events table held only inbound messages, mixed across every chat, and
// was cut off at the newest 80 events overall, so a busy moment elsewhere
// left a chat with no context at all.)

export type TranscriptLine = {
  role: "user" | "bot";
  sender: string | null;
  text: string;
  at: string;
};

export const TRANSCRIPT_LIMIT = 15;

// Never throws: losing one transcript line must not lose the message.
export async function recordMessage(opts: {
  chatId: string;
  role: "user" | "bot";
  senderHandle?: string | null;
  senderName?: string | null;
  text: string;
}): Promise<void> {
  if (!opts.chatId || !opts.text.trim()) return;
  try {
    const { error } = await getServiceClient().from("chat_messages").insert({
      chat_id: opts.chatId,
      role: opts.role,
      sender_handle: opts.senderHandle ?? null,
      sender_name: opts.senderName ?? null,
      text: opts.text.slice(0, 2000),
    });
    if (error) console.error("[japlan.transcript] record failed", { chatId: opts.chatId, error });
  } catch (err) {
    console.error("[japlan.transcript] record failed", { chatId: opts.chatId, err });
  }
}

export async function recentMessages(chatId: string, limit = TRANSCRIPT_LIMIT): Promise<TranscriptLine[]> {
  const { data, error } = await getServiceClient()
    .from("chat_messages")
    .select("role, sender_name, text, created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as { role: "user" | "bot"; sender_name: string | null; text: string; created_at: string }[])
    .map((row) => ({ role: row.role, sender: row.sender_name, text: row.text, at: row.created_at }))
    .reverse();
}

// "mike: are we doing the ramen thing\njaplan: A2 is still open..."
export function transcriptText(lines: TranscriptLine[]): string {
  return lines.map((l) => `${l.role === "bot" ? "japlan" : (l.sender ?? "someone")}: ${l.text}`).join("\n");
}
