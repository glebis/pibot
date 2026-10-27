import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createLocalMethodProbe, extractExecutionMethods, methodBlockerSignature, validateGoalMethods,
  type MethodProbe, type MethodProbeFs,
} from "./method-resolution.js";

const probe = (over: Partial<MethodProbe> = {}): MethodProbe => ({
  which: () => null,
  docs: () => [],
  ...over,
});

describe("extractExecutionMethods — the method a goal actually names", () => {
  it("reads a verb + command phrase (the observed 'using cmd acp')", () => {
    expect(extractExecutionMethods("implement the fix using cmd acp")).toEqual([
      { named: "cmd acp", command: "cmd", args: ["acp"], alternative: false },
    ]);
  });

  it("reads backticked spans", () => {
    expect(extractExecutionMethods("implement via `cmd acp`")).toEqual([
      { named: "cmd acp", command: "cmd", args: ["acp"], alternative: false },
    ]);
  });

  it("reads explicit $ command syntax", () => {
    expect(extractExecutionMethods("then: $ npx vitest run")).toEqual([
      { named: "npx vitest", command: "npx", args: ["vitest"], alternative: false },
    ]);
  });

  it("reads a bare command after a verb", () => {
    expect(extractExecutionMethods("run pytest")).toEqual([
      { named: "pytest", command: "pytest", args: [], alternative: false },
    ]);
  });

  it("reads the contract fields, not just the objective", () => {
    expect(extractExecutionMethods("finish the report", { verification: "checked with mdbook" })).toEqual([
      { named: "mdbook", command: "mdbook", args: [], alternative: false },
    ]);
  });

  it("reads an explicit path even when it is not a known command", () => {
    expect(extractExecutionMethods("use ./scripts/refresh.sh")).toEqual([
      { named: "./scripts/refresh.sh", command: "./scripts/refresh.sh", args: [], alternative: false },
    ]);
  });

  it("preserves the ORIGINAL case of a path-like command (the lowercase bug)", () => {
    // a lowercased path can never resolve on a case-sensitive volume
    expect(extractExecutionMethods("use ./Scripts/Build.sh").map((m) => m.command)).toEqual(["./Scripts/Build.sh"]);
    expect(extractExecutionMethods("use /opt/Tools/Deploy.sh").map((m) => m.command)).toEqual(["/opt/Tools/Deploy.sh"]);
    expect(extractExecutionMethods("run `./Scripts/Build.sh`")[0]).toMatchObject({ command: "./Scripts/Build.sh", named: "./Scripts/Build.sh" });
    // bare command names are still normalized to lowercase to match the allowlist
    expect(extractExecutionMethods("run CMD acp")[0].command).toBe("cmd");
  });

  it("dedupes the same method named twice", () => {
    expect(extractExecutionMethods("use cmd acp, then via cmd acp")).toHaveLength(1);
  });

  it("stays silent on ordinary prose and named tools that are not commands", () => {
    expect(extractExecutionMethods("using the file and reading it")).toEqual([]);
    expect(extractExecutionMethods("summarise the discussion")).toEqual([]);
    expect(extractExecutionMethods("use evidence from the report")).toEqual([]);
    expect(extractExecutionMethods("write the answer with examples")).toEqual([]);
    expect(extractExecutionMethods("compare `evidence` and `hypothesis`")).toEqual([]);
    expect(extractExecutionMethods("")).toEqual([]);
  });

  it("does not scan boundaries — a forbidden method is not a prerequisite", () => {
    expect(extractExecutionMethods("write a comparison", { boundaries: "do not use docker; never run terraform" })).toEqual([]);
  });

  it("skips a negated method named in the objective", () => {
    expect(extractExecutionMethods("finish the report without docker")).toEqual([]);
    expect(extractExecutionMethods("do not run pytest, just summarise")).toEqual([]);
  });

  it("marks an explicit alternative with `or` and keeps a conjunction required", () => {
    const alt = extractExecutionMethods("use cmd acp or run pytest");
    expect(alt.map((m) => [m.command, m.alternative])).toEqual([["cmd", false], ["pytest", true]]);
    const both = extractExecutionMethods("run cmd acp and run node");
    expect(both.map((m) => [m.command, m.alternative])).toEqual([["cmd", false], ["node", false]]);
  });
});

