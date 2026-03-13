import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { debug } from "./logger.js";

export interface UsageSample {
  timestamp: number;  // Unix ms
  blockPercent: number | null;
  weeklyPercent: number | null;
}

export interface HistoryData {
  samples: UsageSample[];
  lastResetAtMs?: number | null;
}

const SPARKLINE_CHARS = "▁▂▃▄▅▆▇█";
let maxHistoryAgeMs = 24 * 60 * 60 * 1000; // 24 hours default

/** Set the max history retention. Call once after config loads. */
export function initHistory(config: { sparklineRange?: number }): void {
  if (config.sparklineRange != null) {
    // Keep at least 2x the range so we always have enough data
    maxHistoryAgeMs = Math.max(config.sparklineRange * 60 * 1000 * 2, 60 * 60 * 1000);
  }
}
const HISTORY_FILE = "limitline-history.json";

function getHistoryPath(): string {
  return path.join(os.homedir(), ".claude", HISTORY_FILE);
}

export function loadHistory(): HistoryData {
  const historyPath = getHistoryPath();
  try {
    if (fs.existsSync(historyPath)) {
      const content = fs.readFileSync(historyPath, "utf-8");
      const data = JSON.parse(content) as HistoryData;
      return data;
    }
  } catch (error) {
    debug("Failed to load history:", error);
  }
  return { samples: [] };
}

export function saveHistory(data: HistoryData): void {
  const historyPath = getHistoryPath();
  try {
    const dir = path.dirname(historyPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(historyPath, JSON.stringify(data, null, 2));
  } catch (error) {
    debug("Failed to save history:", error);
  }
}

export function pruneOldSamples(data: HistoryData): HistoryData {
  const cutoff = Date.now() - maxHistoryAgeMs;
  return {
    samples: data.samples.filter(s => s.timestamp > cutoff),
  };
}

export function addSample(
  blockPercent: number | null,
  weeklyPercent: number | null
): void {
  const history = loadHistory();
  history.samples.push({
    timestamp: Date.now(),
    blockPercent,
    weeklyPercent,
  });
  const pruned = pruneOldSamples(history);
  saveHistory(pruned);
}

export function getSparkline(
  samples: (number | null)[],
  width: number
): string {
  const validSamples = samples.filter((s): s is number => s !== null);
  if (validSamples.length === 0) return "";

  const recentSamples = validSamples.slice(-width);
  return recentSamples
    .map(value => {
      const clamped = Math.max(0, Math.min(100, value));
      const index = Math.floor((clamped / 100) * 7);
      return SPARKLINE_CHARS[index];
    })
    .join("");
}

const BLOCK_DURATION_MS = 5 * 60 * 60 * 1000; // 5h billing block

/**
 * Build bucket boundaries aligned to a grid anchored at `resetAtMs`,
 * with a forced break at the previous block boundary (`resetAtMs - 5h`).
 * Returns `width` intervals as [start, end) pairs, rightmost = newest.
 */
function buildAlignedBuckets(
  width: number,
  rangeMinutes: number,
  resetAtMs: number | null,
): Array<{ start: number; end: number }> {
  const now = Date.now();
  const bucketMs = (rangeMinutes / width) * 60 * 1000;

  // Fallback: no resetAt → uniform buckets (old behavior)
  if (resetAtMs == null) {
    const rangeMs = rangeMinutes * 60 * 1000;
    const startTime = now - rangeMs;
    return Array.from({ length: width }, (_, i) => ({
      start: startTime + i * bucketMs,
      end: startTime + (i + 1) * bucketMs,
    }));
  }

  // Build grid boundaries anchored to resetAt, plus the block boundary
  const blockBoundary = resetAtMs - BLOCK_DURATION_MS;

  // Find gridNow: latest grid point ≤ now
  // Grid points: resetAt + k * bucketMs for integer k
  const k = Math.floor((now - resetAtMs) / bucketMs);
  const gridNow = resetAtMs + k * bucketMs;

  // Collect grid boundaries going left from gridNow, well past our range
  const boundaries: number[] = [];
  for (let i = -(width + 2); i <= 0; i++) {
    boundaries.push(gridNow + i * bucketMs);
  }
  // Add now and the block boundary
  boundaries.push(now);
  boundaries.push(blockBoundary);

  // Deduplicate, sort ascending
  const unique = [...new Set(boundaries)].sort((a, b) => a - b);

  // Build intervals between consecutive boundaries
  const intervals: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < unique.length - 1; i++) {
    if (unique[i + 1] <= unique[i]) continue;
    // Only keep intervals that overlap with [something, now]
    if (unique[i + 1] <= unique[0] || unique[i] >= now) continue;
    intervals.push({ start: unique[i], end: unique[i + 1] });
  }

  // Take the rightmost `width` intervals (newest on the right)
  return intervals.slice(-width);
}

/**
 * Get a downsampled sparkline for a given time range.
 * Buckets are aligned to resetAt grid with a forced break at block boundaries.
 */
function getDownsampledSparkline(
  samples: UsageSample[],
  extractor: (s: UsageSample) => number | null,
  width: number,
  rangeMinutes: number,
  resetAtMs?: number | null,
): string {
  const bucketRanges = buildAlignedBuckets(width, rangeMinutes, resetAtMs ?? null);
  const buckets: number[][] = Array.from({ length: bucketRanges.length }, () => []);

  for (const sample of samples) {
    const value = extractor(sample);
    if (value === null) continue;
    // Find which bucket this sample belongs to
    for (let i = 0; i < bucketRanges.length; i++) {
      if (sample.timestamp >= bucketRanges[i].start && sample.timestamp < bucketRanges[i].end) {
        buckets[i].push(value);
        break;
      }
    }
  }

  // Average per bucket; skip rendering if no data at all
  const aggregated: (number | null)[] = buckets.map(
    b => b.length > 0 ? b.reduce((a, v) => a + v, 0) / b.length : null,
  );

  if (aggregated.every(v => v === null)) return "";

  return aggregated
    .map(value => {
      if (value === null) return SPARKLINE_CHARS[0]; // empty bucket = lowest bar
      const clamped = Math.max(0, Math.min(100, value));
      const index = Math.floor((clamped / 100) * 7);
      return SPARKLINE_CHARS[index];
    })
    .join("");
}

export function getBlockSparkline(width: number, rangeMinutes?: number, resetAtMs?: number | null): string {
  const history = loadHistory();

  // Persist resetAt so the grid stays stable even when blockInfo is temporarily null
  if (resetAtMs != null) {
    if (history.lastResetAtMs !== resetAtMs) {
      history.lastResetAtMs = resetAtMs;
      saveHistory(history);
    }
  }
  const effectiveResetAt = resetAtMs ?? history.lastResetAtMs ?? null;

  if (rangeMinutes != null) {
    return getDownsampledSparkline(history.samples, s => s.blockPercent, width, rangeMinutes, effectiveResetAt);
  }
  const blockSamples = history.samples.map(s => s.blockPercent);
  return getSparkline(blockSamples, width);
}

export function getWeeklySparkline(width: number): string {
  const history = loadHistory();
  const weeklySamples = history.samples.map(s => s.weeklyPercent);
  return getSparkline(weeklySamples, width);
}
