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

export interface BlockSegmentConfig extends SegmentConfig {
  showTimeRemaining?: boolean;
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
}

export interface DisplayConfig {
  style?: "powerline" | "minimal" | "capsule";
  useNerdFonts?: boolean;
  compactMode?: "auto" | "always" | "never";  // Auto-compact when terminal is narrow
  compactWidth?: number;  // Terminal width threshold for compact mode (default 80)
}

export type SegmentName = "directory" | "git" | "model" | "block" | "weekly" | "context" | "billing";

export interface BillingSegmentConfig extends SimpleSegmentConfig {
  // Billing only shows spent amount from OAuth usage API
  // Balance and auto-reload are not available without browser session cookie
  spendingWarning?: number;   // Amount in minor units (cents) to show warning color
  spendingCritical?: number;  // Amount in minor units (cents) to show critical color
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
  segmentOrder?: SegmentName[];     // Custom order for segments
  showTrend?: boolean;              // Show ↑↓ trend arrows for usage
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
    showDirtyIndicator: true,
  },
  model: {
    enabled: true,
  },
  block: {
    enabled: true,
    displayStyle: "text",
    barWidth: 10,
    showTimeRemaining: true,
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
  segmentOrder: ["directory", "git", "model", "block", "weekly"],
  showTrend: true,
};
