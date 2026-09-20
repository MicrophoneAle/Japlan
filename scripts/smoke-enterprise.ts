/**
 * Live Enterprise smoke via vitest (tsx cannot resolve @browserbasehq/stagehand
 * package exports; vitest can). Loads .env the same way the live test does.
 *
 *   npx tsx scripts/smoke-enterprise.ts
 *   # or directly:
 *   npx vitest run lib/handlers/enterprise-rentals.live.test.ts
 */
import { spawnSync } from "node:child_process";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), true);

if (!process.env.BROWSERBASE_API_KEY) {
  console.warn(
    "WARN: BROWSERBASE_API_KEY missing; live Browserbase case will skip, offline link case still runs.",
  );
}

const result = spawnSync(
  "npx",
  ["vitest", "run", "lib/handlers/enterprise-rentals.live.test.ts", "--reporter=verbose"],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
