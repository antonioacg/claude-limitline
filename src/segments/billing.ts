import { debug } from "../utils/logger.js";
import { getBillingInfo } from "../utils/oauth.js";

export interface BillingSegmentInfo {
  // Amount spent (only data available from OAuth API)
  spentAmount: number | null;        // in minor units (cents)
  spentCurrency: string | null;
  isRealtime: boolean;
  // Moonshot-specific balances
  availableBalance?: number | null;  // Total available (cash + voucher)
  cashBalance?: number | null;       // Cash only
  voucherBalance?: number | null;    // Promotional credits
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
