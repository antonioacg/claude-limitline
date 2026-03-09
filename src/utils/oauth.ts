/**
 * OAuth and usage data utilities
 * Bridges provider abstraction with file-based caching layer.
 *
 * Token retrieval: src/utils/token.ts
 * Cache/lock/backoff: src/utils/cache.ts
 * Providers: src/providers/
 */

import type { UsageResponse, BillingInfo, TrendDirection } from "../providers/types.js";
import { RateLimitError } from "../providers/types.js";
import { getCurrentProvider, clearProviderCache } from "../providers/index.js";
import {
  initCacheConfig,
  readFileCache,
  writeFileCache,
  acquireLock,
  releaseLock,
  recordBackoff,
  clearBackoff,
  clearAllCaches,
  type FileCache,
} from "./cache.js";
import { debug } from "./logger.js";

// ==================== Init ====================

/** Apply budget config for backoff timing. Call once after config loads. */
export function initOAuth(config: { backoffBase?: number; backoffMax?: number }): void {
  initCacheConfig(config);
}

// ==================== Legacy types (matching upstream) ====================

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

// ==================== Usage cache ====================

let cachedUsage: UsageResponse | null = null;
let previousUsage: UsageResponse | null = null;
let cacheTimestamp = 0;
let usageInflight: Promise<OAuthUsageResponse | null> | null = null;

/** Reconstruct Date objects from JSON-serialized UsageResponse */
function hydrateUsageResponse(raw: UsageResponse): UsageResponse {
  return {
    windows: raw.windows.map(w => ({ ...w, resetAt: new Date(w.resetAt) })),
    raw: raw.raw,
  };
}

/** Convert new UsageResponse to legacy OAuthUsageResponse */
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

// ==================== Trend tracking ====================

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

// ==================== Usage fetching ====================

export async function getRealtimeUsage(
  pollIntervalMinutes: number = 15
): Promise<OAuthUsageResponse | null> {
  const now = Date.now();
  const cacheAgeMs = now - cacheTimestamp;
  const pollIntervalMs = pollIntervalMinutes * 60 * 1000;

  if (cachedUsage && cacheAgeMs < pollIntervalMs) {
    debug(`Using cached usage data (age: ${Math.round(cacheAgeMs / 1000)}s)`);
    return toLegacyUsageResponse(cachedUsage);
  }

  if (usageInflight) {
    debug("Joining in-flight usage request");
    return usageInflight;
  }

  usageInflight = doFetchUsage(pollIntervalMinutes);
  try {
    return await usageInflight;
  } finally {
    usageInflight = null;
  }
}

async function doFetchUsage(
  pollIntervalMinutes: number
): Promise<OAuthUsageResponse | null> {
  const provider = await getCurrentProvider();
  if (!provider) {
    debug("Could not detect a provider for realtime usage");
    return null;
  }

  const name = provider.name;
  const pollIntervalMs = pollIntervalMinutes * 60 * 1000;
  const fileCache = readFileCache(name);

  // L2: File cache — another process may have fetched recently
  if (fileCache?.usage && (Date.now() - fileCache.usage.ts) < pollIntervalMs) {
    const usage = hydrateUsageResponse(fileCache.usage.data);
    previousUsage = cachedUsage;
    cachedUsage = usage;
    cacheTimestamp = fileCache.usage.ts;
    debug(`Using ${name} file cache for usage (age: ${Math.round((Date.now() - fileCache.usage.ts) / 1000)}s)`);
    return toLegacyUsageResponse(usage);
  }

  // Check rate limit backoff
  if (fileCache?.backoff && Date.now() < fileCache.backoff.until) {
    debug(`${name} rate limit backoff active until ${new Date(fileCache.backoff.until).toISOString()}`);
    if (fileCache.usage) {
      return toLegacyUsageResponse(hydrateUsageResponse(fileCache.usage.data));
    }
    return null;
  }

  // Try to acquire lock — if another process is fetching, use stale cache
  if (!acquireLock(name)) {
    debug(`${name} lock held by another process, using stale file cache`);
    if (fileCache?.usage) {
      return toLegacyUsageResponse(hydrateUsageResponse(fileCache.usage.data));
    }
    return null;
  }

  try {
    const usage = await provider.fetchUsage();
    if (usage) {
      previousUsage = cachedUsage;
      cachedUsage = usage;
      cacheTimestamp = Date.now();
      const updated = clearBackoff(fileCache);
      updated.usage = { ts: Date.now(), data: usage };
      writeFileCache(name, updated);
      debug(`Refreshed usage cache from ${name} provider`);
    } else {
      debug(`Provider ${name} returned no usage data`);
    }

    return usage ? toLegacyUsageResponse(usage) : null;
  } catch (error) {
    if (error instanceof RateLimitError) {
      recordBackoff(name, fileCache, error.retryAfterMs);
    } else {
      debug("Error fetching usage:", error);
    }
    if (fileCache?.usage) {
      return toLegacyUsageResponse(hydrateUsageResponse(fileCache.usage.data));
    }
    return null;
  } finally {
    releaseLock(name);
  }
}

