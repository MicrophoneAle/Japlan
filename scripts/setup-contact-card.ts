// One-time setup: register "Japlan" + the logo as the Name & Photo for
// LINQ_FROM_NUMBER (iMessage Name and Photo Sharing), so a chat that gets it
// shared (chats.shareContactCard, wired into bootstrap — see
// shareContactCardSafely in lib/linq/send.ts) shows a real contact instead of
// a bare number. Run once: `npx tsx scripts/setup-contact-card.ts`.
//
// The logo never leaves Linq's own infrastructure: it's uploaded via the
// attachments API to get a cdn.linqapp.com URL, so this doesn't depend on the
// app being deployed anywhere.
//
// Registering the card does NOT retroactively refresh a chat that already
// exists: iMessage Name and Photo Sharing only updates a chat when it is
// actively shared into it. shareContactCardSafely only fires on a brand-new
// chat's first message, so an existing conversation (e.g. your own test
// thread from before this was set up right) keeps showing whatever it saw
// before until it gets a fresh share. Pass that chat's id as an argument to
// push one immediately: `npx tsx scripts/setup-contact-card.ts <chatId>`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvConfig } from "@next/env";
import { ConflictError, type LinqAPIV3 } from "@linqapp/sdk";

loadEnvConfig(process.cwd(), true);

const LOGO_PATH = resolve(process.cwd(), "public/assets/japlan-contact-card.png");
const FIRST_NAME = "Japlan";

async function uploadLogo(): Promise<string> {
  const { getLinqClient } = await import("../lib/linq/client");
  const client = getLinqClient();
  const bytes = readFileSync(LOGO_PATH);

  const attachment = await client.attachments.create({
    content_type: "image/png",
    filename: "japlan-contact-card.png",
    size_bytes: bytes.byteLength,
  });
  const upload = await fetch(attachment.upload_url, {
    method: attachment.http_method,
    headers: attachment.required_headers,
    body: bytes,
  });
  if (!upload.ok) {
    throw new Error(`attachment upload failed: ${upload.status} ${await upload.text()}`);
  }
  console.log(`uploaded logo -> ${attachment.download_url}`);
  return attachment.download_url;
}

async function main(): Promise<void> {
  const fromNumber = process.env.LINQ_FROM_NUMBER;
  if (!fromNumber) throw new Error("missing LINQ_FROM_NUMBER");
  const reshareChatId = process.argv[2]?.trim() || null;

  const { getLinqClient } = await import("../lib/linq/client");
  const client = getLinqClient();

  const before = await client.contactCard.retrieve({ phone_number: fromNumber });
  console.log("current card(s) for this number:", JSON.stringify(before.contact_cards, null, 2));

  const imageUrl = await uploadLogo();

  try {
    const card = await client.contactCard.create({
      first_name: FIRST_NAME,
      phone_number: fromNumber,
      image_url: imageUrl,
    });
    console.log("contact card created:", card);
  } catch (err) {
    if (err instanceof ConflictError) {
      // Already active: create() never overwrites (see contact-card.d.ts).
      // Move the photo/name with update() instead, and show what's live now.
      console.log(`a contact card is already active for ${fromNumber}. updating it instead.`);
      const card = await client.contactCard.update({
        phone_number: fromNumber,
        first_name: FIRST_NAME,
        image_url: imageUrl,
      });
      console.log("contact card updated:", card);
      await confirm(client, fromNumber, reshareChatId);
      return;
    }
    throw err;
  }
  await confirm(client, fromNumber, reshareChatId);
}

async function confirm(
  client: LinqAPIV3,
  fromNumber: string,
  reshareChatId: string | null,
): Promise<void> {
  const after = await client.contactCard.retrieve({ phone_number: fromNumber });
  console.log("card(s) after the write:", JSON.stringify(after.contact_cards, null, 2));

  if (reshareChatId) {
    await client.chats.shareContactCard(reshareChatId);
    console.log(`shared into ${reshareChatId}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
