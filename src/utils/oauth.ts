/**
 * OAuth and usage data utilities
 * Uses provider abstraction to support multiple API providers (Anthropic, Moonshot, etc.)
 *
 * Rate limit protection (cross-process):
 * - File-based cache: ~/.cache/claude-limitline/api-cache.json
 * - Lockfile: ~/.cache/claude-limitline/api-cache.lock
 * - Exponential backoff on 429 responses (60s, 120s, 240s, max 300s)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { UsageResponse, BillingInfo, TrendDirection } from "../providers/types.js";
import { RateLimitError } from "../providers/types.js";
import { getCurrentProvider, clearProviderCache } from "../providers/index.js";
import { debug } from "./logger.js";

// ==================== File-based cache (cross-process) ====================

const CACHE_DIR = path.join(os.homedir(), ".cache", "claude-limitline");
const CACHE_FILE = path.join(CACHE_DIR, "api-cache.json");
const LOCK_FILE = path.join(CACHE_DIR, "api-cache.lock");
const LOCK_STALE_MS = 30_000;

interface FileCacheEntry<T> {
  ts: number;
  data: T;
}

interface FileCache {
  usage?: FileCacheEntry<UsageResponse>;
  billing?: FileCacheEntry<BillingInfo>;
  backoff?: { until: number; consecutive: number };
}

function readFileCache(): FileCache | null {
  try {
    const content = fs.readFileSync(CACHE_FILE, "utf-8");
    return JSON.parse(content) as FileCache;
  } catch {
    return null;
  }
}

function writeFileCache(cache: FileCache): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), "utf-8");
  } catch (error) {
    debug("Failed to write file cache:", error);
  }
}

function acquireLock(): boolean {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    // Lock exists — check if stale (crashed process)
    try {
      const stat = fs.statSync(LOCK_FILE);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        fs.unlinkSync(LOCK_FILE);
        fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
        return true;
      }
    } catch { /* lost race or can't stat — another process is active */ }
    return false;
  }
}

function releaseLock(): void {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* already cleaned up */ }
}

/** Reconstruct Date objects from JSON-serialized UsageResponse */
function hydrateUsageResponse(raw: UsageResponse): UsageResponse {
  return {
    windows: raw.windows.map(w => ({ ...w, resetAt: new Date(w.resetAt) })),
    raw: raw.raw,
  };
}

function recordBackoff(fileCache: FileCache | null, retryAfterMs?: number): void {
  const prev = fileCache?.backoff;
  const consecutive = (prev?.consecutive ?? 0) + 1;
  const backoffMs = retryAfterMs ?? Math.min(60_000 * Math.pow(2, consecutive - 1), 300_000);
  const updated: FileCache = {
    ...fileCache,
    backoff: { until: Date.now() + backoffMs, consecutive },
  };
  writeFileCache(updated);
  debug(`Rate limited — backing off ${Math.round(backoffMs / 1000)}s (attempt ${consecutive})`);
}

