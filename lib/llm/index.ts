// TODO: plan uses Msg[] but does not define Msg.
export type Msg = {
  role: string;
  content: string;
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
}
