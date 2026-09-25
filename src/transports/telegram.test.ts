import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InputFile } from "grammy";
import type { InputProfilePhoto } from "grammy/types";
import { TelegramDuplicateGuard, TelegramTransport, telegramRetryAfterMs, replyContextFrom, extFromMime, telegramMediaSpec, serviceMessageKind, toTelegramHtml } from "./telegram.js";

describe("TelegramDuplicateGuard", () => {
  it("suppresses an identical payload to the same chat inside the window", () => {
    const guard = new TelegramDuplicateGuard(30_000);
    expect(guard.shouldSend("42", "same payload", 1_000)).toBe(true);
    guard.markSent("42", "same payload", 1_000);
    expect(guard.shouldSend("42", "same payload", 2_000)).toBe(false);
  });

  it("does not poison a retry when the network attempt failed", () => {
    const guard = new TelegramDuplicateGuard(30_000);
    expect(guard.shouldSend("42", "retry me", 1_000)).toBe(true);
    expect(guard.shouldSend("42", "retry me", 2_000)).toBe(true);
    guard.markSent("42", "retry me", 2_000);
    expect(guard.shouldSend("42", "retry me", 3_000)).toBe(false);
  });

  it("allows distinct payloads and the same payload in another chat", () => {
    const guard = new TelegramDuplicateGuard(30_000);
    guard.markSent("42", "first", 1_000);
    expect(guard.shouldSend("42", "second", 2_000)).toBe(true);
    expect(guard.shouldSend("84", "first", 2_000)).toBe(true);
  });

  it("allows the same payload again after the window", () => {
    const guard = new TelegramDuplicateGuard(30_000);
    guard.markSent("42", "repeat later", 1_000);
    expect(guard.shouldSend("42", "repeat later", 31_001)).toBe(true);
  });
});

describe("telegramRetryAfterMs", () => {
  it("extracts Telegram's 429 retry_after delay and ignores other failures", () => {
    expect(telegramRetryAfterMs({ error_code: 429, parameters: { retry_after: 3 } })).toBe(3_000);
    expect(telegramRetryAfterMs({ error_code: 500, parameters: { retry_after: 3 } })).toBeNull();
    expect(telegramRetryAfterMs(new Error("offline"))).toBeNull();
  });
});

describe("serviceMessageKind", () => {
  it("detects managed-bot creation service messages (t.me/newbot flow)", () => {
    expect(serviceMessageKind({ message_id: 7, managed_bot_created: { bot: { id: 9, username: "sub_bot", first_name: "Sub" } } })).toBe("managed_bot_created");
  });

  it("detects other service messages (chat lifecycle, payments)", () => {
    expect(serviceMessageKind({ message_id: 8, group_chat_created: true })).toBe("group_chat_created");
    expect(serviceMessageKind({ message_id: 9, new_chat_members: [{ id: 1, first_name: "x" }] })).toBe("new_chat_members");
    expect(serviceMessageKind({ message_id: 10, successful_payment: {} })).toBe("successful_payment");
    expect(serviceMessageKind({ message_id: 11, pinned_message: { message_id: 1 } })).toBe("pinned_message");
  });

  it("does not misclassify user content or unprocessable media as service messages", () => {
    expect(serviceMessageKind({ message_id: 12, text: "hello" })).toBeUndefined();
    expect(serviceMessageKind({ message_id: 13, voice: { file_id: "f", duration: 1 } })).toBeUndefined();
    expect(serviceMessageKind({ message_id: 14, photo: [{ file_id: "f" }] })).toBeUndefined();
    expect(serviceMessageKind({ message_id: 15, sticker: { file_id: "f" } })).toBeUndefined();
    expect(serviceMessageKind({ message_id: 16, video: { file_id: "f" } })).toBeUndefined();
    expect(serviceMessageKind(undefined)).toBeUndefined();
  });
});

