/**
 * Kimi (Moonshot AI) Kimi Code provider implementation.
 * Fetches coding-plan usage from the Kimi Code API.
 *
 * Endpoint: GET https://api.kimi.com/coding/v1/usages
 * Auth: Bearer <ANTHROPIC_AUTH_TOKEN> (the sk-kimi-... coding-plan key).
 *
 * Moonshot gates api.kimi.com/coding/* behind a User-Agent allowlist (Apr 2026):
 * non-allowlisted clients get 403 access_terminated_error. Send an allowlisted
 * UA (KimiCLI/1.6) to match kimi-cli / kimi-code-usage / opencode-quota.
 *
 * Response shape (undocumented; parse defensively):
 *   { usage: {limit, used, remaining, resetTime},            // 7d (weekly) window
 *     limits: [{ window: {duration, timeUnit}, detail: {...} }] }  // 5h window
 * Field values are strings. window.duration is in timeUnit (TIME_UNIT_MINUTE / _DAY).
 */

import { type Provider, type UsageResponse, RateLimitError } from "./types.js";
import { debug } from "../utils/logger.js";

interface KimiWindowDetail {
  limit?: string;
  used?: string;
  remaining?: string;
  resetTime?: string;
}

interface KimiUsageResponse {
  usage?: KimiWindowDetail;            // top-level = weekly (7d) window
  limits?: Array<{
    window?: { duration?: number; timeUnit?: string };
    detail?: KimiWindowDetail;
  }>;
}

const USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const USER_AGENT = "KimiCLI/1.6"; // allowlisted by Moonshot's coding-API gateway

function windowMinutes(window?: { duration?: number; timeUnit?: string }): number {
  const d = window?.duration ?? 0;
  const unit = (window?.timeUnit ?? "").toUpperCase();
  const factor = unit.includes("DAY") ? 1440 : unit.includes("HOUR") ? 60 : 1; // MINUTE/default
  return d * factor;
}

function percentUsed(d: KimiWindowDetail): number {
  const limit = Number(d.limit);
  const used = Number(d.used);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used)) return 0;
  return (used / limit) * 100;
}

function toWindow(name: string, d: KimiWindowDetail) {
  const limit = Number(d.limit);
  return {
    name,
    percentUsed: percentUsed(d),
    resetAt: d.resetTime ? new Date(d.resetTime) : new Date(),
    isOverLimit: Number.isFinite(limit) && limit > 0 && Number(d.used) >= limit,
  };
}

export class KimiProvider implements Provider {
  readonly name = "Kimi";
  readonly supportsUsage = true;

  async getToken(): Promise<string | null> {
    // Same sk-kimi-... key Claude Code uses against api.kimi.com/coding/.
    const token = process.env.ANTHROPIC_AUTH_TOKEN;
    return token || null;
  }

  async fetchUsage(): Promise<UsageResponse | null> {
    const token = await this.getToken();
    if (!token) {
      debug("No Kimi token available");
      return null;
    }

    let response: Response;
    try {
      response = await fetch(USAGE_URL, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "User-Agent": USER_AGENT,
          accept: "application/json",
        },
      });
    } catch (error) {
      debug("Failed to reach Kimi usage API:", error);
      return null;
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      throw new RateLimitError(retryAfter ? Number(retryAfter) * 1000 : undefined);
    }

    if (!response.ok) {
      debug(`Kimi usage API returned status ${response.status}: ${response.statusText}`);
      return null;
    }

    const data = (await response.json()) as KimiUsageResponse;
    const windows: UsageResponse["windows"] = [];

    // limits[] entries — classify by window length (<1 day → short, else weekly)
    for (const lim of data.limits ?? []) {
      if (!lim.detail?.resetTime) continue;
      const mins = windowMinutes(lim.window);
      const name = mins > 0 && mins < 1440 ? "short" : "weekly";
      windows.push(toWindow(name, lim.detail));
    }

    // Top-level `usage` is the weekly (7d) window; use it if no weekly yet.
    if (data.usage?.resetTime && !windows.some(w => w.name === "weekly")) {
      windows.push(toWindow("weekly", data.usage));
    }

    if (windows.length === 0) {
      debug("Kimi usage response had no usable windows");
      return null;
    }

    debug(`Kimi usage: ${windows.map(w => `${w.name}=${Math.round(w.percentUsed)}%`).join(", ")}`);
    return { windows, raw: data };
  }
}
