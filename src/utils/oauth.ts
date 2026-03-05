/**
 * OAuth and usage data utilities
 * Uses provider abstraction to support multiple API providers (Anthropic, Moonshot, etc.)
 *
 * Rate limit protection (cross-process, per-provider):
 * - File-based cache: ~/.cache/claude-limitline/{provider}-cache.json
 * - Lockfile: ~/.cache/claude-limitline/{provider}-cache.lock
 * - Configurable exponential backoff on 429 responses
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { UsageResponse, BillingInfo, TrendDirection } from "../providers/types.js";
import { RateLimitError } from "../providers/types.js";
import { getCurrentProvider, clearProviderCache } from "../providers/index.js";
import { debug } from "./logger.js";

// ==================== Config ====================

let backoffBaseSec = 60;
let backoffMaxSec = 300;

/** Apply budget config for backoff timing. Call once after config loads. */
export function initOAuth(config: { backoffBase?: number; backoffMax?: number }): void {
  if (config.backoffBase != null) backoffBaseSec = config.backoffBase;
  if (config.backoffMax != null) backoffMaxSec = config.backoffMax;
}

// ==================== File-based cache (cross-process, per-provider) ====================

const CACHE_DIR = path.join(os.homedir(), ".cache", "claude-limitline");
const LOCK_STALE_MS = 30_000;

function cacheFile(provider: string): string {
  return path.join(CACHE_DIR, `${provider.toLowerCase()}-cache.json`);
}

function lockFile(provider: string): string {
  return path.join(CACHE_DIR, `${provider.toLowerCase()}-cache.lock`);
}

interface FileCacheEntry<T> {
  ts: number;
  data: T;
}

interface FileCache {
  usage?: FileCacheEntry<UsageResponse>;
  billing?: FileCacheEntry<BillingInfo>;
  backoff?: { until: number; consecutive: number };
}

function readFileCache(provider: string): FileCache | null {
  try {
    const content = fs.readFileSync(cacheFile(provider), "utf-8");
    return JSON.parse(content) as FileCache;
  } catch {
    return null;
  }
}

function writeFileCache(provider: string, cache: FileCache): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile(provider), JSON.stringify(cache), "utf-8");
  } catch (error) {
    debug("Failed to write file cache:", error);
  }
}

const lockRefCounts = new Map<string, number>();

function acquireLock(provider: string): boolean {
  const file = lockFile(provider);
  const refCount = lockRefCounts.get(provider) ?? 0;

  // Re-entrant: same process already holds this provider's lock
  if (refCount > 0) {
    lockRefCounts.set(provider, refCount + 1);
    return true;
  }

  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, String(process.pid), { flag: "wx" });
    lockRefCounts.set(provider, 1);
    return true;
  } catch {
    try {
      const content = fs.readFileSync(file, "utf-8").trim();
      if (content === String(process.pid)) {
        lockRefCounts.set(provider, 1);
        return true;
      }
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        fs.unlinkSync(file);
        fs.writeFileSync(file, String(process.pid), { flag: "wx" });
        lockRefCounts.set(provider, 1);
        return true;
      }
    } catch { /* lost race or can't stat — another process is active */ }
    return false;
  }
}

function releaseLock(provider: string): void {
  const refCount = lockRefCounts.get(provider) ?? 0;
  if (refCount > 1) {
    lockRefCounts.set(provider, refCount - 1);
    return;
  }
  lockRefCounts.delete(provider);
  try { fs.unlinkSync(lockFile(provider)); } catch { /* already cleaned up */ }
}

/** Reconstruct Date objects from JSON-serialized UsageResponse */
function hydrateUsageResponse(raw: UsageResponse): UsageResponse {
  return {
    windows: raw.windows.map(w => ({ ...w, resetAt: new Date(w.resetAt) })),
    raw: raw.raw,
  };
}

function recordBackoff(provider: string, fileCache: FileCache | null, retryAfterMs?: number): void {
  const prev = fileCache?.backoff;
  const consecutive = (prev?.consecutive ?? 0) + 1;
  const baseMs = backoffBaseSec * 1000;
  const maxMs = backoffMaxSec * 1000;
  const exponentialMs = Math.min(baseMs * Math.pow(2, consecutive - 1), maxMs);
  const backoffMs = Math.max(retryAfterMs ?? 0, exponentialMs);
  const updated: FileCache = {
    ...fileCache,
    backoff: { until: Date.now() + backoffMs, consecutive },
  };
  writeFileCache(provider, updated);
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

export function clearFileCache(): void {
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      fs.unlinkSync(path.join(CACHE_DIR, f));
    }
  } catch { /* dir doesn't exist */ }
  lockRefCounts.clear();
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
  const provider = await getCurrentProvider();
  if (!provider) {
    debug("Could not detect a provider for billing info");
    return null;
  }

  const name = provider.name;
  const pollIntervalMs = pollIntervalMinutes * 60 * 1000;
  const fileCache = readFileCache(name);

  // L2: File cache
  if (fileCache?.billing && (Date.now() - fileCache.billing.ts) < pollIntervalMs) {
    cachedBilling = fileCache.billing.data;
    billingCacheTimestamp = fileCache.billing.ts;
    debug(`Using ${name} file cache for billing (age: ${Math.round((Date.now() - fileCache.billing.ts) / 1000)}s)`);
    return cachedBilling;
  }

  // Check rate limit backoff
  if (fileCache?.backoff && Date.now() < fileCache.backoff.until) {
    debug(`${name} rate limit backoff active for billing`);
    return fileCache?.billing?.data ?? null;
  }

  // Try to acquire lock
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

// Re-export provider functions for convenience
export { getCurrentProvider, clearProviderCache } from "../providers/index.js";
