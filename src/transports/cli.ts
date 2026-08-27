import * as readline from "node:readline";
import type { PushOptions, Transport } from "../core/types.js";
import { truncate } from "../core/util.js";

/**
 * Terminal transport — full chat without any tokens/secrets.
 * Buttons render as numbered options; type the number to act.
 */
export class CliTransport implements Transport {
  readonly name = "cli";
  private onMessageCb: ((text: string, chatId: string) => Promise<void>) | null = null;
  private onActionCb: ((action: string, chatId: string) => Promise<void>) | null = null;
  private pendingCard: { buttons: { label: string; action: string }[] } | null = null;
  private rl: readline.Interface | null = null;

  onMessage(cb: (text: string, chatId: string) => Promise<void>): void {
    this.onMessageCb = cb;
  }

  onAction(cb: (action: string, chatId: string) => Promise<void>): void {
    this.onActionCb = cb;
  }

  async start(): Promise<void> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this.rl = rl;
    console.log(`\n┌─ pibot cli — type /help for commands, /quit to exit`);
    rl.setPrompt("you › ");
    rl.prompt();
    rl.on("line", async (line) => {
      const text = line.trim();
      if (!text) {
        rl.prompt();
        return;
      }
      // numbered answer to a pending card
      if (this.pendingCard && /^\d+$/.test(text)) {
        const idx = parseInt(text, 10) - 1;
        const btn = this.pendingCard.buttons[idx];
        this.pendingCard = null;
        if (btn && this.onActionCb) {
          console.log();
          await this.onActionCb(btn.action, "local");
        }
        rl.prompt();
        return;
      }
      this.pendingCard = null;
      console.log();
      if (this.onMessageCb) await this.onMessageCb(text, "local");
      rl.prompt();
    });
    rl.on("close", () => process.exit(0));
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }

  async push(chatId: string, opts: PushOptions): Promise<void> {
    if (opts.text) console.log(`${" ".repeat(0)}agent › ${opts.text.replace(/\*\*/g, "")}\n`);
    if (opts.card?.buttons.length) {
      this.pendingCard = { buttons: opts.card.buttons };
      const line = opts.card.buttons.map((b, i) => `[${i + 1}] ${b.label}`).join("  ");
      console.log(`choose › ${line}   (or type anything else)\n`);
    }
  }

  async notifyError(chatId: string, message: string): Promise<void> {
    console.log(`⚠︎  ${truncate(message, 300)}\n`);
  }

  setTyping(chatId: string, on: boolean): void {
    if (on) process.stdout.write("…thinking\n");
  }
}