describe("replyContextFrom", () => {
  it("returns undefined when there is no quoted message or it has no text", () => {
    expect(replyContextFrom(undefined, 111)).toBeUndefined();
    expect(replyContextFrom({ message_id: 1 }, 111)).toBeUndefined();
    expect(replyContextFrom({ message_id: 1, text: "   " }, 111)).toBeUndefined();
    expect(replyContextFrom({ message_id: 1, caption: undefined }, 111)).toBeUndefined();
  });

  it("marks the bot's own messages as 'you'", () => {
    expect(replyContextFrom({ message_id: 5, text: "Pick one", from: { id: 111, first_name: "pibot" } }, 111)).toEqual({
      messageId: 5,
      sender: "you",
      quoted: "Pick one",
    });
  });

  it("falls back to the quoted sender's name without a known self id", () => {
    expect(replyContextFrom({ message_id: 6, text: "hey", from: { id: 999, first_name: "Gleb" } }, undefined)).toEqual({
      messageId: 6,
      sender: "Gleb",
      quoted: "hey",
    });
  });

  it("uses captions for media quotes and truncates long quotes", () => {
    expect(replyContextFrom({ message_id: 9, caption: "a photo caption", from: { id: 2, first_name: "Gleb" } }, 111)?.quoted).toBe("a photo caption");
    expect(replyContextFrom({ message_id: 10, text: "x".repeat(1000), from: { id: 2, first_name: "Gleb" } }, 111)?.quoted.length).toBeLessThanOrEqual(400);
  });
});

describe("extFromMime", () => {
  it("maps common media mimes and ignores parameters", () => {
    expect(extFromMime("audio/ogg; codecs=opus")).toBe(".ogg");
    expect(extFromMime("audio/mpeg")).toBe(".mp3");
    expect(extFromMime("image/jpeg")).toBe(".jpg");
    expect(extFromMime("application/pdf")).toBe(".pdf");
    expect(extFromMime("application/x-unknown")).toBeUndefined();
    expect(extFromMime(undefined)).toBeUndefined();
  });
});

describe("telegramMediaSpec", () => {
  it("accepts bounded video notes for local audio extraction", () => {
    expect(telegramMediaSpec({ video_note: { file_id: "vn", duration: 12, file_size: 1024 } })).toMatchObject({
      ok: true,
      kind: "video_note",
      fileId: "vn",
      durationSec: 12,
      extension: ".mp4",
    });
  });

  it("classifies only audio MIME documents as audio documents", () => {
    expect(telegramMediaSpec({ document: { file_id: "a", mime_type: "audio/mpeg", file_size: 2048 } })).toMatchObject({
      ok: true,
      kind: "audio_document",
      fileId: "a",
    });
    expect(telegramMediaSpec({ document: { file_id: "x", mime_type: "application/pdf", file_size: 2048 } })).toMatchObject({
      ok: true,
      kind: "document",
      fileId: "x",
    });
  });

  it("rejects oversized voice and video-note downloads before getFile", () => {
    expect(telegramMediaSpec({ voice: { file_id: "v", duration: 2, file_size: 20 * 1024 * 1024 + 1 } })).toMatchObject({ ok: false, error: expect.stringContaining("20MB") });
    expect(telegramMediaSpec({ video_note: { file_id: "vn", duration: 301, file_size: 1 } })).toMatchObject({ ok: false, error: expect.stringContaining("300s") });
  });
});

describe("Telegram profile photo adapter", () => {
  it("uploads every static JPG through setMyProfilePhoto with a fresh InputFile", async () => {
    const transport = new (await import("./telegram.js")).TelegramTransport("123:test", ["42"], { nameSuffix: "coach", boundAgentId: "coach" });
    const setMyProfilePhoto = vi.fn(async (_photo: InputProfilePhoto) => true);
    (transport as unknown as { bot: { api: { setMyProfilePhoto: typeof setMyProfilePhoto } } }).bot.api.setMyProfilePhoto = setMyProfilePhoto;

    await transport.setProfilePhoto("/tmp/coach-avatar.jpg");
    await transport.setProfilePhoto("/tmp/coach-avatar.jpg");

    expect(setMyProfilePhoto).toHaveBeenCalledTimes(2);
    const first = setMyProfilePhoto.mock.calls[0][0];
    const second = setMyProfilePhoto.mock.calls[1][0];
    expect(first.type).toBe("static");
    if (first.type !== "static" || second.type !== "static") throw new Error("expected static profile photos");
    expect(first.photo).toBeInstanceOf(InputFile);
    expect(first.photo.filename).toBe("coach-avatar.jpg");
    expect(second.photo).toBeInstanceOf(InputFile);
    expect(second.photo).not.toBe(first.photo);
  });
});

