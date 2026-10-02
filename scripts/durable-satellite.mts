// One-shot satellite entry: ask the durable satellite a question on the command line.
//
//   npx tsx scripts/durable-satellite.mts --storage-dir ./.durable-satellite \
//     --workspace /tmp/satellite-ws --ask "what files do you see?"
//
// Uses the real pi-ai provider stack (same auth store as the bot). The storage
// dir persists conversations — repeated runs keep their history and the same
// requestId replays the original answer instead of paying twice.

import * as fs from "node:fs";
import * as path from "node:path";
import { openSatellite } from "../src/durable/satellite.js";

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const storageDir = argOf("--storage-dir") ?? path.join(".durable-satellite", "storage");
const workspaceDir = argOf("--workspace") ?? process.cwd();
const ask = argOf("--ask");
if (!ask) {
  console.error("usage: --ask \"question\" [--storage-dir dir] [--workspace dir]");
  process.exit(2);
}

fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
const { createModels } = await import("@earendil-works/pi-ai");
const models = createModels(); // same credential resolution the bot uses
const provider = models.getProviders()[0];
if (!provider) {
  console.error("no providers configured — log in via the dashboard (Providers) first");
  process.exit(3);
}

const satellite = await openSatellite({ provider, workspaceDir, storageDir });
const requestId = `cli:${process.argv.includes("--again") ? "" : "once"}:${ask.slice(0, 60)}`;
console.log(await satellite.ask(ask, requestId));
process.exit(0);