// Per-session config for claude-harness (a.k.a. claude-rescue session-config).
// Mirrors the resolution chain implemented by lib/session-config.sh in that
// repo: built-in baseline → user defaults → per-session override.
//
// Paths follow the same XDG-style layout that claude-rescue uses:
//   $CLAUDE_RESCUE_CONFIG_HOME or $XDG_CONFIG_HOME/claude-rescue
//   $CLAUDE_RESCUE_DATA_HOME   or $XDG_DATA_HOME/claude-rescue
//
// Read-only — limitline never writes here; the popup editor owns writes.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface HarnessSessionConfig {
  ask_on_edits?: boolean;
  ask_on_bash?: boolean;
  editor_on_ask?: boolean;
  editor_command?: string;
}

const BUILTIN: HarnessSessionConfig = {
  ask_on_edits: false,
  ask_on_bash: false,
  editor_on_ask: false,
  editor_command: "code -g",
};

function dataHome(): string {
  if (process.env.CLAUDE_RESCUE_DATA_HOME) return process.env.CLAUDE_RESCUE_DATA_HOME;
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "claude-rescue");
}

function configHome(): string {
  if (process.env.CLAUDE_RESCUE_CONFIG_HOME) return process.env.CLAUDE_RESCUE_CONFIG_HOME;
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "claude-rescue");
}

function readJsonOrEmpty(p: string): Partial<HarnessSessionConfig> {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<HarnessSessionConfig>;
  } catch {
    return {};
  }
}

export function resolveHarnessConfig(
  sessionId: string | null | undefined,
): HarnessSessionConfig {
  const userDefaults = readJsonOrEmpty(
    path.join(configHome(), "session-config-defaults.json"),
  );
  const session = sessionId
    ? readJsonOrEmpty(path.join(dataHome(), "session-config", `${sessionId}.json`))
    : {};
  return { ...BUILTIN, ...userDefaults, ...session };
}
