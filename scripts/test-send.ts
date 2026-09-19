import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), true);

const TO = "+19057580877";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const { sendDM, sendText, sendTyping, markRead } = await import(
    "../lib/linq/send"
  );

  const dm = await sendDM(TO, "japlan adapter test: sendDM");
  console.log("sendDM", dm);

  await sendTyping(dm.chatId, true);
  await sleep(3000);

  const text = await sendText(dm.chatId, "japlan adapter test: sendText");
  console.log("sendText", text);

  await sendTyping(dm.chatId, true);
  await sleep(2000);
  await sendTyping(dm.chatId, false);

  await markRead(text.messageId);
  console.log("markRead", text.messageId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