describe("Telegram speech delivery", () => {
  it("sends voice through the guarded per-chat outbox and suppresses an immediate duplicate", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-tg-voice-"));
    const file = path.join(dir, "voice.ogg");
    fs.writeFileSync(file, "OggS-voice", { mode: 0o600 });
    const transport = new (await import("./telegram.js")).TelegramTransport("123:test", ["42"]);
    const sendVoice = vi.fn(async (_chatId: string, _voice: unknown, _options?: unknown) => ({ message_id: 1 }));
    (transport as unknown as { bot: { api: { sendVoice: typeof sendVoice } } }).bot.api.sendVoice = sendVoice;

    await transport.sendVoice("42", file, "hello");
    await transport.sendVoice("42", file, "hello");

    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(sendVoice.mock.calls[0][0]).toBe("42");
    expect(sendVoice.mock.calls[0][1]).toBeInstanceOf(InputFile);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sends M4A through Telegram audio delivery", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-tg-audio-"));
    const file = path.join(dir, "audio.m4a");
    fs.writeFileSync(file, Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp-audio")]), { mode: 0o600 });
    const transport = new (await import("./telegram.js")).TelegramTransport("123:test", ["42"]);
    const sendAudio = vi.fn(async (_chatId: string, _audio: unknown, _options?: unknown) => ({ message_id: 1 }));
    (transport as unknown as { bot: { api: { sendAudio: typeof sendAudio } } }).bot.api.sendAudio = sendAudio;

    await transport.sendAudio("42", file);

    expect(sendAudio).toHaveBeenCalledTimes(1);
    expect(sendAudio.mock.calls[0][1]).toBeInstanceOf(InputFile);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("opens a fresh voice upload when Telegram asks for a rate-limit retry", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-tg-retry-"));
    const file = path.join(dir, "voice.ogg");
    fs.writeFileSync(file, "OggS-voice", { mode: 0o600 });
    const transport = new (await import("./telegram.js")).TelegramTransport("123:test", ["42"]);
    const uploads: unknown[] = [];
    const sendVoice = vi.fn(async (_chatId: string, voice: unknown) => {
      uploads.push(voice);
      if (uploads.length === 1) throw { error_code: 429, parameters: { retry_after: 0 } };
      return { message_id: 1 };
    });
    (transport as unknown as { bot: { api: { sendVoice: typeof sendVoice } } }).bot.api.sendVoice = sendVoice;

    await transport.sendVoice("42", file);

    expect(uploads).toHaveLength(2);
    expect(uploads[0] === uploads[1]).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("rich message auto-routing (Bot API 10.1+)", () => {
  function richTransport(): { t: TelegramTransport; calls: string[]; richPayloads: Array<{ markdown: string }> } {
    const t = new TelegramTransport("123:test", ["42"]);
    const calls: string[] = [];
    const richPayloads: Array<{ markdown: string }> = [];
    (t as unknown as { bot: { api: Record<string, unknown> } }).bot = {
      api: {
        sendRichMessage: async (_cid: string, payload: { markdown: string }) => {
          calls.push("sendRichMessage");
          richPayloads.push(payload);
          return { message_id: 5 };
        },
        sendMessage: async () => {
          calls.push("sendMessage");
          return { message_id: 6 };
        },
      },
    };
    return { t, calls, richPayloads };
  }

  it("headings route through sendRichMessage with the raw markdown", async () => {
    const { t, calls, richPayloads } = richTransport();
    await t.push("42", { text: "## Status\n\nAll green." });
    expect(calls).toEqual(["sendRichMessage"]);
    expect(richPayloads[0]?.markdown).toContain("## Status");
  });

  it("table blocks route through sendRichMessage", async () => {
    const { t, calls } = richTransport();
    await t.push("42", { text: "agents:\n\n| agent | bot |\n| --- | --- |\n| knower | @pimother_knower_bot |" });
    expect(calls).toEqual(["sendRichMessage"]);
  });

  it("plain content stays on the classic entity path", async () => {
    const { t, calls } = richTransport();
    await t.push("42", { text: "Label: value\nAnother line — no tables here." });
    expect(calls).toEqual(["sendMessage"]);
  });

  it("card pushes stay classic even when the text looks rich", async () => {
    const { t, calls } = richTransport();
    await t.push("42", { text: "## pick one", card: { text: "", buttons: [{ label: "go", action: "agt:x" }] } });
    expect(calls).toEqual(["sendMessage"]);
  });

  it("404 from a legacy server falls back to classic entities", async () => {
    const t = new TelegramTransport("123:test", ["42"]);
    const calls: string[] = [];
    (t as unknown as { bot: { api: Record<string, unknown> } }).bot = {
      api: {
        sendRichMessage: async () => {
          calls.push("sendRichMessage");
          throw Object.assign(new Error("Not Found"), { error_code: 404 });
        },
        sendMessage: async () => {
          calls.push("sendMessage");
          return { message_id: 7 };
        },
      },
    };
    await t.push("42", { text: "## Status\n\nAll green." });
    expect(calls).toEqual(["sendRichMessage", "sendMessage"]); // no double-send, no throw
  });

  it("unexpected sendRichMessage errors surface instead of falling back", async () => {
    const t = new TelegramTransport("123:test", ["42"]);
    const calls: string[] = [];
    (t as unknown as { bot: { api: Record<string, unknown> } }).bot = {
      api: {
        sendRichMessage: async () => {
          calls.push("sendRichMessage");
          throw Object.assign(new Error("Bad Request: chat not found"), { error_code: 400 });
        },
        sendMessage: async () => {
          calls.push("sendMessage");
          return { message_id: 9 };
        },
      },
    };
    await expect(t.push("42", { text: "## Status" })).rejects.toThrow(/chat not found/);
    expect(calls).toEqual(["sendRichMessage"]); // 400s are real failures — never silently re-sent
  });
});

describe("quick-action keyboard", () => {
  it("attaches once on the first plain push of a main-bot chat and is NOT persistent", async () => {
    const t = new TelegramTransport("123:test", ["42"]); // no boundAgentId = main bot
    const marks: Array<{ is_persistent?: boolean } | undefined> = [];
    (t as unknown as { bot: { api: Record<string, unknown> } }).bot = {
      api: {
        sendMessage: async (_cid: string, _text: string, extra?: { reply_markup?: { is_persistent?: boolean } }) => {
          marks.push(extra?.reply_markup);
          return { message_id: 1 };
        },
      },
    };
    await t.push("42", { text: "first plain reply" });
    await t.push("42", { text: "second reply — keyboard must not re-attach" });
    expect(marks.length).toBe(2);
    expect(marks[0]?.is_persistent).toBe(false); // never pinned open
    expect(marks[1]).toBeUndefined(); // attached only once per chat
  });
});

describe("push settle deadlock guard", () => {
  it("a reply that settles a marked message must not self-deadlock the outbox", async () => {
    const t = new TelegramTransport("123:test", ["42"]);
    const calls: string[] = [];
    (t as unknown as { bot: { api: Record<string, unknown> } }).bot = {
      api: {
        sendMessage: async () => {
          calls.push("sendMessage");
          return { message_id: 7 };
        },
        setMessageReaction: async () => {
          calls.push("setMessageReaction");
          return {};
        },
      },
    };
    // simulate: incoming message 99 still marked 👀 (settleIncoming has work to do)
    (t as unknown as { processingIds: Map<string, number[]> }).processingIds.set("42", [99]);
    // the old code deadlocked here (reaction enqueued behind the push itself)
    const p = t.push("42", { text: "here is your answer" });
    await Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error("push deadlocked")), 3_000))]);
    expect(calls).toContain("sendMessage");
    expect(calls).toContain("setMessageReaction");
  });
});

