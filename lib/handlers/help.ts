import { allowsOutbound } from "@/lib/game/addressing";
import { helpText } from "@/lib/game/copy";
import { sendText } from "@/lib/linq/send";

type SendFn = (chatId: string, text: string) => Promise<{ messageId: string }>;

export async function sendHelpGuide(opts: {
  chatId: string;
  isDm: boolean;
  send?: SendFn;
  ambientRepliesInWindow?: number;
  ambientCap?: number;
}): Promise<boolean> {
  const allowed = allowsOutbound({
    kind: "help",
    repliesInWindow: opts.ambientRepliesInWindow ?? 0,
    cap: opts.ambientCap ?? 0,
  });
  if (!allowed) return false;
  const send = opts.send ?? sendText;
  await send(opts.chatId, helpText(opts.isDm));
  return true;
}
