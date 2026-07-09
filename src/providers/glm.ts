/**
 * GLM (z.ai) provider implementation
 * Fetches coding-plan usage limits from the z.ai monitor API.
 *
 * The quota endpoint accepts the same API key Claude Code uses
 * (ANTHROPIC_AUTH_TOKEN) as a Bearer token — no JWT or org/project headers,
 * so no expiry or extra config.
 *
 * Endpoint: GET https://api.z.ai/api/monitor/usage/quota/limit
 *
 * Response shape (abbreviated):
 *   { code: 200, data: { limits: [
 *       { type: "TOKENS_LIMIT", unit: 3, percentage, nextResetTime }, // ~5h block
 *       { type: "TOKENS_LIMIT", unit: 6, percentage, nextResetTime }, // ~7d weekly
 *       { type: "TIME_LIMIT",   unit: 5, percentage, nextResetTime }, // monthly tool quota
 *     ], level: "pro" } }
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type Provider, type UsageResponse, type BillingInfo, RateLimitError } from "./types.js";
import { debug } from "../utils/logger.js";
import { CACHE_DIR } from "../utils/cache.js";

interface GlmLimit {
  type: string;            // "TOKENS_LIMIT" | "TIME_LIMIT"
  unit: number;            // 3 = ~5h block, 6 = ~7d weekly, 5 = monthly tool quota
  number: number;
  percentage: number;
  nextResetTime: number;   // epoch ms
}

interface GlmQuotaResponse {
  code: number;
  msg?: string;
  data?: {
    limits?: GlmLimit[];
    level?: string;
  };
  success?: boolean;
}

const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const BALANCE_URL = "https://api.z.ai/api/platform-charge-zai/business/accountBalance";
const SUBSCRIPTION_URL = "https://api.z.ai/api/biz/subscription/list";

interface GlmBalanceResponse {
  code: number;
  msg?: string;
  data?: {
    accountList?: Array<{ balance: number; frozenBalance: number; type: number }>;
    totalBalance?: number;
  };
  success?: boolean;
}

interface GlmSubscriptionResponse {
  code: number;
  msg?: string;
  data?: Array<{
    customerId?: string;
    productName?: string;
    status?: string;
    inCurrentPeriod?: boolean;
    nextRenewTime?: string;
    actualPrice?: number;
  }>;
  success?: boolean;
}

const CUSTOMER_ID_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — account id is stable

// customerId is stable per API key, so cache it under a short hash of the key
// (never the key itself): avoids re-fetching subscription/list each billing
// cycle and keeps caches separate across accounts/keys.
function customerIdCacheFile(token: string): string {
  const hash = crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
  return path.join(CACHE_DIR, `glm-customer-id-${hash}.json`);
}

function readCachedCustomerId(token: string): string | null {
  try {
    const entry = JSON.parse(fs.readFileSync(customerIdCacheFile(token), "utf-8")) as { customerId?: string; ts?: number };
    if (entry.customerId && entry.ts && Date.now() - entry.ts < CUSTOMER_ID_TTL_MS) {
      return entry.customerId;
    }
  } catch { /* not cached or corrupt */ }
  return null;
}

function writeCachedCustomerId(token: string, customerId: string): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(customerIdCacheFile(token), JSON.stringify({ customerId, ts: Date.now() }));
  } catch (error) {
    debug("Failed to cache GLM customerId:", error);
  }
}

export class GlmProvider implements Provider {
  readonly name = "GLM";
  readonly supportsUsage = true;

  async getToken(): Promise<string | null> {
    // Same key Claude Code uses to talk to api.z.ai/api/anthropic.
    const token = process.env.ANTHROPIC_AUTH_TOKEN;
    if (token) {
      debug("Found GLM token in ANTHROPIC_AUTH_TOKEN");
      return token;
    }
    return null;
  }

  async fetchUsage(): Promise<UsageResponse | null> {
    const token = await this.getToken();
    if (!token) {
      debug("No GLM token available");
      return null;
    }

    let response: Response;
    try {
      response = await fetch(QUOTA_URL, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
      });
    } catch (error) {
      debug("Failed to reach GLM quota API:", error);
      return null;
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const retryMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
      throw new RateLimitError(retryMs);
    }

