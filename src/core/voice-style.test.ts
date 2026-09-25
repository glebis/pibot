import { describe, expect, it } from "vitest";
import { applyVoiceStyle, isOperationalNotice, VOICE_STYLE_DIRECTIVE } from "./voice-style.js";

describe("applyVoiceStyle: strip what cannot be listened to", () => {
  it("drops bare URLs but keeps the words around them", () => {
    expect(applyVoiceStyle("Fixed it. See https://github.com/glebis/pibot/pull/42 for details."))
      .toBe("Fixed it. See for details.");
  });

  it("keeps a markdown link's label and drops its target", () => {
    expect(applyVoiceStyle("Details in [the pull request](https://github.com/x/y/pull/42)."))
      .toBe("Details in the pull request.");
  });

  it("shortens paths to the file name", () => {
    expect(applyVoiceStyle("I edited /Users/glebkalinin/ai_projects/pibot/src/core/bot.ts and tests pass."))
      .toBe("I edited bot.ts and tests pass.");
    expect(applyVoiceStyle("Changed src/core/voice-style.ts too.")).toBe("Changed voice-style.ts too.");
    expect(applyVoiceStyle("The log is at ~/.local/share/pibot/data/daemon.log.")).toBe("The log is at daemon.log.");
  });

  it("leaves slash-words alone (not every slash is a path)", () => {
    expect(applyVoiceStyle("Use and/or, either way.")).toBe("Use and/or, either way.");
  });

  it("keeps the words of a code block and drops the fences and braces", () => {
    expect(applyVoiceStyle("I ran:\n```sh\nnpm test --silent\n```\nIt passed.")).toBe("I ran: npm test --silent It passed.");
  });

  it("strips markdown syntax and list markers into speech", () => {
    expect(applyVoiceStyle("## Status\n\n- **Tests** pass\n- `build` is clean")).toBe("Status Tests pass build is clean");
  });

  it("drops commit hashes but not plain numbers", () => {
    expect(applyVoiceStyle("Landed as 0f90961 and covers 1234567 cases.")).toBe("Landed as and covers 1234567 cases.");
  });

  it("drops provider/model specs by prefix, not by guessing", () => {
    expect(applyVoiceStyle("Answering on ollama/glm-5.3-flash:cloud right now.")).toBe("Answering on right now.");
    expect(applyVoiceStyle("The word llama/alpaca stays.")).toBe("The word llama/alpaca stays.");
  });

  it("drops emoji", () => {
    expect(applyVoiceStyle("Done ✅ — nice work 🎉")).toBe("Done — nice work");
  });

  it("leaves ordinary prose untouched", () => {
    const plain = "I fixed the redirect bug and the tests pass.";
    expect(applyVoiceStyle(plain)).toBe(plain);
  });
});

describe("applyVoiceStyle: the speech cap", () => {
  const long = "One thing happened. Then another thing. A third thing followed. A fourth thing too. And a fifth thing.";

  it("caps at a sentence boundary", () => {
    expect(applyVoiceStyle(long, { maxSentences: 2, maxChars: 400 })).toBe("One thing happened. Then another thing.");
  });

  it("respects the character cap over the sentence cap", () => {
    expect(applyVoiceStyle(long, { maxSentences: 4, maxChars: 30 })).toBe("One thing happened.");
  });

  it("never returns empty because of the cap (silence is worse than length)", () => {
    const oneLongSentence = "This single sentence runs well past the character cap that was configured for it.";
    expect(applyVoiceStyle(oneLongSentence, { maxSentences: 1, maxChars: 10 })).toBe(oneLongSentence);
  });

  it("applies no cap when none is configured", () => {
    expect(applyVoiceStyle(long)).toBe(long);
  });
});

describe("operational notices are exempt", () => {
  it("recognises the notices the bot itself sends", () => {
    for (const notice of [
      "⚠️ **assistant** finished that turn without a reply — the model ended on reasoning only.",
      "⚠︎ Agent \"x\" failed to start: boom",
      "🪫 **assistant** couldn't reach any model just now",
      "🔑 **assistant** couldn't authenticate with any provider",
      "⛔️ Bot not paired. Your chat id is `123`",
    ]) {
      expect(isOperationalNotice(notice), notice.slice(0, 12)).toBe(true);
    }
  });

  it("does not treat an ordinary reply as a notice", () => {
    expect(isOperationalNotice("I fixed the redirect bug.")).toBe(false);
  });

  it("leaves notices to the caller to skip — filtering would hide the diagnosis", () => {
    const notice = "⚠️ turn failed: https://api.telegram.org/bot1:X/sendMessage — see /tmp/x.log";
    expect(isOperationalNotice(notice)).toBe(true);
    // and the filter itself would have mangled it, which is why callers must skip first
    expect(applyVoiceStyle(notice)).not.toBe(notice);
  });
});

describe("the prompt-side directive", () => {
  it("says what speech needs, including the full-path exception", () => {
    expect(VOICE_STYLE_DIRECTIVE).toMatch(/sentences/i);
    expect(VOICE_STYLE_DIRECTIVE).toMatch(/no url|urls/i);
    expect(VOICE_STYLE_DIRECTIVE).toMatch(/file name|file names/i);
    expect(VOICE_STYLE_DIRECTIVE).toMatch(/only (if|when) .*ask/i);
  });
});
