import { z } from "zod";
import { scorePhotoFidelity } from "@/lib/llm/gemini";
import type { AgentTool, AgentToolResult } from "../types";

export const VerifyTaskPhotoArgsSchema = z.object({
  title: z.string().min(1).max(300),
  photo_bonus_max: z.number().int().min(0).max(40).optional(),
});

export const verifyTaskPhotoTool: AgentTool = {
  name: "verify_task_photo",
  description:
    "Score whether the inbound photo plausibly relates to a task title. Chat only, and only when a photo is attached. Does not award points; claims own payout.",
  parameters: VerifyTaskPhotoArgsSchema,
  // Lab has no inbound photo path.
  capabilities: "webhook",
  async execute(raw, ctx): Promise<AgentToolResult> {
    const args = VerifyTaskPhotoArgsSchema.parse(raw);
    const photo = ctx.photo ?? null;
    if (!photo) {
      return { result: { ok: false, reason: "no_photo" } };
    }
    const scored = await scorePhotoFidelity({
      provider: ctx.provider,
      title: args.title,
      photoBonusMax: args.photo_bonus_max ?? 5,
      image: photo,
    });
    if (!scored) {
      return { result: { ok: false, reason: "unreadable" } };
    }
    return {
      result: {
        ok: true,
        shows_task: scored.shows_task,
        fidelity: scored.fidelity,
        seen: scored.seen,
        note: "Evidence only; awarding points is handled by the claim path.",
      },
    };
  },
};
