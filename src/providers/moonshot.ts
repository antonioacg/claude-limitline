/**
 * Moonshot API provider implementation
 * Handles API token retrieval and billing API calls for Moonshot
 *
 * API Base URL: https://api.moonshot.ai/v1/
 *
 * Working endpoints:
 * - GET /v1/users/me/balance (returns account balance in USD)
 * - GET /v1/models (returns available models)
 * - POST /v1/chat/completions (returns usage in response)
 *
 * Non-existent endpoints:
 * - /v1/usage, /v1/statistics, /v1/billing (all return 404)
 */

import type { Provider, UsageResponse, BillingInfo } from "./types.js";
import { debug } from "../utils/logger.js";

interface MoonshotBalanceResponse {
  code: number;
  data: {
    available_balance: number;  // USD
    voucher_balance: number;
    cash_balance: number;
  };
  scode: string;
  status: boolean;
}

export class MoonshotProvider implements Provider {
  readonly name = "Moonshot";
  readonly supportsUsage = false; // Moonshot has no usage limits
  private readonly apiBaseUrl = "https://api.moonshot.ai/v1";

  async getToken(): Promise<string | null> {
    // Moonshot tokens are passed via environment variables
    // Check ANTHROPIC_AUTH_TOKEN first (when using Claude Code with Moonshot)
    const token = process.env.ANTHROPIC_AUTH_TOKEN || process.env.MOONSHOT_API_KEY;
    if (token) {
      debug("Found Moonshot API token in environment");
      return token;
    }
    return null;
  }

  async fetchUsage(): Promise<UsageResponse | null> {
    // Moonshot does NOT have a usage API endpoint.
    // Only balance is available via /v1/users/me/balance
    debug("Moonshot does not provide a usage API");
    return null;
  }

  async fetchBilling(): Promise<BillingInfo | null> {
    const token = await this.getToken();
    if (!token) {
      debug("No Moonshot API token available");
      return null;
    }

    try {
      // Moonshot balance endpoint: GET /v1/users/me/balance
      // Returns balance in USD (e.g., 20.16511)
      const response = await fetch(`${this.apiBaseUrl}/users/me/balance`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json",
        },
      });

      if (!response.ok) {
        debug(`Moonshot balance API returned status ${response.status}`);
        return null;
      }

      const data = (await response.json()) as MoonshotBalanceResponse;

      if (data.code !== 0 || !data.status) {
        debug("Moonshot balance API returned error:", data);
        return null;
      }

      // Convert USD to cents for consistent format
      // available_balance is in USD (e.g., 20.16511)
      const availableCents = Math.round(data.data.available_balance * 100);
      const cashCents = Math.round(data.data.cash_balance * 100);
      const voucherCents = Math.round(data.data.voucher_balance * 100);

      debug(`Moonshot balance: available=$${data.data.available_balance}, cash=$${data.data.cash_balance}, voucher=$${data.data.voucher_balance}`);

      return {
        spentAmount: availableCents,  // For backward compatibility
        spentCurrency: "USD",
        isRealtime: true,
        availableBalance: availableCents,
        cashBalance: cashCents,
        voucherBalance: voucherCents,
      };
    } catch (error) {
      debug("Failed to fetch balance from Moonshot API:", error);
      return null;
    }
  }

  /**
   * Fetch available models from Moonshot API
   * This is a test method to verify API connectivity
   */
  async fetchModels(): Promise<unknown | null> {
    const token = await this.getToken();
    if (!token) {
      debug("No Moonshot API token available");
      return null;
    }

    try {
      const response = await fetch(`${this.apiBaseUrl}/models`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        debug(`Moonshot models API returned status ${response.status}`);
        return null;
      }

      return await response.json();
    } catch (error) {
      debug("Failed to fetch models from Moonshot API:", error);
      return null;
    }
  }
}