export function clearUsageCache(): void {
  cachedUsage = null;
  previousUsage = null;
  cacheTimestamp = 0;
}

// ==================== Billing API ====================

let cachedBilling: BillingInfo | null = null;
let billingCacheTimestamp = 0;
let billingInflight: Promise<BillingInfo | null> | null = null;

export async function getBillingInfo(
  pollIntervalMinutes: number = 15
): Promise<BillingInfo | null> {
  const now = Date.now();
  const cacheAgeMs = now - billingCacheTimestamp;
  const pollIntervalMs = pollIntervalMinutes * 60 * 1000;

  if (cachedBilling && cacheAgeMs < pollIntervalMs) {
    debug(`Using cached billing data (age: ${Math.round(cacheAgeMs / 1000)}s)`);
    return cachedBilling;
  }

  if (billingInflight) {
    debug("Joining in-flight billing request");
    return billingInflight;
  }

  billingInflight = doFetchBilling(pollIntervalMinutes);
  try {
    return await billingInflight;
  } finally {
    billingInflight = null;
  }
}

async function doFetchBilling(
  pollIntervalMinutes: number
): Promise<BillingInfo | null> {
  const provider = await getCurrentProvider();
  if (!provider) {
    debug("Could not detect a provider for billing info");
    return null;
  }

  const name = provider.name;
  const pollIntervalMs = pollIntervalMinutes * 60 * 1000;
  const fileCache = readFileCache(name);

  if (fileCache?.billing && (Date.now() - fileCache.billing.ts) < pollIntervalMs) {
    cachedBilling = fileCache.billing.data;
    billingCacheTimestamp = fileCache.billing.ts;
    debug(`Using ${name} file cache for billing (age: ${Math.round((Date.now() - fileCache.billing.ts) / 1000)}s)`);
    return cachedBilling;
  }

  if (fileCache?.backoff && Date.now() < fileCache.backoff.until) {
    debug(`${name} rate limit backoff active for billing`);
    return fileCache?.billing?.data ?? null;
  }

  if (!acquireLock(name)) {
    debug(`${name} lock held by another process, using stale billing cache`);
    return fileCache?.billing?.data ?? null;
  }

  try {
    if (provider.fetchBilling) {
      const billing = await provider.fetchBilling();
      if (billing) {
        cachedBilling = billing;
        billingCacheTimestamp = Date.now();
        const updated = clearBackoff(fileCache);
        updated.billing = { ts: Date.now(), data: billing };
        writeFileCache(name, updated);
        debug(`Refreshed billing cache from ${name} provider`);
        return billing;
      }
    }

    debug(`Provider ${name} does not support billing data`);
    return null;
  } catch (error) {
    if (error instanceof RateLimitError) {
      recordBackoff(name, fileCache, error.retryAfterMs);
    } else {
      debug("Error fetching billing:", error);
    }
    return fileCache?.billing?.data ?? null;
  } finally {
    releaseLock(name);
  }
}

export function clearBillingCache(): void {
  cachedBilling = null;
  billingCacheTimestamp = 0;
}

export { clearAllCaches as clearFileCache } from "./cache.js";

// Re-export provider functions for convenience
export { getCurrentProvider, clearProviderCache } from "../providers/index.js";
