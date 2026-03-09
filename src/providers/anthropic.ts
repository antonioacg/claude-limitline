/**
 * Anthropic API provider implementation
 * Handles usage and billing API calls via the OAuth usage endpoint
 *
 * Token retrieval lives in src/utils/token.ts (shared, mirrors upstream oauth.ts)
 */

import { type Provider, type UsageResponse, type BillingInfo, RateLimitError } from "./types.js";
import { getOAuthToken } from "../utils/token.js";
import { debug } from "../utils/logger.js";

interface AnthropicApiUsageBlock {
  resets_at?: string;
  utilization?: number;
}

interface AnthropicApiResponse {
  five_hour?: AnthropicApiUsageBlock;
  seven_day?: AnthropicApiUsageBlock;
  seven_day_opus?: AnthropicApiUsageBlock | null;
  seven_day_sonnet?: AnthropicApiUsageBlock | null;
  extra_usage?: {
    is_enabled: boolean;
    used_credits: number;
    monthly_limit?: number;
    utilization?: number;
    currency?: string;
  };
}

export class AnthropicProvider implements Provider {
  readonly name = "Anthropic";
  readonly supportsUsage = true;

  // Deduplication: fetchUsage() and fetchBilling() hit the same endpoint,
  // so we share a single in-flight request + short TTL cache to avoid
  // concurrent duplicate HTTP calls that trigger rate limiting.
  private inflightRequest: Promise<AnthropicApiResponse | null> | null = null;
  private responseCache: AnthropicApiResponse | null = null;
  private responseCacheTime = 0;
  private static readonly DEDUP_TTL_MS = 5000;

  async getToken(): Promise<string | null> {
    return getOAuthToken();
  }

  /**
   * Shared API call with in-flight deduplication.
   * Multiple concurrent callers get the same promise instead of separate HTTP requests.
   */
  private async fetchApiResponse(): Promise<AnthropicApiResponse | null> {
    const now = Date.now();
    if (this.responseCache && (now - this.responseCacheTime) < AnthropicProvider.DEDUP_TTL_MS) {
      debug("Using dedup cache for Anthropic API response");
      return this.responseCache;
    }

    if (this.inflightRequest) {
      debug("Joining in-flight Anthropic API request");
      return this.inflightRequest;
    }

    this.inflightRequest = this.doFetchApi();
    try {
      const result = await this.inflightRequest;
      if (result) {
        this.responseCache = result;
        this.responseCacheTime = Date.now();
      }
      return result;
    } finally {
      this.inflightRequest = null;
    }
  }

  private async doFetchApi(): Promise<AnthropicApiResponse | null> {
    const token = await this.getToken();
    if (!token) {
      debug("No Anthropic OAuth token available");
      return null;
    }

    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "claude-limitline/1.0.0",
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const retryMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined;
      throw new RateLimitError(retryMs);
    }

    if (!response.ok) {
      debug(`Anthropic usage API returned status ${response.status}: ${response.statusText}`);
      return null;
    }

    const data = (await response.json()) as AnthropicApiResponse;
    debug("Anthropic usage API response:", JSON.stringify(data));
    return data;
  }

  async fetchUsage(): Promise<UsageResponse | null> {
    try {
      const data = await this.fetchApiResponse();
      if (!data) return null;

      const windows: UsageResponse["windows"] = [];

      if (data.five_hour) {
        windows.push({
          name: "short",
          percentUsed: data.five_hour.utilization ?? 0,
          resetAt: data.five_hour.resets_at ? new Date(data.five_hour.resets_at) : new Date(),
          isOverLimit: (data.five_hour.utilization ?? 0) >= 100,
        });
      }

      if (data.seven_day) {
        windows.push({
          name: "weekly",
          percentUsed: data.seven_day.utilization ?? 0,
          resetAt: data.seven_day.resets_at ? new Date(data.seven_day.resets_at) : new Date(),
          isOverLimit: (data.seven_day.utilization ?? 0) >= 100,
        });
      }

      if (data.seven_day_opus) {
        windows.push({
          name: "weekly-opus",
          percentUsed: data.seven_day_opus.utilization ?? 0,
          resetAt: data.seven_day_opus.resets_at ? new Date(data.seven_day_opus.resets_at) : new Date(),
          isOverLimit: (data.seven_day_opus.utilization ?? 0) >= 100,
        });
      }

      if (data.seven_day_sonnet) {
        windows.push({
          name: "weekly-sonnet",
          percentUsed: data.seven_day_sonnet.utilization ?? 0,
          resetAt: data.seven_day_sonnet.resets_at ? new Date(data.seven_day_sonnet.resets_at) : new Date(),
          isOverLimit: (data.seven_day_sonnet.utilization ?? 0) >= 100,
        });
      }

      return { windows, raw: data };
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      debug("Failed to fetch usage from Anthropic API:", error);
      return null;
    }
  }

  async fetchBilling(): Promise<BillingInfo | null> {
    try {
      const data = await this.fetchApiResponse();
      if (!data) return null;

      if (data.extra_usage) {
        // API returns amounts in minor units (cents); convert to whole currency units
        const spentAmount = data.extra_usage.used_credits / 100;
        const monthlyLimit = data.extra_usage.monthly_limit != null
          ? data.extra_usage.monthly_limit / 100
          : null;
        return {
          spentAmount,
          spentCurrency: data.extra_usage.currency ?? null,
          monthlyLimit,
          utilization: data.extra_usage.utilization ?? null,
          isRealtime: true,
        };
      }

      return null;
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      debug("Failed to fetch billing from Anthropic API:", error);
      return null;
    }
  }
}
