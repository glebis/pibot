import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "./config.js";
import { ensureDir, hardenRuntimeDataDir, readJson } from "./core/util.js";
import { SecretStore } from "./core/secrets.js";
import { assembleRuntime, startRuntime } from "./runtime/startup.js";

async function main(): Promise<void> {
  const config = loadConfig();
  ensureDir(config.dataDir);
  hardenRuntimeDataDir(config.dataDir);

  // rotate the daemon log if it grows past 5 MB
  const daemonLog = path.join(config.dataDir, "daemon.log");
  try {
    const st = fs.statSync(daemonLog);
    if (st.size > 5 * 1024 * 1024) {
      fs.renameSync(daemonLog, daemonLog + ".old");
    }
  } catch {
    /* fresh install */
  }

  // encrypted settings (sops/age): decrypt-or-migrate at boot, fail closed
  const secretStore = new SecretStore(config.dataDir);
  await secretStore.init(readJson(config.dataDir + "/settings.json", {}));

  // single-instance guard: two processes would fight over the bot's getUpdates
  const lockFile = path.join(config.dataDir, "pibot.lock");
  if (fs.existsSync(lockFile)) {
    const pid = parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10);
    if (Number.isInteger(pid)) {
      try {
        process.kill(pid, 0); // throws if not running
        console.error(`[pibot] another instance is running (pid ${pid}) — exiting. Kill it first or delete ${lockFile}.`);
        process.exit(1);
      } catch {
        /* stale lock */
      }
    }
  }
  fs.writeFileSync(lockFile, String(process.pid));
  process.on("exit", () => {
    try {
      if (fs.readFileSync(lockFile, "utf8").trim() === String(process.pid)) fs.unlinkSync(lockFile);
    } catch {
      /* ignore */
    }
  });

  const runtime = await assembleRuntime({
    config,
    secretStore,
    cwd: process.cwd(),
    env: {
      PIBOT_MODEL_CASCADE: process.env.PIBOT_MODEL_CASCADE,
      PIBOT_REACTIONS: process.env.PIBOT_REACTIONS,
      PIBOT_WEB: process.env.PIBOT_WEB,
      PIBOT_WEB_PORT: process.env.PIBOT_WEB_PORT,
    },
  });
  await startRuntime(runtime);
}

main().catch((e) => {
  console.error("[pibot] fatal:", e);
  process.exit(1);
});