describe("validateGoalMethods — identity, provenance, installation, permission are separate", () => {
  it("is a no-op when the goal names no method", () => {
    expect(validateGoalMethods("write a comparison of three memory systems", undefined, probe())).toEqual({ status: "none" });
  });

  it("resolves when the binary is on PATH and permitted", () => {
    const resolution = validateGoalMethods("implement using cmd acp", undefined, probe({ which: () => "/usr/local/bin/cmd" }));
    expect(resolution).toMatchObject({ status: "resolved", method: { command: "cmd" }, resolvedPath: "/usr/local/bin/cmd" });
  });

  it("blocks with not_on_path when it is documented but absent — the observed case", () => {
    const resolution = validateGoalMethods("implement using cmd acp", undefined, probe({
      docs: () => ["/Users/me/.agents/skills/herdr/SKILL.md"],
    }));
    expect(resolution.status).toBe("blocked");
    if (resolution.status !== "blocked") return;
    expect(resolution.blocker).toMatchObject({
      id: "method:cmd:not_on_path",
      reason: "not_on_path",
      provenance: "/Users/me/.agents/skills/herdr/SKILL.md",
    });
    expect(resolution.blocker.detail).toContain("not resolvable on PATH");
  });

  it("blocks with unknown_method when neither a doc nor a binary exists — without claiming invention", () => {
    const resolution = validateGoalMethods("implement using kubectl apply", undefined, probe());
    if (resolution.status !== "blocked") throw new Error("expected blocked");
    expect(resolution.blocker).toMatchObject({ id: "method:kubectl:unknown_method", reason: "unknown_method" });
    expect(resolution.blocker.detail).toContain("no local doc, skill or PATH binary");
  });

  it("blocks with not_permitted when installed but not allowed for this agent", () => {
    const resolution = validateGoalMethods("implement using cmd acp", undefined, probe({
      which: () => "/usr/local/bin/cmd",
      permitted: () => false,
    }));
    if (resolution.status !== "blocked") throw new Error("expected blocked");
    expect(resolution.blocker).toMatchObject({ id: "method:cmd:not_permitted", reason: "not_permitted" });
  });

  it("fails closed: a throwing permission check never grants access", () => {
    const resolution = validateGoalMethods("implement using cmd acp", undefined, probe({
      which: () => "/usr/local/bin/cmd",
      permitted: () => {
        throw new Error("capability store unreachable");
      },
    }));
    if (resolution.status !== "blocked") throw new Error("expected blocked");
    expect(resolution.blocker.reason).toBe("not_permitted");
  });
});

describe("validateGoalMethods — required-all vs explicit alternative (the review case)", () => {
  it("an explicit alternative is satisfied by either side", () => {
    const resolution = validateGoalMethods("use cmd acp or run pytest", undefined, probe({
      which: (c) => (c === "pytest" ? "/usr/bin/pytest" : null),
    }));
    expect(resolution).toMatchObject({ status: "resolved", method: { command: "pytest" } });
  });

  it("a missing required method is NOT excused by an unrelated installed tool", () => {
    const resolution = validateGoalMethods("use cmd acp and run pytest", undefined, probe({
      which: (c) => (c === "pytest" ? "/usr/bin/pytest" : null),
    }));
    if (resolution.status !== "blocked") throw new Error("expected blocked");
    expect(resolution.blocker.method.command).toBe("cmd");
    expect(resolution.blocker.id).toBe("method:cmd:unknown_method");
  });

  it("a lone required method is blocked even while other tools resolve", () => {
    const resolution = validateGoalMethods("implement using cmd acp", undefined, probe({
      which: (c) => (c === "pytest" ? "/usr/bin/pytest" : null),
    }));
    expect(resolution.status).toBe("blocked");
  });

  it("reports the FIRST unsatisfied requirement group", () => {
    const resolution = validateGoalMethods("run cmd acp and use kubectl", undefined, probe({
      docs: (c) => (c === "cmd acp" ? ["/skills/herdr/SKILL.md"] : []),
    }));
    if (resolution.status !== "blocked") throw new Error("expected blocked");
    expect(resolution.blocker.method.command).toBe("cmd");
  });

  it("blocks a conjunction when the alternative branch also cannot resolve", () => {
    const resolution = validateGoalMethods("use cmd acp or run kubectl", undefined, probe());
    expect(resolution.status).toBe("blocked");
  });
});

