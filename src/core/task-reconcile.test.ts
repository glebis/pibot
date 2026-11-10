import { describe, expect, it } from "vitest";
import { classifyDelegateReply, DelegateEvidenceCollector, extractArtifactRefs, formatDelegateEvidence, formatRefusalEvidence } from "./task-reconcile.js";

describe("correlated delegate evidence (bd pibot-jiqv)", () => {
  it("renders a bounded reply as partial evidence, never as completed work", () => {
    const out = formatDelegateEvidence(
      [{ toAgentId: "pibot-dev", text: "Transcript ready.\nSaved: /Users/glebkalinin/.local/share/pibot/agents/knower/arjay.groq.txt", usable: true }],
      { remainingGate: "file the source note" },
    );
    expect(out).toContain("Delegate pibot-dev returned a reply");
    expect(out).toContain("delegate-returned, not independently verified");
    expect(out).toContain("/Users/glebkalinin/.local/share/pibot/agents/knower/arjay.groq.txt");
    expect(out).toContain("Remaining gate: file the source note");
    expect(out).not.toContain("completed result");
    expect(out).not.toContain("Task done");
  });

  it("returns undefined without a usable reply, so failure survives a refusal or no-reply", () => {
    expect(formatDelegateEvidence([])).toBeUndefined();
    expect(formatDelegateEvidence([{ toAgentId: "pibot-dev", text: "   ", usable: true }])).toBeUndefined();
    expect(formatDelegateEvidence([{ toAgentId: "pibot-dev", text: "BLOCKED: no Groq credential", usable: false }])).toBeUndefined();
    expect(formatRefusalEvidence({ toAgentId: "pibot-dev", text: "BLOCKED: no Groq credential", usable: false }))
      .toContain("refusal/blocker");
  });

  it("classifies no-reply, no-result and refusal prose (EN + RU) as non-usable", () => {
    expect(classifyDelegateReply("(no reply)")).toBe("skip");
    expect(classifyDelegateReply("   ")).toBe("skip");
    expect(classifyDelegateReply("no result yet")).toBe("skip");
    expect(classifyDelegateReply("ERROR: no access")).toBe("refusal");
    expect(classifyDelegateReply("I cannot transcribe this file")).toBe("refusal");
    expect(classifyDelegateReply("Не могу выполнить: нет доступа к файлу")).toBe("refusal");
    expect(classifyDelegateReply("Заблокировано — ожидаем доступ")).toBe("refusal");
    expect(classifyDelegateReply("Пока не готово")).toBe("refusal");
    expect(classifyDelegateReply("I have started the transcription; no output is available yet.")).toBe("refusal");
    expect(classifyDelegateReply("Начал расшифровку, результата пока нет.")).toBe("refusal");
    expect(classifyDelegateReply("**BLOCKED:** missing credential")).toBe("refusal");
    expect(classifyDelegateReply("> **Не могу** открыть файл")).toBe("refusal");
    expect(classifyDelegateReply("I looked into it and will report back")).toBe("refusal");
    expect(classifyDelegateReply("Started the transcript; result will be saved to /tmp/a.txt")).toBe("refusal");
    expect(classifyDelegateReply("The result will be saved to /tmp/a.txt when finished")).toBe("refusal");
    expect(classifyDelegateReply("Начал: сохраню результат в /tmp/a.txt позже")).toBe("refusal");
    expect(classifyDelegateReply("I have not saved the transcript to /tmp/a.txt")).toBe("refusal");
    expect(classifyDelegateReply("I haven't created output at /tmp/a.txt")).toBe("refusal");
    expect(classifyDelegateReply("Не сохранил транскрипт в /tmp/a.txt")).toBe("refusal");
    expect(classifyDelegateReply("Result: no output yet")).toBe("refusal");
    expect(classifyDelegateReply("Result: BLOCKED: no Groq credential")).toBe("refusal");
    expect(classifyDelegateReply("Summary: unable to access the file")).toBe("refusal");
    expect(classifyDelegateReply("Result:\n> **BLOCKED:** no Groq credential")).toBe("refusal");
    expect(classifyDelegateReply("Summary: I have started; no output yet")).toBe("refusal");
    expect(classifyDelegateReply("Ответ: **Не могу** открыть файл")).toBe("refusal");
    expect(classifyDelegateReply("Результат:\n> Пока нет результата")).toBe("refusal");
    expect(classifyDelegateReply("Ответ: Начал работу, сохраню файл позже")).toBe("refusal");
    expect(classifyDelegateReply("Transcript ready: /tmp/a.txt")).toBe("usable");
    expect(classifyDelegateReply("Result: Saved transcript to /tmp/a.txt")).toBe("usable");
    expect(classifyDelegateReply("Summary: The interview covers three hiring decisions.")).toBe("usable");
    expect(classifyDelegateReply("Summary:\nThe interview covers three hiring decisions.")).toBe("usable");
    expect(classifyDelegateReply("Ответ: встреча начинается в 10:00 по Берлину.")).toBe("usable");
    expect(classifyDelegateReply("Транскрипт готов: /tmp/a.txt")).toBe("usable");
  });

  it("does not dedupe different replies that share a long intro", () => {
    const late: string[] = [];
    const collector = new DelegateEvidenceCollector((note) => late.push(note));
    collector.finish();
    const intro = "a".repeat(300);
    collector.record("pibot-dev", `wrote ${intro} first /tmp/one.txt`);
    collector.record("pibot-dev", `wrote ${intro} second /tmp/two.txt`);
    expect(late).toHaveLength(2);
  });

  it("preserves a path named after the display cut", () => {
    const text = `wrote ${"a".repeat(1500)} /tmp/late-path.groq.txt`;
    const out = formatDelegateEvidence([{ toAgentId: "pibot-dev", text, usable: true }]);
    expect(out).toContain("/tmp/late-path.groq.txt");
    expect(out).not.toContain("a".repeat(1300));
  });

  it("retains the only usable reply through more than eight refusal replies before report", () => {
    const collector = new DelegateEvidenceCollector(() => {});
    collector.record("child", "Saved transcript to /tmp/only-result.txt");
    for (let i = 0; i < 12; i++) collector.record("child", `BLOCKED: retry ${i}`);
    const report = collector.report({ remainingGate: "confirm filing" });
    expect(report).toContain("/tmp/only-result.txt");
    expect(report).toContain("Remaining gate: confirm filing");
  });

  it("extracts only explicit absolute paths, never inferred names", () => {
    expect(extractArtifactRefs("no path here")).toEqual([]);
    expect(extractArtifactRefs("saved /tmp/a.txt and /Users/x/b.md")).toEqual(["/tmp/a.txt", "/Users/x/b.md"]);
  });

  it("reports late usable and refusal replies once, with the usability flag", () => {
    const late: Array<{ note: string; usable: boolean }> = [];
    const collector = new DelegateEvidenceCollector((note, usable) => late.push({ note, usable }));
    expect(collector.report()).toBeUndefined();
    collector.finish();
    collector.record("pibot-dev", "done, wrote /tmp/a.txt");
    collector.record("pibot-dev", "done, wrote /tmp/a.txt"); // dedupe
    collector.record("pibot-dev", "(no reply)");
    collector.record("pibot-dev", "BLOCKED: missing credential");
    expect(late).toHaveLength(2);
    expect(late[0]).toMatchObject({ usable: true });
    expect(late[0].note).toContain("/tmp/a.txt");
    expect(late[1]).toMatchObject({ usable: false });
  });

  it("uses neutral wording for late replies after ordinary finish", () => {
    for (const end of ["done", "cancelled", "generic failure"]) {
      const late: string[] = [];
      const collector = new DelegateEvidenceCollector((note) => late.push(note));
      collector.finish();
      collector.record("pibot-dev", `Saved ${end} output to /tmp/result.txt`);
      expect(late[0]).toContain("Remaining gate: confirm the returned work");
      expect(late[0]).not.toContain("deadline");
    }
  });
});
