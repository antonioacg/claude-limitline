import { execSync } from "child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { basename } from "path";
import { debug } from "./logger.js";
import { type ClaudeHookData, formatModelName } from "./claude-hook.js";
import type { KubeSegmentConfig } from "../config/types.js";

/**
 * Get the current directory/repo name
 */
export function getDirectoryName(hookData?: ClaudeHookData | null): string | null {
  try {
    // Use workspace from hook data if available - prefer current_dir over project_dir
    if (hookData?.workspace?.current_dir) {
      return basename(hookData.workspace.current_dir);
    }
    if (hookData?.workspace?.project_dir) {
      return basename(hookData.workspace.project_dir);
    }
    if (hookData?.cwd) {
      return basename(hookData.cwd);
    }
    return basename(process.cwd());
  } catch (error) {
    debug("Error getting directory name:", error);
    return null;
  }
}

/**
 * Get the current git branch name
 */
export function getGitBranch(cwd?: string): string | null {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: cwd || process.cwd(),
    }).trim();
    return branch || null;
  } catch (error) {
    debug("Error getting git branch:", error);
    return null;
  }
}

const GIT_FETCH_CACHE_FILE = path.join(os.homedir(), ".cache", "claude-limitline", "git-fetch.json");
const GIT_FETCH_CACHE_MS = 300;

/**
 * Get ahead/behind counts relative to upstream, with cached background fetch.
 */
export function getGitAheadBehind(cwd?: string): GitAheadBehind | null {
  const dir = cwd || process.cwd();
  try {
    // Background fetch: only if cache is stale
    let shouldFetch = true;
    try {
      const stat = fs.statSync(GIT_FETCH_CACHE_FILE);
      shouldFetch = Date.now() - stat.mtimeMs >= GIT_FETCH_CACHE_MS;
    } catch { /* no cache yet */ }

    if (shouldFetch) {
      try {
        execSync("git fetch --quiet", {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          cwd: dir,
          timeout: 3000,
        });
        fs.mkdirSync(path.dirname(GIT_FETCH_CACHE_FILE), { recursive: true });
        fs.writeFileSync(GIT_FETCH_CACHE_FILE, JSON.stringify({ ts: Date.now(), cwd: dir }));
      } catch { /* fetch failed, still show local counts */ }
    }

    const output = execSync("git rev-list --left-right --count HEAD...@{upstream}", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: dir,
      timeout: 500,
    }).trim();
    const [ahead, behind] = output.split(/\s+/).map(Number);
    return { ahead: ahead || 0, behind: behind || 0 };
  } catch {
    debug("Error getting git ahead/behind (no upstream?)");
    return null;
  }
}

/**
 * Check if the git repo has uncommitted changes
 */
export function hasGitChanges(cwd?: string): boolean {
  try {
    const status = execSync("git status --porcelain", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: cwd || process.cwd(),
    }).trim();
    return status.length > 0;
  } catch (error) {
    debug("Error checking git status:", error);
    return false;
  }
}

/**
 * Get the Claude model from hook data or environment variable
 */
export function getClaudeModel(hookData?: ClaudeHookData | null): string | null {
  // First try hook data (most reliable)
  if (hookData?.model?.id) {
    return formatModelName(hookData.model.id, hookData.model.display_name);
  }

  // Fall back to environment variables
  const model = process.env.CLAUDE_MODEL
    || process.env.CLAUDE_CODE_MODEL
    || process.env.ANTHROPIC_MODEL;

  if (model) {
    return formatModelName(model);
  }

  return null;
}

export interface GitAheadBehind {
  ahead: number;
  behind: number;
}

export interface EnvironmentInfo {
  directory: string | null;
  gitBranch: string | null;
  gitDirty: boolean;
  gitAheadBehind: GitAheadBehind | null;
  model: string | null;
  contextPercent: number;
  sessionId: string | null;
  sshSession: boolean;
  kubeContext: string | null;
}

const KUBE_CACHE_FILE = path.join(os.homedir(), ".cache", "claude-limitline", "kube-context.json");
const KUBE_CACHE_MS = 300;

/**
 * Get the current kubectl context, cached to avoid repeated subprocess calls.
 * Contexts in hideContexts are filtered out (returns null).
 */
export function getKubeContext(hideContexts: string[]): string | null {
  const hidden = new Set(hideContexts);

  try {
    const stat = fs.statSync(KUBE_CACHE_FILE);
    if (Date.now() - stat.mtimeMs < KUBE_CACHE_MS) {
      const cached = JSON.parse(fs.readFileSync(KUBE_CACHE_FILE, "utf-8"));
      const ctx = cached.context as string | null;
      return ctx && hidden.has(ctx) ? null : ctx;
    }
  } catch { /* cache miss */ }

  try {
    const context = execSync("kubectl config current-context", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 500,
    }).trim();
    try {
      fs.mkdirSync(path.dirname(KUBE_CACHE_FILE), { recursive: true });
      fs.writeFileSync(KUBE_CACHE_FILE, JSON.stringify({ context }));
    } catch { /* cache write failed, non-fatal */ }
    return hidden.has(context) ? null : context;
  } catch {
    debug("kubectl not available or no context set");
    return null;
  }
}

/**
 * Calculate context window usage percentage from hook data
 */
export function getContextPercent(hookData?: ClaudeHookData | null): number {
  const ctx = hookData?.context_window;
  if (!ctx?.current_usage || !ctx.context_window_size) {
    return 0;
  }

  const usage = ctx.current_usage;
  const totalTokens =
    (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0);

  return Math.round((totalTokens / ctx.context_window_size) * 100);
}

/**
 * Get all environment info at once
 */
export function getEnvironmentInfo(hookData?: ClaudeHookData | null, kubeConfig?: KubeSegmentConfig): EnvironmentInfo {
  const cwd = hookData?.workspace?.current_dir || hookData?.workspace?.project_dir || hookData?.cwd;
  debug("Git cwd:", cwd);
  return {
    directory: getDirectoryName(hookData),
    gitBranch: cwd ? getGitBranch(cwd) : null,
    gitDirty: cwd ? hasGitChanges(cwd) : false,
    gitAheadBehind: cwd ? getGitAheadBehind(cwd) : null,
    model: getClaudeModel(hookData),
    contextPercent: getContextPercent(hookData),
    sessionId: hookData?.session_id ?? null,
    sshSession: !!(process.env.SSH_TTY || process.env.SSH_CONNECTION),
    kubeContext: kubeConfig?.enabled ? getKubeContext(kubeConfig.hideContexts ?? []) : null,
  };
}