describe("validateGoalMethods — hostile probes", () => {
  it("never throws when discovery probes fail", () => {
    const hostile = probe({
      which: () => {
        throw new Error("PATH exploded");
      },
      docs: () => {
        throw new Error("docs exploded");
      },
    });
    const resolution = validateGoalMethods("implement using cmd acp", undefined, hostile);
    expect(resolution.status).toBe("blocked");
    if (resolution.status !== "blocked") return;
    expect(resolution.blocker.reason).toBe("unknown_method");
  });
});

describe("methodBlockerSignature", () => {
  it("is the stable id, so an identical blocker never counts twice", () => {
    const resolution = validateGoalMethods("use cmd acp", undefined, probe());
    if (resolution.status !== "blocked") throw new Error("expected blocked");
    expect(methodBlockerSignature(resolution.blocker)).toBe("method:cmd:unknown_method");
  });
});

// ─── the production probe, exercised over a fake read-only filesystem ────────

function fakeFs(files: Record<string, string>, dirs: string[] = [], executables: string[] = []): MethodProbeFs {
  const dirSet = new Set(dirs);
  const exeSet = new Set(executables);
  return {
    isFile: (p) => p in files,
    isDirectory: (p) => dirSet.has(p),
    isExecutable: (p) => exeSet.has(p),
    listDir: (p) => {
      const out = new Set<string>();
      const prefix = p.endsWith("/") ? p : `${p}/`;
      for (const f of [...Object.keys(files), ...dirSet]) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const head = rest.split("/")[0];
        if (head) out.add(head);
      }
      return [...out];
    },
    readText: (p) => files[p] ?? null,
  };
}

