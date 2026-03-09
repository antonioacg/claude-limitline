/**
 * OAuth token retrieval for Anthropic
 * Platform-specific Keychain/Credential Manager/secret-tool integration
 *
 * This module mirrors upstream's token retrieval code from oauth.ts.
 * When syncing with upstream, update this file with their token changes.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { debug } from "./logger.js";

const execAsync = promisify(exec);

export async function getOAuthToken(): Promise<string | null> {
  const platform = process.platform;

  debug(`Attempting to retrieve OAuth token on platform: ${platform}`);

  switch (platform) {
    case "win32":
      return getOAuthTokenWindows();
    case "darwin":
      return getOAuthTokenMacOS();
    case "linux":
      return getOAuthTokenLinux();
    default:
      debug(`Unsupported platform for OAuth token retrieval: ${platform}`);
      return null;
  }
}

async function getOAuthTokenWindows(): Promise<string | null> {
  try {
    // Try PowerShell to access Windows Credential Manager
    const { stdout } = await execAsync(
      `powershell -Command "[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String((Get-StoredCredential -Target 'Claude Code' -AsCredentialObject).Password))"`,
      { timeout: 5000 }
    );
    const token = stdout.trim();
    if (token && token.startsWith("sk-ant-oat")) {
      return token;
    }
  } catch (error) {
    debug("PowerShell credential retrieval failed:", error);
  }

  // Try looking in common Claude Code config locations
  const primaryPath = path.join(os.homedir(), ".claude", ".credentials.json");
  try {
    if (fs.existsSync(primaryPath)) {
      const content = fs.readFileSync(primaryPath, "utf-8");
      const config = JSON.parse(content);

      if (config.claudeAiOauth && typeof config.claudeAiOauth === "object") {
        const token = config.claudeAiOauth.accessToken;
        if (token && typeof token === "string" && token.startsWith("sk-ant-oat")) {
          debug(`Found OAuth token in ${primaryPath} under claudeAiOauth.accessToken`);
          return token;
        }
      }
    }
  } catch (error) {
    debug(`Failed to read config from ${primaryPath}:`, error);
  }

  // Fallback locations
  const fallbackPaths = [
    path.join(os.homedir(), ".claude", "credentials.json"),
    path.join(os.homedir(), ".config", "claude-code", "credentials.json"),
    path.join(process.env.APPDATA || "", "Claude Code", "credentials.json"),
    path.join(process.env.LOCALAPPDATA || "", "Claude Code", "credentials.json"),
  ];

  for (const configPath of fallbackPaths) {
    try {
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, "utf-8");
        const config = JSON.parse(content);

        for (const key of ["oauth_token", "token", "accessToken"]) {
          const token = config[key];
          if (token && typeof token === "string" && token.startsWith("sk-ant-oat")) {
            debug(`Found OAuth token in ${configPath} under key ${key}`);
            return token;
          }
        }
      }
    } catch (error) {
      debug(`Failed to read config from ${configPath}:`, error);
    }
  }

  return null;
}

// Discover the correct Keychain service name. Claude Code may use a hash-suffixed
// name (e.g. "Claude Code-credentials-697375ae") instead of the legacy "Claude Code-credentials".
async function findKeychainServiceName(): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `security dump-keychain 2>/dev/null | grep -o '"Claude Code-credentials[^"]*"'`,
      { timeout: 5000 }
    );
    // Pick the longest match — the hash-suffixed variant is more specific than the legacy name
    const matches = stdout
      .trim()
      .split("\n")
      .map((s) => s.replace(/^"|"$/g, ""))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    if (matches.length > 0) {
      debug(`Found keychain service: ${matches[0]}`);
      return matches[0];
    }
  } catch (error) {
    debug("Keychain service name lookup failed:", error);
  }
  return "Claude Code-credentials";
}

function extractTokenFromKeychainContent(content: string): string | null {
  if (content.startsWith("{")) {
    try {
      const parsed = JSON.parse(content);
      if (parsed.claudeAiOauth && typeof parsed.claudeAiOauth === "object") {
        const token = parsed.claudeAiOauth.accessToken;
        if (token && typeof token === "string" && token.startsWith("sk-ant-oat")) {
          return token;
        }
      }
    } catch (parseError) {
      debug("Failed to parse keychain JSON:", parseError);
    }
  }
  if (content.startsWith("sk-ant-oat")) {
    return content;
  }
  return null;
}

async function getOAuthTokenMacOS(): Promise<string | null> {
  // Discover the correct service name (handles hash-suffixed entries)
  const serviceName = await findKeychainServiceName();

  for (const name of [serviceName, "Claude Code-credentials"]) {
    try {
      const { stdout } = await execAsync(
        `security find-generic-password -s "${name}" -w`,
        { timeout: 5000 }
      );
      const token = extractTokenFromKeychainContent(stdout.trim());
      if (token) {
        debug(`Found OAuth token in macOS Keychain (${name})`);
        return token;
      }
    } catch (error) {
      debug(`macOS Keychain retrieval failed for "${name}":`, error);
    }
  }

  // Fallback to config file locations (same as Linux)
  const configPaths = [
    path.join(os.homedir(), ".claude", ".credentials.json"),
    path.join(os.homedir(), ".claude", "credentials.json"),
    path.join(os.homedir(), ".config", "claude-code", "credentials.json"),
  ];

  for (const configPath of configPaths) {
    try {
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, "utf-8");
        const config = JSON.parse(content);

        if (config.claudeAiOauth && typeof config.claudeAiOauth === "object") {
          const token = config.claudeAiOauth.accessToken;
          if (token && typeof token === "string" && token.startsWith("sk-ant-oat")) {
            debug(`Found OAuth token in ${configPath} under claudeAiOauth.accessToken`);
            return token;
          }
        }

        for (const key of ["oauth_token", "token", "accessToken"]) {
          const token = config[key];
          if (token && typeof token === "string" && token.startsWith("sk-ant-oat")) {
            debug(`Found OAuth token in ${configPath} under key ${key}`);
            return token;
          }
        }
      }
    } catch (error) {
      debug(`Failed to read config from ${configPath}:`, error);
    }
  }

  return null;
}

async function getOAuthTokenLinux(): Promise<string | null> {
  // Try secret-tool (GNOME Keyring)
  try {
    const { stdout } = await execAsync(
      `secret-tool lookup service "Claude Code"`,
      { timeout: 5000 }
    );
    const token = stdout.trim();
    if (token && token.startsWith("sk-ant-oat")) {
      return token;
    }
  } catch (error) {
    debug("Linux secret-tool retrieval failed:", error);
  }

  // Try config file locations
  const configPaths = [
    path.join(os.homedir(), ".claude", ".credentials.json"),
    path.join(os.homedir(), ".claude", "credentials.json"),
    path.join(os.homedir(), ".config", "claude-code", "credentials.json"),
  ];

  for (const configPath of configPaths) {
    try {
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, "utf-8");
        const config = JSON.parse(content);

        if (config.claudeAiOauth && typeof config.claudeAiOauth === "object") {
          const token = config.claudeAiOauth.accessToken;
          if (token && typeof token === "string" && token.startsWith("sk-ant-oat")) {
            debug(`Found OAuth token in ${configPath} under claudeAiOauth.accessToken`);
            return token;
          }
        }

        for (const key of ["oauth_token", "token", "accessToken"]) {
          const token = config[key];
          if (token && typeof token === "string" && token.startsWith("sk-ant-oat")) {
            debug(`Found OAuth token in ${configPath} under key ${key}`);
            return token;
          }
        }
      }
    } catch (error) {
      debug(`Failed to read config from ${configPath}:`, error);
    }
  }

  return null;
}