/** Stack check: Telegram rejects crossed/unbalanced tags with "can't parse entities". */
function isWellFormedHtml(html: string): boolean {
  const open = ["b", "i", "code", "a", "u", "s", "pre", "tg-spoiler"];
  const stack: string[] = [];
  const token = /<(\/?)([a-z-]+)[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(html)) !== null) {
    const [, slash, tag] = m;
    if (!open.includes(tag)) return false;
    if (slash) {
      if (stack.pop() !== tag) return false; // crossed or unmatched
    } else {
      stack.push(tag);
    }
  }
  return stack.length === 0;
}

describe("markdown → Telegram HTML entities", () => {
  it("converts the inline markup pibot has always supported", () => {
    expect(toTelegramHtml("**bold** and *italic* and `code`")).toBe("<b>bold</b> and <i>italic</i> and <code>code</code>");
  });

  it("converts [text](https://…) links to anchors", () => {
    expect(toTelegramHtml("[docs](https://example.com/a)")).toBe('<a href="https://example.com/a">docs</a>');
    expect(toTelegramHtml("see [docs](https://example.com) now")).toBe('see <a href="https://example.com">docs</a> now');
    expect(toTelegramHtml("[a & b](https://example.com)")).toBe('<a href="https://example.com">a &amp; b</a>');
  });

  it("escapes attribute-hostile characters out of hrefs", () => {
    expect(toTelegramHtml("[t](https://e.com/?a=1&b=2)")).toBe('<a href="https://e.com/?a=1&amp;b=2">t</a>');
    expect(toTelegramHtml('[t](https://e.com/?a="x")')).toBe('[t](https://e.com/?a="x")');
  });

  it("keeps non-http, malformed, or markup-bearing links literal", () => {
    expect(toTelegramHtml("[t](javascript:alert(1))")).toBe("[t](javascript:alert(1))");
    expect(toTelegramHtml("[t](ftp://example.com)")).toBe("[t](ftp://example.com)");
    expect(toTelegramHtml("[t](https://example.com")).toBe("[t](https://example.com");
    expect(toTelegramHtml("[t] (https://example.com)")).toBe("[t] (https://example.com)");
    expect(toTelegramHtml("[](https://example.com)")).toBe("[](https://example.com)");
    // label markup isn't part of any anchor (links need plain labels) but still renders inline:
    expect(toTelegramHtml("[**bold**](https://example.com)")).toBe("[<b>bold</b>](https://example.com)");
    expect(toTelegramHtml("[a\nb](https://example.com)")).toBe("[a\nb](https://example.com)");
  });

  it("keeps bullets and lone asterisks literal", () => {
    expect(toTelegramHtml("* one\n* two")).toBe("* one\n* two");
    expect(toTelegramHtml("2 * 3 = 6")).toBe("2 * 3 = 6");
    expect(toTelegramHtml("waiting... *")).toBe("waiting... *");
  });

  it("escapes agent output that looks like markup", () => {
    expect(toTelegramHtml("<b>not markup</b> & <script>")).toBe("&lt;b&gt;not markup&lt;/b&gt; &amp; &lt;script&gt;");
  });

  it("never crosses tags when delimiters overlap", () => {
    // Regression: sequential regex passes produced <code>a <i>b</code> c</i> here,
    // which Telegram rejected with 400 "can't parse entities" — message lost.
    const adversarial = [
      "`a *b` c*",
      "*a `b* c`",
      "`repo view *`, `api repos/*`",
      "**a `b** c`",
      "`x**y`z**",
      "- `gh` — read-only subcommands: `repo view *`, `api repos/*` (auth's already done)",
      "a **b *c* d** e",
      "[**bold](https://e.com) rest**",
      "[a [b](https://c.com) d](https://e.com)",
      "[`code](https://e.com) tail`",
      "[x](https://e.com/**y*)",
    ];
    for (const input of adversarial) {
      const html = toTelegramHtml(input);
      expect(isWellFormedHtml(html), `input ${JSON.stringify(input)} → ${html}`).toBe(true);
    }
  });
});