function clearBackoff(fileCache: FileCache | null): FileCache {
  const updated: FileCache = { ...fileCache };
  delete updated.backoff;
  return updated;
}

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
// In-flight request deduplication: concurrent callers share one fetch
let usageInflight: Promise<OAuthUsageResponse | null> | null = null;

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

  // Deduplicate concurrent callers (block + weekly both call this via Promise.all)
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
  const pollIntervalMs = pollIntervalMinutes * 60 * 1000;
  const fileCache = readFileCache();

  // L2: File cache — another process may have fetched recently
  if (fileCache?.usage && (Date.now() - fileCache.usage.ts) < pollIntervalMs) {
    const usage = hydrateUsageResponse(fileCache.usage.data);
    previousUsage = cachedUsage;
    cachedUsage = usage;
    cacheTimestamp = fileCache.usage.ts;
    debug(`Using file cache for usage (age: ${Math.round((Date.now() - fileCache.usage.ts) / 1000)}s)`);
    return toLegacyUsageResponse(usage);
  }

  // Check rate limit backoff
  if (fileCache?.backoff && Date.now() < fileCache.backoff.until) {
    debug(`Rate limit backoff active until ${new Date(fileCache.backoff.until).toISOString()}`);
    if (fileCache.usage) {
      return toLegacyUsageResponse(hydrateUsageResponse(fileCache.usage.data));
    }
    return null;
  }

  // Try to acquire lock — if another process is fetching, use stale cache
  const locked = acquireLock();
  if (!locked) {
    debug("Lock held by another process, using stale file cache");
    if (fileCache?.usage) {
      return toLegacyUsageResponse(hydrateUsageResponse(fileCache.usage.data));
    }
    return null;
  }

  try {
    const provider = await getCurrentProvider();
    if (!provider) {
      debug("Could not detect a provider for realtime usage");
      return null;
    }

    const usage = await provider.fetchUsage();
    if (usage) {
      previousUsage = cachedUsage;
      cachedUsage = usage;
      cacheTimestamp = Date.now();
      const updated = clearBackoff(fileCache);
      updated.usage = { ts: Date.now(), data: usage };
      writeFileCache(updated);
      debug(`Refreshed usage cache from ${provider.name} provider`);
    } else {
      debug(`Provider ${provider.name} returned no usage data`);
    }

    return usage ? toLegacyUsageResponse(usage) : null;
  } catch (error) {
    if (error instanceof RateLimitError) {
      recordBackoff(fileCache, error.retryAfterMs);
    } else {
      debug("Error fetching usage:", error);
    }
    // Return stale data if available
    if (fileCache?.usage) {
      return toLegacyUsageResponse(hydrateUsageResponse(fileCache.usage.data));
    }
    return null;
  } finally {
    releaseLock();
  }
}

export function clearUsageCache(): void {
  cachedUsage = null;
  previousUsage = null;
  cacheTimestamp = 0;
}

export function clearFileCache(): void {
  try { fs.unlinkSync(CACHE_FILE); } catch { /* not present */ }
  try { fs.unlinkSync(LOCK_FILE); } catch { /* not present */ }
}

// ==================== Billing API ====================

// Cache for billing data
let cachedBilling: BillingInfo | null = null;
let billingCacheTimestamp = 0;
let billingInflight: Promise<BillingInfo | null> | null = null;

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

  // Deduplicate concurrent callers
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
  const pollIntervalMs = pollIntervalMinutes * 60 * 1000;
  const fileCache = readFileCache();

  // L2: File cache
  if (fileCache?.billing && (Date.now() - fileCache.billing.ts) < pollIntervalMs) {
    cachedBilling = fileCache.billing.data;
    billingCacheTimestamp = fileCache.billing.ts;
    debug(`Using file cache for billing (age: ${Math.round((Date.now() - fileCache.billing.ts) / 1000)}s)`);
    return cachedBilling;
  }

  // Check rate limit backoff
  if (fileCache?.backoff && Date.now() < fileCache.backoff.until) {
    debug(`Rate limit backoff active for billing`);
    return fileCache?.billing?.data ?? null;
  }

  // Try to acquire lock
  const locked = acquireLock();
  if (!locked) {
    debug("Lock held by another process, using stale billing cache");
    return fileCache?.billing?.data ?? null;
  }

  try {
    const provider = await getCurrentProvider();
    if (!provider) {
      debug("Could not detect a provider for billing info");
      return null;
    }

    if (provider.fetchBilling) {
      const billing = await provider.fetchBilling();
      if (billing) {
        cachedBilling = billing;
        billingCacheTimestamp = Date.now();
        const updated = clearBackoff(fileCache);
        updated.billing = { ts: Date.now(), data: billing };
        writeFileCache(updated);
        debug(`Refreshed billing cache from ${provider.name} provider`);
        return billing;
      }
    }

    debug(`Provider ${provider.name} does not support billing data`);
    return null;
  } catch (error) {
    if (error instanceof RateLimitError) {
      recordBackoff(fileCache, error.retryAfterMs);
    } else {
      debug("Error fetching billing:", error);
    }
    return fileCache?.billing?.data ?? null;
  } finally {
    releaseLock();
  }
}

export function clearBillingCache(): void {
  cachedBilling = null;
  billingCacheTimestamp = 0;
}

// Re-export provider functions for convenience
export { getCurrentProvider, clearProviderCache } from "../providers/index.js";
