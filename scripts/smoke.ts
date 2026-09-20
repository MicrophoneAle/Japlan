import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { resolve } from "node:path";
import { loadEnvConfig } from "@next/env";
import { GoogleGenAI } from "@google/genai";
import Browserbase from "@browserbasehq/sdk";
import { getServiceClient } from "../lib/db/client";
import { getLastSessionId, withPage } from "../lib/browserbase/session";
import { PLACES_API_BASE, placesHeaders } from "../lib/places/foursquare";

const projectDir = process.cwd();
const { loadedEnvFiles } = loadEnvConfig(projectDir, true);

function printError(err: unknown): void {
  if (err instanceof Error) {
    console.error(err.stack ?? err.message);
    if (err.cause !== undefined) {
      console.error("cause:", inspect(err.cause, { depth: 8, colors: false }));
    }
    return;
  }
  console.error(inspect(err, { depth: 8, colors: false }));
}

function exampleEnvKeys(): string[] {
  const text = readFileSync(resolve(projectDir, ".env.example"), "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && line.includes("="))
    .map((line) => line.slice(0, line.indexOf("=")));
}

async function checkEnv(): Promise<string> {
  const files =
    loadedEnvFiles.length === 0
      ? "(none found)"
      : loadedEnvFiles.map((file) => file.path).join(", ");
  const missing = exampleEnvKeys().filter((key) => {
    const value = process.env[key];
    return value === undefined || value.trim() === "";
  });
  if (missing.length > 0) {
    throw new Error(
      `Next env files (dev): ${files}. Missing or empty: ${missing.join(", ")}`,
    );
  }
  return `Next env files (dev): ${files}`;
}

async function checkGemini(): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_FAST_MODEL;
  if (!apiKey) throw new Error("missing GEMINI_API_KEY");
  if (!model) throw new Error("missing GEMINI_FAST_MODEL");

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model,
    contents: 'Reply with the single word "ok" and nothing else.',
  });
  const text = response.text?.trim() ?? "";
  if (!text) {
    throw new Error(`empty generateContent response: ${inspect(response, { depth: 4 })}`);
  }
  return `${model} -> ${JSON.stringify(text)}`;
}

async function checkFoursquare(): Promise<string> {
  const url = new URL("/places/search", PLACES_API_BASE);
  url.searchParams.set("query", "coffee");
  url.searchParams.set("near", "Tokyo");
  url.searchParams.set("limit", "1");

  const res = await fetch(url, { headers: placesHeaders() });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${bodyText}`);
  }

  const payload = JSON.parse(bodyText) as {
    results?: Array<{
      name?: string;
      fsq_id?: string;
      fsq_place_id?: string;
    }>;
  };
  const first = payload.results?.[0];
  if (!first) {
    throw new Error(`no results: ${bodyText.slice(0, 500)}`);
  }
  const fsqId = first.fsq_id ?? first.fsq_place_id;
  const idField = first.fsq_id !== undefined ? "fsq_id" : "fsq_place_id";
  if (!first.name || !fsqId) {
    throw new Error(`first result missing name/${idField}: ${inspect(first)}`);
  }
  return `${first.name} ${idField}=${fsqId}`;
}

function supabaseOrigin(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) return "(missing SUPABASE_URL)";
  try {
    return new URL(url).origin;
  } catch {
    return "(unparseable SUPABASE_URL)";
  }
}

async function checkSupabase(): Promise<string> {
  const supabase = getServiceClient();
  const origin = supabaseOrigin();
  const marker = `smoke-${Date.now()}`;
  const inserted = await supabase
    .from("smoke_scratch")
    .insert({ marker })
    .select("id, marker")
    .single();
  if (inserted.error) {
    throw Object.assign(new Error(`insert against ${origin} failed`), {
      cause: inserted.error,
    });
  }
  if (!inserted.data) throw new Error("insert returned no row");

  const read = await supabase
    .from("smoke_scratch")
    .select("id, marker")
    .eq("id", inserted.data.id)
    .single();
  if (read.error) throw read.error;
  if (read.data?.marker !== marker) {
    throw new Error(
      `readback mismatch: inserted ${inspect(inserted.data)} read ${inspect(read.data)}`,
    );
  }

  const deleted = await supabase
    .from("smoke_scratch")
    .delete()
    .eq("id", inserted.data.id)
    .select("id")
    .single();
  if (deleted.error) throw deleted.error;

  return `round-trip ${inserted.data.id}`;
}

async function checkBrowserbase(): Promise<string> {
  const title = await withPage(async (page) => {
    await page.goto("https://example.com");
    return page.title();
  });
  const sessionId = getLastSessionId();
  if (!sessionId) throw new Error("withPage did not record a session id");

  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) throw new Error("missing BROWSERBASE_API_KEY");
  const bb = new Browserbase({ apiKey });
  const deadline = Date.now() + 15_000;
  let status = "UNKNOWN";
  while (Date.now() < deadline) {
    const session = await bb.sessions.retrieve(sessionId);
    status = session.status;
    if (status !== "RUNNING" && status !== "PENDING") break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (status === "RUNNING" || status === "PENDING") {
    throw new Error(`session ${sessionId} still ${status} after browser.close()`);
  }
  return `title=${JSON.stringify(title)} session=${sessionId} status=${status}`;
}

async function runCheck(
  name: string,
  fn: () => Promise<string>,
): Promise<boolean> {
  try {
    const detail = await fn();
    console.log(`PASS  ${name}: ${detail}`);
    return true;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    printError(err);
    return false;
  }
}

async function main(): Promise<void> {
  const results = [
    await runCheck("env", checkEnv),
    await runCheck("Gemini", checkGemini),
    await runCheck("Foursquare", checkFoursquare),
    await runCheck("Supabase", checkSupabase),
    await runCheck("Browserbase", checkBrowserbase),
  ];
  if (results.some((ok) => !ok)) process.exitCode = 1;
}

main().catch((err) => {
  printError(err);
  process.exitCode = 1;
});
