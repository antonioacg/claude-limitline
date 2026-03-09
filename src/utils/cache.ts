/**
 * File-based caching infrastructure for cross-process rate limit protection
 *
 * - Per-provider cache: ~/.cache/claude-limitline/{provider}-cache.json
 * - Lockfile: ~/.cache/claude-limitline/{provider}-cache.lock
 * - Configurable exponential backoff on 429 responses
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { UsageResponse, BillingInfo } from "../providers/types.js";
import { debug } from "./logger.js";

// ==================== Config ====================

let backoffBaseSec = 60;
let backoffMaxSec = 300;

/** Apply budget config for backoff timing. Call once after config loads. */
export function initCacheConfig(config: { backoffBase?: number; backoffMax?: number }): void {
  if (config.backoffBase != null) backoffBaseSec = config.backoffBase;
  if (config.backoffMax != null) backoffMaxSec = config.backoffMax;
}

// ==================== File-based cache ====================

export const CACHE_DIR = path.join(os.homedir(), ".cache", "claude-limitline");
const LOCK_STALE_MS = 30_000;

export interface FileCacheEntry<T> {
  ts: number;
  data: T;
}

export interface FileCache {
  usage?: FileCacheEntry<UsageResponse>;
  billing?: FileCacheEntry<BillingInfo>;
  backoff?: { until: number; consecutive: number };
}

export function cacheFile(provider: string): string {
  return path.join(CACHE_DIR, `${provider.toLowerCase()}-cache.json`);
}

function lockFile(provider: string): string {
  return path.join(CACHE_DIR, `${provider.toLowerCase()}-cache.lock`);
}

export function readFileCache(provider: string): FileCache | null {
  try {
    const content = fs.readFileSync(cacheFile(provider), "utf-8");
    return JSON.parse(content) as FileCache;
  } catch {
    return null;
  }
}

export function writeFileCache(provider: string, cache: FileCache): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile(provider), JSON.stringify(cache), "utf-8");
  } catch (error) {
    debug("Failed to write file cache:", error);
  }
}

// ==================== Lockfile ====================

const lockRefCounts = new Map<string, number>();

export function acquireLock(provider: string): boolean {
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

export function releaseLock(provider: string): void {
  const refCount = lockRefCounts.get(provider) ?? 0;
  if (refCount > 1) {
    lockRefCounts.set(provider, refCount - 1);
    return;
  }
  lockRefCounts.delete(provider);
  try { fs.unlinkSync(lockFile(provider)); } catch { /* already cleaned up */ }
}

// ==================== Backoff ====================

export function recordBackoff(provider: string, fileCache: FileCache | null, retryAfterMs?: number): void {
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

export function clearBackoff(fileCache: FileCache | null): FileCache {
  const updated: FileCache = { ...fileCache };
  delete updated.backoff;
  return updated;
}

// ==================== Cleanup ====================

export function clearAllCaches(): void {
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      fs.unlinkSync(path.join(CACHE_DIR, f));
    }
  } catch { /* dir doesn't exist */ }
  lockRefCounts.clear();
}
