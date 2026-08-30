import { SecretStore } from "../src/core/secrets.js";
import { TelegramTransport } from "../src/transports/telegram.js";
import { errorMessage } from "../src/core/util.js";

const s = new SecretStore("./data");
await s.init({});
const settings = s.get();
const managerToken = settings.telegram?.token;
if (!managerToken) { console.error("no manager token in settings"); process.exit(1); }

const t = new TelegramTransport(managerToken, [], { openWhenEmpty: false });
const botName = await t.verify();
const token = await t.getManagedBotToken(8622137146);
if (!token) { console.error("token fetch returned empty"); process.exit(1); }

const cur = s.get();
await s.save({
  telegram: {
    ...cur.telegram,
    subBots: {
      ...(cur.telegram?.subBots ?? {}),
      "pibot-dev": { token, username: "pimother_pibot_dev_bot" },
    },
  },
});
await t.setManagedBotAccessSettings(8622137146, true).catch(() => {});
console.log("manager:", botName, "| token saved for pibot-dev (never printed) | restricted: yes");
process.exit(0);
