import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveHarnessConfig } from "./harness-config.js";

vi.mock("node:fs");
vi.mock("node:os");

// These keys mirror lib/session-config.sh's session_config_builtin() in
// claude-rescue. If that baseline gains a knob the indicator should surface,
// this file must gain it too — this suite is the drift alarm.
describe("resolveHarnessConfig", () => {
  const dataHome = "/home/user/.local/share/claude-rescue";
  const sessionPath = (sid: string) =>
    path.join(dataHome, "session-config", `${sid}.json`);

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue("/home/user");
    delete process.env.CLAUDE_RESCUE_DATA_HOME;
    delete process.env.CLAUDE_RESCUE_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults suspend_hibernation to false when nothing overrides it", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(resolveHarnessConfig("sid-1").suspend_hibernation).toBe(false);
  });

  it("reads suspend_hibernation:true from the per-session override", () => {
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === sessionPath("sid-1")) {
        return JSON.stringify({ suspend_hibernation: true });
      }
      throw new Error("ENOENT");
    });
    expect(resolveHarnessConfig("sid-1").suspend_hibernation).toBe(true);
  });

  it("exposes the full claude-rescue builtin baseline (drift guard)", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(resolveHarnessConfig(null)).toMatchObject({
      ask_on_edits: false,
      ask_on_bash: false,
      editor_on_edits: false,
      suspend_hibernation: false,
    });
  });
});
