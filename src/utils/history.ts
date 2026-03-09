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

/**
 * Get a downsampled sparkline for a given time range.
 * Divides the range into `width` time buckets and averages samples per bucket.
 */
function getDownsampledSparkline(
  samples: UsageSample[],
  extractor: (s: UsageSample) => number | null,
  width: number,
  rangeMinutes: number,
): string {
  const now = Date.now();
  const rangeMs = rangeMinutes * 60 * 1000;
  const startTime = now - rangeMs;
  const bucketMs = rangeMs / width;

  const buckets: number[][] = Array.from({ length: width }, () => []);

  for (const sample of samples) {
    if (sample.timestamp < startTime) continue;
    const value = extractor(sample);
    if (value === null) continue;
    const bucketIdx = Math.min(
      Math.floor((sample.timestamp - startTime) / bucketMs),
      width - 1,
    );
    buckets[bucketIdx].push(value);
  }

  // Average each bucket; skip rendering if no data at all
  const averaged: (number | null)[] = buckets.map(
    b => b.length > 0 ? b.reduce((a, v) => a + v, 0) / b.length : null,
  );

  if (averaged.every(v => v === null)) return "";

  return averaged
    .map(value => {
      if (value === null) return SPARKLINE_CHARS[0]; // empty bucket = lowest bar
      const clamped = Math.max(0, Math.min(100, value));
      const index = Math.floor((clamped / 100) * 7);
      return SPARKLINE_CHARS[index];
    })
    .join("");
}

export function getBlockSparkline(width: number, rangeMinutes?: number): string {
  const history = loadHistory();
  if (rangeMinutes != null) {
    return getDownsampledSparkline(history.samples, s => s.blockPercent, width, rangeMinutes);
  }
  const blockSamples = history.samples.map(s => s.blockPercent);
  return getSparkline(blockSamples, width);
}

export function getWeeklySparkline(width: number): string {
  const history = loadHistory();
  const weeklySamples = history.samples.map(s => s.weeklyPercent);
  return getSparkline(weeklySamples, width);
}