    if (!response.ok) {
      debug(`GLM quota API returned status ${response.status}: ${response.statusText}`);
      return null;
    }

    const data = (await response.json()) as GlmQuotaResponse;
    if (data.code !== 200 || !data.data?.limits) {
      debug("GLM quota API returned unexpected payload:", JSON.stringify(data));
      return null;
    }

    // Only TOKENS_LIMIT windows are model usage; TIME_LIMIT is a monthly tool
    // quota (search / web-reader / zread) — skip it. Sort by reset time so the
    // soonest-resetting window maps to "short" (~5h) and the next to "weekly"
    // (~7d), matching the legacy field names oauth.ts expects.
    const tokenLimits = data.data.limits
      .filter(l => l.type === "TOKENS_LIMIT")
      .sort((a, b) => a.nextResetTime - b.nextResetTime);

    const toWindow = (name: string, l: GlmLimit) => ({
      name,
      percentUsed: l.percentage,
      resetAt: new Date(l.nextResetTime),
      isOverLimit: l.percentage >= 100,
    });

    const windows: UsageResponse["windows"] = [];
    if (tokenLimits[0]) windows.push(toWindow("short", tokenLimits[0]));
    if (tokenLimits[1]) windows.push(toWindow("weekly", tokenLimits[1]));

    if (windows.length === 0) {
      debug("GLM quota response had no TOKENS_LIMIT windows");
      return null;
    }

    debug(`GLM usage: ${windows.map(w => `${w.name}=${w.percentUsed}%`).join(", ")}`);
    return { windows, raw: data };
  }

  // GLM carries a prepaid wallet (counts down), not a monthly spend. Surface
  // the remaining balance the way Moonshot does. The wallet endpoint demands a
  // customerId in the body — it isn't derivable from the API key, so fetch it
  // from the subscription endpoint.
  async fetchBilling(): Promise<BillingInfo | null> {
    const token = await this.getToken();
    if (!token) {
      debug("No GLM token available for billing");
      return null;
    }

    const customerId = await this.getCustomerId(token);
    if (!customerId) {
      debug("Could not resolve GLM customerId for billing");
      return null;
    }

    let response: Response;
    try {
      response = await fetch(BALANCE_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json;charset=UTF-8",
          accept: "application/json",
        },
        body: JSON.stringify({ customerId }),
      });
    } catch (error) {
      debug("Failed to reach GLM balance API:", error);
      return null;
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      throw new RateLimitError(retryAfter ? Number(retryAfter) * 1000 : undefined);
    }

    if (!response.ok) {
      debug(`GLM balance API returned status ${response.status}: ${response.statusText}`);
      return null;
    }

    const data = (await response.json()) as GlmBalanceResponse;
    if (data.code !== 200 || !data.data) {
      debug("GLM balance API returned unexpected payload:", JSON.stringify(data));
      return null;
    }

    // totalBalance is in whole currency units (USD on z.ai); convert to cents
    // for the BillingInfo model.
    const cents = Math.round((data.data.totalBalance ?? 0) * 100);
    debug(`GLM balance: $${(cents / 100).toFixed(2)}`);
    return {
      spentAmount: null,
      spentCurrency: "USD",
      isRealtime: true,
      availableBalance: cents,
    };
  }

  /** Resolve the account customerId (cached; falls back to the subscription endpoint). */
  private async getCustomerId(token: string): Promise<string | null> {
    const cached = readCachedCustomerId(token);
    if (cached) {
      debug("Using cached GLM customerId");
      return cached;
    }

    try {
      const response = await fetch(SUBSCRIPTION_URL, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        throw new RateLimitError(retryAfter ? Number(retryAfter) * 1000 : undefined);
      }
      if (!response.ok) {
        debug(`GLM subscription API returned status ${response.status}: ${response.statusText}`);
        return null;
      }
      const data = (await response.json()) as GlmSubscriptionResponse;
      if (data.code !== 200 || !Array.isArray(data.data)) return null;
      const sub = data.data.find(s => s.status === "VALID" && s.inCurrentPeriod) ?? data.data[0];
      const customerId = sub?.customerId ?? null;
      if (customerId) writeCachedCustomerId(token, customerId);
      return customerId;
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      debug("Failed to fetch GLM subscription for customerId:", error);
      return null;
    }
  }
}