describe("telegram entity rejection must not cost the message", () => {
  const ENTITY_ERROR = "Bad Request: can't parse entities: Unmatched end tag at byte offset 604, expected \"</i>\", found \"</code>\"";

  it("resends the same text without parse_mode when Telegram rejects the entities", async () => {
    const t = new TelegramTransport("123:test", ["42"]);
    const attempts: Array<{ text: string; parse_mode: string | undefined }> = [];
    (t as unknown as { bot: { api: Record<string, unknown> } }).bot = {
      api: {
        sendMessage: async (_cid: string, text: string, extra?: { parse_mode?: string }) => {
          attempts.push({ text, parse_mode: extra?.parse_mode });
          if (extra?.parse_mode === "HTML") {
            throw Object.assign(new Error(ENTITY_ERROR), { error_code: 400, description: ENTITY_ERROR });
          }
          return { message_id: 11 };
        },
      },
    };
    await t.push("42", { text: "**bold** reply with `code`" });
    expect(attempts.map((a) => a.parse_mode)).toEqual(["HTML", undefined]);
    expect(attempts[1]?.text).toBe("**bold** reply with `code`");
  });

  it("still surfaces a real 400 that is not a markup problem", async () => {
    const t = new TelegramTransport("123:test", ["42"]);
    (t as unknown as { bot: { api: Record<string, unknown> } }).bot = {
      api: {
        sendMessage: async () => {
          throw Object.assign(new Error("Bad Request: chat not found"), { error_code: 400, description: "Bad Request: chat not found" });
        },
      },
    };
    await expect(t.push("42", { text: "plain reply" })).rejects.toThrow(/chat not found/);
  });

  it("rich-markdown rejections degrade too, instead of dropping a heading reply", async () => {
    const t = new TelegramTransport("123:test", ["42"]);
    const calls: string[] = [];
    (t as unknown as { bot: { api: Record<string, unknown> } }).bot = {
      api: {
        sendRichMessage: async () => {
          calls.push("sendRichMessage");
          throw Object.assign(new Error(ENTITY_ERROR), { error_code: 400, description: ENTITY_ERROR });
        },
        sendMessage: async (_cid: string, _text: string, extra?: { parse_mode?: string }) => {
          calls.push(extra?.parse_mode === "HTML" ? "sendMessage:html" : "sendMessage:plain");
          return { message_id: 12 };
        },
      },
    };
    await t.push("42", { text: "## Status\n\nAll green." });
    expect(calls).toEqual(["sendRichMessage", "sendMessage:html"]);
  });
});

