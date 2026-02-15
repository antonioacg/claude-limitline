/**
 * OAuth and usage data utilities
 * Uses provider abstraction to support multiple API providers (Anthropic, Moonshot, etc.)
 */

import type { UsageResponse, BillingInfo, TrendDirection } from "../providers/types.js";
import { getCurrentProvider, clearProviderCache } from "../providers/index.js";
import { debug } from "./logger.js";

// Legacy interfaces for backward compatibility
export interface UsageData {
  resetAt: Date;
  percentUsed: number;
  isOverLimit: boolean;
}

export interface OAuthUsageResponse {
  fiveHour: UsageData | null;
  sevenDay: UsageData | null;
  sevenDayOpus: UsageData | null;
  sevenDaySonnet: UsageData | null;
  raw?: unknown;
}

export type { TrendDirection };

export interface TrendInfo {
  fiveHourTrend: TrendDirection;
  sevenDayTrend: TrendDirection;
  sevenDayOpusTrend: TrendDirection;
  sevenDaySonnetTrend: TrendDirection;
}

// Cache for API responses to avoid hitting rate limits
let cachedUsage: UsageResponse | null = null;
let previousUsage: UsageResponse | null = null;
let cacheTimestamp = 0;

export function getUsageTrend(): TrendInfo {
  const result: TrendInfo = {
    fiveHourTrend: null,
    sevenDayTrend: null,
    sevenDayOpusTrend: null,
    sevenDaySonnetTrend: null,
  };

  if (!cachedUsage || !previousUsage) {
    return result;
  }

  const compareTrend = (
    currentName: string,
    previousName: string
  ): TrendDirection => {
    const current = cachedUsage!.windows.find(w => w.name === currentName);
    const previous = previousUsage!.windows.find(w => w.name === previousName);
    if (!current || !previous) return null;
    const diff = current.percentUsed - previous.percentUsed;
    if (diff > 0.5) return "up";
    if (diff < -0.5) return "down";
    return "same";
  };

  result.fiveHourTrend = compareTrend("short", "short");
  result.sevenDayTrend = compareTrend("weekly", "weekly");
  result.sevenDayOpusTrend = compareTrend("weekly-opus", "weekly-opus");
  result.sevenDaySonnetTrend = compareTrend("weekly-sonnet", "weekly-sonnet");

  return result;
}

/**
 * Convert new UsageResponse to legacy OAuthUsageResponse for backward compatibility
 */
function toLegacyUsageResponse(response: UsageResponse): OAuthUsageResponse {
  const findWindow = (name: string): UsageData | null => {
    const window = response.windows.find(w => w.name === name);
    if (!window) return null;
    return {
      resetAt: window.resetAt,
      percentUsed: window.percentUsed,
      isOverLimit: window.isOverLimit,
    };
  };

  return {
    fiveHour: findWindow("short"),
    sevenDay: findWindow("weekly"),
    sevenDayOpus: findWindow("weekly-opus"),
    sevenDaySonnet: findWindow("weekly-sonnet"),
    raw: response.raw,
  };
}

export async function getRealtimeUsage(
  pollIntervalMinutes: number = 15
): Promise<OAuthUsageResponse | null> {
  const now = Date.now();
  const cacheAgeMs = now - cacheTimestamp;
  const pollIntervalMs = pollIntervalMinutes * 60 * 1000;

  // Return cached data if still fresh
  if (cachedUsage && cacheAgeMs < pollIntervalMs) {
    debug(`Using cached usage data (age: ${Math.round(cacheAgeMs / 1000)}s)`);
    return toLegacyUsageResponse(cachedUsage);
  }

  // Get provider
  const provider = await getCurrentProvider();
  if (!provider) {
    debug("Could not detect a provider for realtime usage");
    return null;
  }

  // Fetch fresh data
  const usage = await provider.fetchUsage();
  if (usage) {
    previousUsage = cachedUsage;
    cachedUsage = usage;
    cacheTimestamp = now;
    debug(`Refreshed realtime usage cache from ${provider.name} provider`);
  } else {
    debug(`Provider ${provider.name} returned no usage data`);
  }

  return usage ? toLegacyUsageResponse(usage) : null;
}

export function clearUsageCache(): void {
  cachedUsage = null;
  previousUsage = null;
  cacheTimestamp = 0;
}

// ==================== Billing API ====================

// Cache for billing data
let cachedBilling: BillingInfo | null = null;
let billingCacheTimestamp = 0;

export async function getBillingInfo(
  pollIntervalMinutes: number = 15
): Promise<BillingInfo | null> {
  const now = Date.now();
  const cacheAgeMs = now - billingCacheTimestamp;
  const pollIntervalMs = pollIntervalMinutes * 60 * 1000;

  // Return cached data if still fresh
  if (cachedBilling && cacheAgeMs < pollIntervalMs) {
    debug(`Using cached billing data (age: ${Math.round(cacheAgeMs / 1000)}s)`);
    return cachedBilling;
  }

  // Get provider
  const provider = await getCurrentProvider();
  if (!provider) {
    debug("Could not detect a provider for billing info");
    return null;
  }

  // Fetch billing data if provider supports it
  if (provider.fetchBilling) {
    const billing = await provider.fetchBilling();
    if (billing) {
      cachedBilling = billing;
      billingCacheTimestamp = now;
      debug(`Refreshed billing cache from ${provider.name} provider`);
      return billing;
    }
  }

  debug(`Provider ${provider.name} does not support billing data`);
  return null;
}

export function clearBillingCache(): void {
  cachedBilling = null;
  billingCacheTimestamp = 0;
}

// Re-export provider functions for convenience
export { getCurrentProvider, clearProviderCache } from "../providers/index.js";
