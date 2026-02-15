/**
 * Anthropic API provider implementation
 * Handles OAuth token retrieval and usage API calls for Anthropic
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Provider, UsageResponse, BillingInfo } from "./types.js";
import { debug } from "../utils/logger.js";

const execAsync = promisify(exec);

interface AnthropicApiUsageBlock {
  resets_at?: string;
  utilization?: number;
}

interface AnthropicApiResponse {
  five_hour?: AnthropicApiUsageBlock;
  seven_day?: AnthropicApiUsageBlock;
  seven_day_opus?: AnthropicApiUsageBlock | null;
  seven_day_sonnet?: AnthropicApiUsageBlock | null;
  extra_usage?: {
    is_enabled: boolean;
    used_credits: number;
    currency?: string;
  };
}

export class AnthropicProvider implements Provider {
  readonly name = "Anthropic";
  readonly supportsUsage = true;

  async getToken(): Promise<string | null> {
    return getAnthropicOAuthToken();
  }

  async fetchUsage(): Promise<UsageResponse | null> {
    const token = await this.getToken();
    if (!token) {
      debug("No Anthropic OAuth token available");
      return null;
    }

    try {
      const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "claude-limitline/1.0.0",
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
      });

      if (!response.ok) {
        debug(`Anthropic usage API returned status ${response.status}: ${response.statusText}`);
        return null;
      }

      const data = (await response.json()) as AnthropicApiResponse;
      debug("Anthropic usage API response:", JSON.stringify(data));

      const windows: UsageResponse["windows"] = [];

      // Map Anthropic-specific windows to generic windows
      if (data.five_hour) {
        windows.push({
          name: "short",
          percentUsed: data.five_hour.utilization ?? 0,
          resetAt: data.five_hour.resets_at ? new Date(data.five_hour.resets_at) : new Date(),
          isOverLimit: (data.five_hour.utilization ?? 0) >= 100,
        });
      }

      if (data.seven_day) {
        windows.push({
          name: "weekly",
          percentUsed: data.seven_day.utilization ?? 0,
          resetAt: data.seven_day.resets_at ? new Date(data.seven_day.resets_at) : new Date(),
          isOverLimit: (data.seven_day.utilization ?? 0) >= 100,
        });
      }

      if (data.seven_day_opus) {
        windows.push({
          name: "weekly-opus",
          percentUsed: data.seven_day_opus.utilization ?? 0,
          resetAt: data.seven_day_opus.resets_at ? new Date(data.seven_day_opus.resets_at) : new Date(),
          isOverLimit: (data.seven_day_opus.utilization ?? 0) >= 100,
        });
      }

      if (data.seven_day_sonnet) {
        windows.push({
          name: "weekly-sonnet",
          percentUsed: data.seven_day_sonnet.utilization ?? 0,
          resetAt: data.seven_day_sonnet.resets_at ? new Date(data.seven_day_sonnet.resets_at) : new Date(),
          isOverLimit: (data.seven_day_sonnet.utilization ?? 0) >= 100,
        });
      }

      return {
        windows,
        raw: data,
      };
    } catch (error) {
      debug("Failed to fetch usage from Anthropic API:", error);
      return null;
    }
  }

  async fetchBilling(): Promise<BillingInfo | null> {
    const token = await this.getToken();
    if (!token) {
      debug("No Anthropic OAuth token available for billing");
      return null;
    }

    try {
      const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "claude-limitline/1.0.0",
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
      });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as AnthropicApiResponse;

      if (data.extra_usage) {
        return {
          spentAmount: data.extra_usage.used_credits,
          spentCurrency: data.extra_usage.currency ?? "BRL",
          isRealtime: true,
        };
      }

      return null;
    } catch (error) {
      debug("Failed to fetch billing from Anthropic API:", error);
      return null;
    }
  }
}

// ==================== Token Retrieval Functions ====================

async function getAnthropicOAuthToken(): Promise<string | null> {
  const platform = process.platform;

  debug(`Attempting to retrieve Anthropic OAuth token on platform: ${platform}`);

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

async function getOAuthTokenMacOS(): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `security find-generic-password -s "Claude Code-credentials" -w`,
      { timeout: 5000 }
    );
    const content = stdout.trim();

    if (content.startsWith("{")) {
      try {
        const parsed = JSON.parse(content);
        if (parsed.claudeAiOauth && typeof parsed.claudeAiOauth === "object") {
          const token = parsed.claudeAiOauth.accessToken;
          if (token && typeof token === "string" && token.startsWith("sk-ant-oat")) {
            debug("Found OAuth token in macOS Keychain under claudeAiOauth.accessToken");
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
  } catch (error) {
    debug("macOS Keychain retrieval failed:", error);
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