describe("createLocalMethodProbe — read-only discovery, never executes or installs", () => {
  it("resolves a command only when an executable file exists in a PATH dir", () => {
    const fsx = fakeFs({}, ["/bin", "/usr/bin"], ["/usr/bin/cmd"]);
    const p = createLocalMethodProbe({ pathDirs: ["/bin", "/usr/bin"], fs: fsx });
    expect(p.which("cmd")).toBe("/usr/bin/cmd");
    expect(p.which("pytest")).toBeNull();
  });

  it("does not treat a non-executable file as a command", () => {
    const fsx = fakeFs({ "/bin/cmd": "not executable" }, ["/bin"], []);
    const p = createLocalMethodProbe({ pathDirs: ["/bin"], fs: fsx });
    expect(p.which("cmd")).toBeNull();
  });

  it("accepts an explicit path only when it really is an executable file", () => {
    const fsx = fakeFs({}, [], ["/opt/tools/x"]);
    const p = createLocalMethodProbe({ pathDirs: [], fs: fsx });
    expect(p.which("/opt/tools/x")).toBe("/opt/tools/x");
    expect(p.which("/opt/tools/missing")).toBeNull();
  });

  it("finds docs by mention, bounded by depth/file/byte limits", () => {
    const fsx = fakeFs(
      {
        "/skills/herdr/SKILL.md": "# herdr\nuse cmd acp to drive panes\n",
        "/skills/other/SKILL.md": "unrelated content\n",
        "/skills/herdr/notes.txt": "cmd is documented here\n",
        "/skills/big/SKILL.md": "cmd " + "x".repeat(70_000),
      },
      ["/skills", "/skills/herdr", "/skills/other", "/skills/big"],
    );
    const p = createLocalMethodProbe({ docRoots: ["/skills"], fs: fsx, maxDocBytes: 64_000 });
    const hits = p.docs("cmd acp");
    expect(hits).toContain("/skills/herdr/SKILL.md");
    expect(hits).not.toContain("/skills/other/SKILL.md");
    expect(hits).not.toContain("/skills/big/SKILL.md");
  });

  it("returns nothing (and never throws) when doc roots are absent", () => {
    const p = createLocalMethodProbe({ docRoots: ["/nope"], pathDirs: [], fs: fakeFs({}) });
    expect(p.docs("cmd")).toEqual([]);
    expect(p.which("cmd")).toBeNull();
  });

  it("honours the injected permission model", () => {
    const fsx = fakeFs({}, ["/bin"], ["/bin/cmd"]);
    const p = createLocalMethodProbe({ pathDirs: ["/bin"], fs: fsx, permitted: (c) => c !== "cmd" });
    const resolution = validateGoalMethods("use cmd acp", undefined, p);
    expect(resolution).toMatchObject({ status: "blocked", blocker: { reason: "not_permitted" } });
  });

  it("identifies a doc by the bounded roots it was given — the global herdr skill, nothing unrelated", () => {
    const fsx = fakeFs(
      {
        "/home/.agents/skills/herdr/SKILL.md": "drive panes with herdr; use cmd acp outside herdr\n",
        "/other-agent/docs/notes.md": "cmd acp is documented here too\n",
      },
      ["/home/.agents/skills", "/home/.agents/skills/herdr", "/other-agent", "/other-agent/docs"],
    );
    // the caller passes ONLY the global herdr root: the probe must not wander into other agents' dirs
    const p = createLocalMethodProbe({ docRoots: ["/home/.agents/skills/herdr"], pathDirs: [], fs: fsx });
    expect(p.docs("cmd")).toEqual(["/home/.agents/skills/herdr/SKILL.md"]);
  });
});

// Real (bounded, read-only) filesystem: the probe must keep the file's exact case
// and stat it — never lowercase the name and never run/install anything.
describe("createLocalMethodProbe — real mixed-case executables (bd review)", () => {
  function withTempExe(name: string, run: (exe: string, dir: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-method-"));
    try {
      const exe = path.join(dir, name);
      fs.writeFileSync(exe, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(exe, 0o755);
      run(exe, dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("resolves a mixed-case filename by its exact case, not a lowercased one", () => {
    withTempExe("BuildTool", (_exe, dir) => {
      const p = createLocalMethodProbe({ pathDirs: [dir], docRoots: [] });
      const resolved = p.which("BuildTool");
      expect(resolved).not.toBeNull();
      expect(path.basename(resolved!)).toBe("BuildTool"); // case preserved through discovery
    });
  });

  it("keeps a mixed-case path case-correct end-to-end through validateGoalMethods", () => {
    withTempExe("Deploy.sh", (exe) => {
      const p = createLocalMethodProbe({ pathDirs: [], docRoots: [] });
      const resolution = validateGoalMethods(`use ${exe}`, undefined, p);
      expect(resolution).toMatchObject({ status: "resolved", method: { command: exe }, resolvedPath: exe });
    });
  });

  it("classifies a missing mixed-case path as blocked without executing anything", () => {
    const missing = path.join(os.tmpdir(), "pibot-method-absent", "Deploy.sh");
    const p = createLocalMethodProbe({ pathDirs: [], docRoots: [] });
    const resolution = validateGoalMethods(`use ${missing}`, undefined, p);
    expect(resolution.status).toBe("blocked");
    if (resolution.status !== "blocked") return;
    expect(resolution.blocker.reason).toBe("unknown_method");
    expect(resolution.blocker.id).toBe(`method:${missing}:unknown_method`);
  });
});
