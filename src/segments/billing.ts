import { debug } from "../utils/logger.js";
import { getBillingInfo } from "../utils/oauth.js";

export interface BillingSegmentInfo {
  spentAmount: number | null;
  spentCurrency: string | null;
  isRealtime: boolean;
  monthlyLimit?: number | null;
  utilization?: number | null;
  // Moonshot-specific balances
  availableBalance?: number | null;
  cashBalance?: number | null;
  voucherBalance?: number | null;
}

export class BillingProvider {
  async getBillingInfo(pollInterval?: number): Promise<BillingSegmentInfo> {
    // Try to get data from usage API (contains extra_usage billing info)
    const realtimeInfo = await this.getRealtimeBillingInfo(pollInterval);
    if (realtimeInfo) {
      return realtimeInfo;
    }

    debug("Billing data not available from usage API");
    return {
      spentAmount: null,
      spentCurrency: null,
      isRealtime: false,
    };
  }

  private async getRealtimeBillingInfo(
    pollInterval?: number
  ): Promise<BillingSegmentInfo | null> {
    try {
      const billing = await getBillingInfo(pollInterval ?? 15);
      if (!billing) {
        debug("No billing data available from usage API");
        return null;
      }

      debug(
        `Billing segment: spent=${billing.spentAmount ?? "--"} ${billing.spentCurrency ?? ""}`
      );

      return {
        spentAmount: billing.spentAmount,
        spentCurrency: billing.spentCurrency,
        isRealtime: billing.isRealtime,
        monthlyLimit: billing.monthlyLimit,
        utilization: billing.utilization,
        availableBalance: billing.availableBalance,
        cashBalance: billing.cashBalance,
        voucherBalance: billing.voucherBalance,
      };
    } catch (error) {
      debug("Error getting billing info:", error);
      return null;
    }
  }
}
