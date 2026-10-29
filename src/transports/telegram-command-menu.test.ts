import { describe, expect, it, vi } from "vitest";
import { TelegramTransport } from "./telegram.js";

async function register(allowed: string[], memberGroups?: string[]) {
  const transport = new TelegramTransport("123:test", allowed, { memberGroups });
  const setMyCommands = vi.fn().mockResolvedValue(true);
  const internal = transport as unknown as {
    bot: { api: { setMyCommands: typeof setMyCommands } };
    registerCommandMenus(): Promise<void>;
  };
  internal.bot = { api: { setMyCommands } };
  await internal.registerCommandMenus();
  return setMyCommands.mock.calls;
}

describe("Telegram command menu audience", () => {
  it("replaces broad participant scopes with only public lab commands", async () => {
    const calls = await register(["100000001", "-100123"], ["-100123"]);
    expect(calls).toHaveLength(4);
    const publicNames = ["start", "menu", "recommendations", "homework", "prompt", "skills", "install", "models", "subscribe", "unsubscribe", "help"];
    for (const [index, type] of ["default", "all_private_chats", "all_group_chats"].entries()) {
      expect(calls[index][1]).toEqual({ scope: { type } });
      expect(calls[index][0].map((command: { command: string }) => command.command)).toEqual(publicNames);
    }
    expect(calls[3][1]).toEqual({ scope: { type: "chat", chat_id: 100000001 } });
    const adminNames = calls[3][0].map((command: { command: string }) => command.command);
    expect(adminNames).toEqual(expect.arrayContaining([...publicNames, "agents", "agent", "newagent", "goal", "status", "evolve", "labtest"]));
    expect(new Set(adminNames).size).toBe(adminNames.length);
  });

  it("never gives group or invalid allowlist entries an administrator menu", async () => {
    const calls = await register(["-100123", "0", "@owner", "1.2", "9007199254740992"], ["-100123"]);
    expect(calls).toHaveLength(3);
  });

  it("preserves the existing menu for owner-only bots", async () => {
    const calls = await register(["100000001"]);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBeUndefined();
    expect(calls[0][0].map((command: { command: string }) => command.command)).toContain("agents");
    expect(calls[0][0].map((command: { command: string }) => command.command)).not.toContain("labtest");
  });
});
