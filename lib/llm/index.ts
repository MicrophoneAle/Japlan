// TODO: plan uses Msg[] but does not define Msg.
export type Msg = {
  role: string;
  content: string;
};

export type ToolCallPart = {
  id?: string;
  name: string;
  args: Record<string, unknown>;
  // Gemini 3 signs each function call and rejects a replayed history whose
  // call lacks its signature (400 "missing a thought_signature"). Opaque;
  // carry it from the response back into the next request untouched.
  thoughtSignature?: string;
};

export type ToolContentPart =
  | { text: string }
  | { functionCall: ToolCallPart }
  | { functionResponse: { id?: string; name: string; response: Record<string, unknown> } };

export type ToolContent = {
  role: "user" | "model";
  parts: ToolContentPart[];
};

export type ToolTurn = {
  text: string;
  functionCalls: ToolCallPart[];
};

export interface LLMProvider {
  complete(opts: {
    system: string;
    messages: Msg[];
    schema?: object;
    images?: { data: string; mime: string }[];
    tier: "fast" | "smart";
    thinkingBudget?: number;
  }): Promise<string>;
  completeTurn?(opts: {
    system: string;
    contents: ToolContent[];
    tools: { name: string; description: string; parameters: object }[];
    toolMode: "auto" | "none";
    tier: "fast" | "smart";
    thinkingBudget?: number;
  }): Promise<ToolTurn>;
}