describe("sendTelegram send timeout (outbox wedge guard)", () => {
  function bareTransport(): TelegramTransport {
    return new TelegramTransport("123:test", ["42"]);
  }
  it("fails a hung api call with a loud timeout error and does not wedge the queue", async () => {
    vi.stubEnv("PIBOT_TG_SEND_TIMEOUT_MS", "250");
    const t = bareTransport();
    const hung = new Promise(() => {});
    await expect((t as unknown as { sendTelegram: (cid: string, s: () => Promise<unknown>) => Promise<unknown> }).sendTelegram("42", () => hung)).rejects.toThrow(/timed out/);
    // the same chat's queue must still work after the timed-out attempt
    const next = await (t as unknown as { sendTelegram: (cid: string, s: () => Promise<unknown>) => Promise<unknown> }).sendTelegram("42", async () => "ok");
    expect(next).toBe("ok");
    vi.unstubAllEnvs();
  });

  it("returns the result when the call settles within the budget", async () => {
    vi.stubEnv("PIBOT_TG_SEND_TIMEOUT_MS", "2000");
    const t = bareTransport();
    const r = await (t as unknown as { sendTelegram: (cid: string, s: () => Promise<unknown>) => Promise<unknown> }).sendTelegram("42", async () => "delivered");
    expect(r).toBe("delivered");
    vi.unstubAllEnvs();
  });
});

