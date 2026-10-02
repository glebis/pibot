// Read-only CredentialStore over a pi auth.json file (default: ~/.pi/agent/auth.json),
// so the satellite resolves the SAME credentials the bot already uses.
//
// Deliberately read-only: refresh/logins stay with the bot's ModelRuntime and the
// @earendil-works/pi-ai CLI. Reads parse the JSON; `list` returns metadata only
// (never secrets); modify/delete throw.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

export function defaultAuthJsonPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "auth.json");
}

function readAll(authPath: string): Record<string, Credential> {
  return JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<string, Credential>;
}

export class ReadOnlyAuthJsonStore implements CredentialStore {
  constructor(private readonly authPath: string = defaultAuthJsonPath()) {}

  async read(providerId: string): Promise<Credential | undefined> {
    return readAll(this.authPath)[providerId];
  }

  /** Metadata only: per-provider credential type — never credential values. */
  async list(): Promise<ReadonlyArray<CredentialInfo>> {
    const data = readAll(this.authPath);
    return Object.entries(data).map(([providerId, c]) => ({
      providerId,
      type: (c as { type?: string }).type ?? "unknown",
    })) as ReadonlyArray<CredentialInfo>;
  }

  async modify(_providerId: string, _fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    throw new Error("read-only credentials: logins and refreshes belong to the bot/cli, not the satellite");
  }

  async delete(_providerId: string): Promise<void> {
    throw new Error("read-only credentials: logins and refreshes belong to the bot/cli, not the satellite");
  }
}