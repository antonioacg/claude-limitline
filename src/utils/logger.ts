import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Debug logging configuration — env vars work immediately, config applied via initLogger()
let DEBUG = process.env.CLAUDE_LIMITLINE_DEBUG === "true";
let LOG_FILE = process.env.CLAUDE_LIMITLINE_LOG_FILE;

/** Apply config-based logger settings. Env vars take priority. */
export function initLogger(config: { debug?: boolean; logFile?: string }): void {
  DEBUG = DEBUG || (config.debug === true);
  LOG_FILE = LOG_FILE || config.logFile;
}

// Ensure log directory exists
function ensureLogDir(logPath: string): void {
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // Ignore errors, we'll fallback to console
    }
  }
}

// Write to log file
function writeToLog(level: string, message: string): void {
  if (LOG_FILE) {
    try {
      ensureLogDir(LOG_FILE);
      const timestamp = new Date().toISOString();
      const logLine = `[${timestamp}] [${level}] ${message}\n`;
      fs.appendFileSync(LOG_FILE, logLine);
    } catch (err) {
      // Fallback to console if file writing fails
      console.error(`[LOGGER ERROR] Failed to write to ${LOG_FILE}:`, err);
    }
  }
}

export function debug(...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const message = args.map(arg =>
    typeof arg === "object" ? JSON.stringify(arg) : String(arg)
  ).join(" ");

  if (DEBUG) {
    console.error(`[${timestamp}] [DEBUG]`, ...args);
  }

  // Also write to file if configured
  writeToLog("DEBUG", message);
}

export function error(...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const message = args.map(arg =>
    typeof arg === "object" ? JSON.stringify(arg) : String(arg)
  ).join(" ");

  console.error(`[${timestamp}] [ERROR]`, ...args);
  writeToLog("ERROR", message);
}

export function info(...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const message = args.map(arg =>
    typeof arg === "object" ? JSON.stringify(arg) : String(arg)
  ).join(" ");

  writeToLog("INFO", message);
}