describe("outbound resilience: replies must survive a network flap", () => {
  function transportWith(api: Record<string, unknown>): TelegramTransport {
    const t = new TelegramTransport("123:test", ["42"]);
    (t as unknown as { bot: { api: Record<string, unknown> } }).bot = { api };
    return t;
  }
  /** A DNS failure the way node-fetch/grammy report it (outer HttpError → FetchError). */
  const dnsFailure = () =>
    Object.assign(new Error("Network request for 'sendMessage' failed!"), {
      error: Object.assign(new Error("request to https://api.telegram.org/botX/sendMessage failed, reason: getaddrinfo ENOTFOUND api.telegram.org"), { code: "ENOTFOUND", errno: "ENOTFOUND" }),
    });

  it("retries a pre-connection network failure instead of losing the reply", async () => {
    let calls = 0;
    const t = transportWith({
      sendMessage: async () => {
        calls += 1;
        if (calls === 1) throw dnsFailure();
        return { message_id: 21 };
      },
    });
    await t.push("42", { text: "the reply" });
    expect(calls).toBe(2);
  });

  it("gives up after bounded retries and surfaces the failure", async () => {
    let calls = 0;
    const t = transportWith({
      sendMessage: async () => {
        calls += 1;
        throw dnsFailure();
      },
    });
    await expect(t.push("42", { text: "the reply" })).rejects.toThrow(/Network request/);
    expect(calls).toBe(3); // 1 + 2 retries, never unbounded
  });

  it("does NOT retry an ambiguous failure (a duplicate reply is worse than a logged loss)", async () => {
    let calls = 0;
    const t = transportWith({
      sendMessage: async () => {
        calls += 1;
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      },
    });
    await expect(t.push("42", { text: "the reply" })).rejects.toThrow(/socket hang up/);
    expect(calls).toBe(1);
  });

  it("settles 👀→👍 only after the send actually succeeded", async () => {
    const order: string[] = [];
    const t = transportWith({
      sendMessage: async () => {
        order.push("send");
        return { message_id: 22 };
      },
      setMessageReaction: async () => {
        order.push("reaction");
        return true;
      },
    });
    (t as unknown as { processingIds: Map<string, number[]> }).processingIds.set("42", [7]);
    await t.push("42", { text: "answered" });
    expect(order).toEqual(["send", "reaction"]);
  });

  it("downgrades to 👎 when the send fails, so the reaction never claims a delivery", async () => {
    const reactions: string[] = [];
    const t = transportWith({
      sendMessage: async () => {
        throw Object.assign(new Error("chat not found"), { error_code: 400, description: "Bad Request: chat not found" });
      },
      setMessageReaction: async (_c: number, _m: number, r: Array<{ emoji: string }>) => {
        reactions.push(r[0]?.emoji ?? "");
        return true;
      },
    });
    (t as unknown as { processingIds: Map<string, number[]> }).processingIds.set("42", [7]);
    await expect(t.push("42", { text: "never arrives" })).rejects.toThrow(/chat not found/);
    expect(reactions).toEqual(["👎"]);
  });
});

