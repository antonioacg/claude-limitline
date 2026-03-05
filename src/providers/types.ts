/**
 * Provider abstraction for multi-API support
 * Allows claude-limitline to work with different AI providers (Anthropic, Moonshot, etc.)
 */

/**
 * A usage window represents a rate limit time window
 * (e.g., 5-hour window, 7-day window)
 */
export interface UsageWindow {
  /** Window identifier - e.g., "short", "daily", "weekly", "weekly-opus", "weekly-sonnet" */
  name: string;
  /** Percentage of limit used (0-100+) */
  percentUsed: number;
  /** When this window resets */
  resetAt: Date;
  /** Whether usage exceeds the limit */
  isOverLimit: boolean;
}

/**
 * Generic usage response from any provider
 */
export interface UsageResponse {
  /** Array of usage windows */
  windows: UsageWindow[];
  /** Raw provider response for extensions */
  raw?: unknown;
}

/**
 * Billing information
 */
export interface BillingInfo {
  /** Amount spent (whole currency units for Anthropic, cents for Moonshot) */
  spentAmount: number | null;
  /** Currency code, e.g., "USD" */
  spentCurrency: string | null;
  /** Whether this is real-time data */
  isRealtime: boolean;
  /** Monthly spending limit (whole currency units) — null if no limit */
  monthlyLimit?: number | null;
  /** Spending utilization percentage (0-100) — null if no limit */
  utilization?: number | null;
  /** Available balance in minor units (cents) - for providers like Moonshot */
  availableBalance?: number | null;
  /** Cash balance in minor units (cents) - for providers like Moonshot */
  cashBalance?: number | null;
  /** Voucher/promotional balance in minor units (cents) */
  voucherBalance?: number | null;
}

/**
 * Trend direction for usage tracking
 */
export type TrendDirection = "up" | "down" | "same" | null;

/**
 * Trend information for all windows
 */
export interface TrendInfo {
  /** Find trend by window name */
  getTrend(windowName: string): TrendDirection;
}

/**
 * Provider interface - implemented by each API provider
 */
export interface Provider {
  /** Provider name for display */
  readonly name: string;

  /** Whether this provider supports usage limits (rate limits) */
  readonly supportsUsage: boolean;

  /**
   * Get the API token for this provider
   * Returns null if no token is available
   */
  getToken(): Promise<string | null>;

  /**
   * Fetch usage data from the provider
   * Returns null if usage data is not available
   */
  fetchUsage(): Promise<UsageResponse | null>;

  /**
   * Fetch billing information (optional)
   * Returns null if billing data is not available
   */
  fetchBilling?(): Promise<BillingInfo | null>;
}

/**
 * Thrown when a provider API returns 429 (rate limited).
 * Consumers should implement backoff based on retryAfterMs.
 */
export class RateLimitError extends Error {
  constructor(public retryAfterMs?: number) {
    super("Rate limited");
    this.name = "RateLimitError";
  }
}

/**
 * Provider configuration options
 */
export interface ProviderConfig {
  /** Explicit provider type - if not set, auto-detection is used */
  type?: "anthropic" | "moonshot" | "auto";
  /** Custom API base URL */
  apiUrl?: string;
  /** Custom token (overrides auto-detection) */
  token?: string;
}
