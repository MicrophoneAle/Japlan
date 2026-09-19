import { loadEnvConfig } from "@next/env";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scorePhotoFidelity } from "../lib/llm/gemini";
import { prepareForVision, sniffImageMime } from "../lib/game/image-hash";

// Runs the real vision check (live Gemini) over photo fixtures with expected
// verdicts and prints the distribution. Dev only; a few Gemini calls per case.
//   npx tsx scripts/vision-fixtures.ts [--runs 3] [--extra more-cases.json]
// --extra has the same shape as vision-fixtures.json; its photo values may be
// local paths, for private photos that must not be committed.

loadEnvConfig(process.cwd(), true);

type Fixtures = {
  photos: Record<string, string>;
  cases: { photo: string; task: string; expect: boolean }[];
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const runs = Number(arg("--runs") ?? 1);
const cacheDir = path.join(process.cwd(), ".vision-fixtures");

async function photoBytes(key: string, src: string): Promise<Buffer> {
  if (!/^https?:/.test(src)) return readFileSync(path.resolve(src));
  mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, key);
  if (!existsSync(file)) {
    const res = await fetch(src, { headers: { "user-agent": "japlan-vision-fixtures/0.1" } });
    if (!res.ok) throw new Error(`${key}: HTTP ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return readFileSync(file);
}

async function main() {
  const base = JSON.parse(
    readFileSync(path.join(process.cwd(), "scripts", "vision-fixtures.json"), "utf8"),
  ) as Fixtures;
  const extraPath = arg("--extra");
  const extra: Fixtures = extraPath
    ? JSON.parse(readFileSync(extraPath, "utf8"))
    : { photos: {}, cases: [] };
  const photos = { ...base.photos, ...extra.photos };
  const cases = [...base.cases, ...extra.cases];

  let agree = 0;
  let total = 0;
  let failed = 0;
  const falseNo: string[] = [];
  const falseYes: string[] = [];
  const bonuses: number[] = [];
  for (const c of cases) {
    const bytes = await photoBytes(c.photo, photos[c.photo]);
    const prepared = await prepareForVision(bytes, sniffImageMime(bytes) ?? "image/jpeg");
    const image = { data: prepared.data.toString("base64"), mime: prepared.mime };
    const verdicts: string[] = [];
    let seen = "";
    for (let r = 0; r < runs; r++) {
      total += 1;
      const result = await scorePhotoFidelity({ title: c.task, photoBonusMax: 3, image }).catch(
        (err: Error) => {
          console.log(`     error: ${err.message}`);
          return null;
        },
      );
      if (!result) {
        failed += 1;
        verdicts.push("FAILED");
        continue;
      }
      seen ||= result.seen;
      if (result.shows_task === c.expect) agree += 1;
      else (c.expect ? falseNo : falseYes).push(`${c.photo} / ${c.task}`);
      if (result.shows_task) bonuses.push(result.fidelity);
      verdicts.push(result.shows_task ? `yes ${result.fidelity}` : "no");
    }
    const ok = verdicts.every((v) => v.startsWith(c.expect ? "yes" : "no"));
    console.log(
      `${ok ? "ok  " : "MISS"} ${c.photo} (${prepared.prepared ? "prepared" : `sent as ${prepared.mime}`}) expect ${c.expect ? "yes" : "no"} -> ${verdicts.join(", ")}\n     task: ${c.task}\n     seen: ${seen}`,
    );
  }
  const hist = [1, 2, 3].map((n) => `${n}:${bonuses.filter((b) => b === n).length}`).join(" ");
  console.log(
    `\nagreement ${agree}/${total} · false no ${falseNo.length} · false yes ${falseYes.length} · failed ${failed} · bonus on yes ${hist}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