describe("duplicate backstop keys on turn identity, not on reply text", () => {
  function countingTransport() {
    const texts: string[] = [];
    const t = new TelegramTransport("123:test", ["42"]);
    (t as unknown as { bot: { api: Record<string, unknown> } }).bot = {
      api: {
        sendMessage: async (_c: string, text: string) => {
          texts.push(text);
          return { message_id: texts.length + 30 };
        },
      },
    };
    return { t, texts };
  }

  it("delivers two identical replies that answer two different messages", async () => {
    const { t, texts } = countingTransport();
    await t.push("42", { text: "On it.", dedupeKey: "mock:42:msg:101" });
    await t.push("42", { text: "On it.", dedupeKey: "mock:42:msg:102" });
    expect(texts).toHaveLength(2);
  });

  it("still suppresses a second send for the SAME turn (the accidental double-fire case)", async () => {
    const { t, texts } = countingTransport();
    await t.push("42", { text: "On it.", dedupeKey: "mock:42:msg:101" });
    await t.push("42", { text: "On it.", dedupeKey: "mock:42:msg:101" });
    expect(texts).toHaveLength(1);
  });

  it("keeps payload dedupe for proactive pushes (which carry no turn)", async () => {
    const { t, texts } = countingTransport();
    await t.push("42", { text: "hourly nudge" });
    await t.push("42", { text: "hourly nudge" });
    expect(texts).toHaveLength(1);
  });
});

describe("Telegram setWorkBadge", () => {
  it("reacts 🛠 on the last incoming message, stable — no cycling interval", async () => {
    const transport = new TelegramTransport("123:test", ["42"]);
    const reactions: Array<{ chat: string; message: number; emoji: string }> = [];
    (transport as unknown as { bot: { api: { setMessageReaction: (...a: unknown[]) => Promise<unknown> } } }).bot.api.setMessageReaction =
      async (...args: unknown[]) => {
        const [chatId, messageId, reaction] = args as [unknown, number, Array<{ emoji: string }>];
        reactions.push({ chat: String(chatId), message: Number(messageId), emoji: reaction[0]?.emoji ?? "" });
        return true;
      };
    (transport as unknown as { processingIds: Map<string, number[]> }).processingIds.set("42", [7, 9]);

    transport.setWorkBadge("42", "🛠");
    await new Promise((r) => setTimeout(r, 20)); // let the enqueued task run

    expect(reactions).toEqual([{ chat: "42", message: 9, emoji: "🛠" }]);
    expect((transport as unknown as { workTimers: Map<string, unknown> }).workTimers.size).toBe(0);
  });

  it("is a no-op when the chat has no marked incoming message", async () => {
    const transport = new TelegramTransport("123:test", ["42"]);
    const reactions: unknown[] = [];
    (transport as unknown as { bot: { api: { setMessageReaction: (...a: unknown[]) => Promise<unknown> } } }).bot.api.setMessageReaction =
      async (...a: unknown[]) => {
        reactions.push(a);
        return true;
      };
    transport.setWorkBadge("42", "🛠");
    await new Promise((r) => setTimeout(r, 20));
    expect(reactions.length).toBe(0);
  });
});

describe("managed-bot token fetch (grammY wrapper shape)", () => {
  it("passes the bot id as a scalar, not a payload object — an object yields 'invalid user_id' from Telegram", async () => {
    const t = new TelegramTransport("123:test", ["42"]);
    const calls: unknown[] = [];
    (t as unknown as { bot: { api: Record<string, unknown> } }).bot = {
      api: {
        getManagedBotToken: async (id: number) => {
          calls.push(id);
          return "8900661099:AAE-fake";
        },
      },
    };
    const token = await t.getManagedBotToken(8900661099, { attempts: 1 });
    expect(token).toBe("8900661099:AAE-fake");
    expect(calls).toEqual([8900661099]); // scalar number — NOT { user_id }
  });

  it("replaceManagedBotToken passes the bot id as a scalar too", async () => {
    const t = new TelegramTransport("123:test", ["42"]);
    const calls: unknown[] = [];
    (t as unknown as { bot: { api: Record<string, unknown> } }).bot = {
      api: {
        replaceManagedBotToken: async (id: number) => {
          calls.push(id);
          return "8900661099:AAE-new";
        },
      },
    };
    const token = await t.replaceManagedBotToken(8900661099, { attempts: 1 });
    expect(token).toBe("8900661099:AAE-new");
    expect(calls).toEqual([8900661099]);
  });
});
