import { afterEach, describe, expect, it } from "vitest";
import { childEnv } from "./child-env.js";

describe("childEnv", () => {
  afterEach(() => {
    delete process.env.FAKE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });
  it("excludes secrets, keeps base vars", () => {
    process.env.FAKE_API_KEY = "s3cret";
    const e = childEnv();
    expect(e.FAKE_API_KEY).toBeUndefined();
    expect(e.PATH).toBe(process.env.PATH);
    expect(e.HOME).toBe(process.env.HOME);
  });
  it("includes listed passthrough only when valid and present", () => {
    process.env.GEMINI_API_KEY = "g";
    process.env.FAKE_API_KEY = "s3cret";
    const e = childEnv({ passthrough: ["GEMINI_API_KEY", "lower", "MISSING_ONE"] });
    expect(e.GEMINI_API_KEY).toBe("g");
    expect(e.FAKE_API_KEY).toBeUndefined();
    expect("MISSING_ONE" in e).toBe(false);
  });
  it("passes LC_*/XDG_* and extra", () => {
    const e = childEnv({ source: { LC_ALL: "C", XDG_CONFIG_HOME: "/x", OTHER: "1" }, extra: { PI_X: "1" } });
    expect(e).toEqual({ LC_ALL: "C", XDG_CONFIG_HOME: "/x", PI_X: "1" });
  });
});
