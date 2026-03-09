export interface SegmentConfig {
  enabled: boolean;
  displayStyle?: "text" | "bar";
  barWidth?: number;
}

export interface SimpleSegmentConfig {
  enabled: boolean;
}

export interface GitSegmentConfig extends SimpleSegmentConfig {
  showDirtyIndicator?: boolean;  // Show ● when there are uncommitted changes
}

export type TimeDisplay = "remaining" | "absolute";
export type TimeFormat = "12h" | "24h";

export interface BlockSegmentConfig extends SegmentConfig {
  showTimeRemaining?: boolean;
  timeDisplay?: TimeDisplay;    // "remaining" (3h20m) or "absolute" (2:30pm), default "remaining"
  timeFormat?: TimeFormat;      // "12h" or "24h" for absolute time, default "12h"
  showSparkline?: boolean;      // Show usage history sparkline, default false
  sparklineWidth?: number;      // Number of sparkline characters, default 8
  sparklineRange?: number;      // Time range in minutes to display, default 360 (6h)
}

export type WeeklyViewMode = "simple" | "smart";

export interface WeeklySegmentConfig extends SegmentConfig {
  showWeekProgress?: boolean;
  viewMode?: WeeklyViewMode;  // default "simple"
}

export interface BudgetConfig {
  pollInterval?: number; // minutes between API calls (default 15)
  resetDay?: number;     // 0=Sunday, 1=Monday, ..., 6=Saturday
  resetHour?: number;    // 0-23
  resetMinute?: number;  // 0-59
  warningThreshold?: number; // percentage to show warning color (default 70)
  criticalThreshold?: number; // percentage to show critical color (default 90)
  backoffBase?: number;  // initial backoff in seconds on 429 (default 60)
  backoffMax?: number;   // maximum backoff in seconds on 429 (default 300)
}

export interface DisplayConfig {
  style?: "powerline" | "minimal" | "capsule";
  useNerdFonts?: boolean;
  compactMode?: "auto" | "always" | "never";  // Auto-compact when terminal is narrow
  compactWidth?: number;  // Terminal width threshold for compact mode (default 80)
}

export type SegmentName = "directory" | "git" | "model" | "block" | "weekly" | "context" | "billing" | "sessionId" | "sparkline";

export interface BillingSegmentConfig extends SimpleSegmentConfig {
  warningThreshold?: number;   // Utilization % threshold for warning (default 70)
  criticalThreshold?: number;  // Utilization % threshold for critical (default 90)
  currency?: string;           // Override currency code when API doesn't return one (e.g. "BRL")
}

export interface LimitlineConfig {
  display?: DisplayConfig;
  directory?: SimpleSegmentConfig;  // Show repo/directory name
  git?: GitSegmentConfig;           // Show git branch
  model?: SimpleSegmentConfig;      // Show Claude model
  block?: BlockSegmentConfig;
  weekly?: WeeklySegmentConfig;
  context?: SimpleSegmentConfig;    // Show context window usage (right side)
  billing?: BillingSegmentConfig;   // Show billing info (spent, balance, auto-reload)
  budget?: BudgetConfig;
  theme?: string;
  segmentOrder?: SegmentName[] | SegmentName[][];  // Flat = single line, nested = one line per inner array
  showTrend?: boolean;              // Show ↑↓ trend arrows for usage
  debug?: boolean;                  // Enable debug logging (env CLAUDE_LIMITLINE_DEBUG overrides)
  logFile?: string;                 // Log file path (env CLAUDE_LIMITLINE_LOG_FILE overrides)
}

export const DEFAULT_CONFIG: LimitlineConfig = {
  display: {
    style: "powerline",
    useNerdFonts: true,
    compactMode: "auto",
    compactWidth: 80,
  },
  directory: {
    enabled: true,
  },
  git: {
    enabled: true,
    showDirtyIndicator: false,
  },
  model: {
    enabled: true,
  },
  block: {
    enabled: true,
    displayStyle: "text",
    barWidth: 10,
    showTimeRemaining: true,
    timeDisplay: "remaining",
    timeFormat: "12h",
    showSparkline: false,
    sparklineWidth: 8,
    sparklineRange: 360,
  },
  weekly: {
    enabled: true,
    displayStyle: "text",
    barWidth: 10,
    showWeekProgress: true,
    viewMode: "simple",
  },
  context: {
    enabled: true,
  },
  billing: {
    enabled: false,
  },
  budget: {
    pollInterval: 15,
    warningThreshold: 70,
    criticalThreshold: 90,
  },
  theme: "dark",
  segmentOrder: [
    ["directory", "git"],
    ["model", "block", "weekly"],
  ],
  showTrend: true,
};
