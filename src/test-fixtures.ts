/**
 * Shared fake identities for tests. Never use a real chat or user ID here:
 * the repository is public. The value keeps the real shape (positive integer,
 * no leading zero) because chat IDs are checked with /^[1-9]\d*$/.
 */
export const OWNER_CHAT_ID = "100000001";

/** Canonical chat key: `telegram:<id>` for the main bot, `telegram:<agent>:<id>` for a sub-bot. */
export function ownerChatKey(agent?: string): string {
  return agent ? `telegram:${agent}:${OWNER_CHAT_ID}` : `telegram:${OWNER_CHAT_ID}`;
}
