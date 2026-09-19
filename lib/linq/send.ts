export type SendMessageInput = {
  chatId: string;
  text: string;
};

export async function sendTypingIndicator(chatId: string): Promise<void> {
  void chatId;
  throw new Error("not implemented");
}

export async function sendReadReceipt(chatId: string): Promise<void> {
  void chatId;
  throw new Error("not implemented");
}

export async function sendMessage(input: SendMessageInput): Promise<void> {
  void input;
  throw new Error("not implemented");
}
