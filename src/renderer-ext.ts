/**
 * Extension segment renderers for features not present in upstream.
 * Keeps renderer.ts closer to upstream by isolating our additions here.
 */

import { type SegmentColor, type ColorTheme } from "./themes/index.js";
import { type BillingSegmentInfo } from "./segments/billing.js";
import { type BillingSegmentConfig } from "./config/types.js";
import { getBlockSparkline } from "./utils/history.js";

export interface ExtSegment {
  text: string;
  colors: SegmentColor;
}

// ==================== Currency helpers ====================

export function formatCurrencySymbol(currency: string | null): string {
  switch (currency) {
    case "BRL": return "R$";
    case "USD": return "$";
    case "EUR": return "€";
    default: return currency ?? "$";
  }
}

export function formatCurrency(amount: number | null, currency: string | null, minorUnits = false): string {
  if (amount === null || currency === null) return "--";
  const value = minorUnits ? amount / 100 : amount;
  return `${formatCurrencySymbol(currency)}${value.toFixed(2)}`;
}

// ==================== Billing segment ====================

export function renderBillingSegment(
  info: BillingSegmentInfo,
  billingConfig: BillingSegmentConfig | undefined,
  theme: ColorTheme,
): ExtSegment | null {
  if (!billingConfig?.enabled) return null;

  // Moonshot: show available balance (in minor units / cents)
  if (info.availableBalance !== undefined && info.availableBalance !== null) {
    return {
      text: formatCurrency(info.availableBalance, info.spentCurrency, true),
      colors: theme.context,
    };
  }

  // Anthropic extra_usage: {currency symbol} {used_credits} [{utilization}%]
  // Use config currency as fallback when API doesn't return one
  const currency = info.spentCurrency ?? billingConfig?.currency ?? "USD";
  const symbol = formatCurrencySymbol(currency);
  const hasLimit = info.monthlyLimit != null && info.monthlyLimit > 0;
  const utilization = info.utilization;

  let text: string;
  if (info.spentAmount !== null) {
    text = `${symbol}${info.spentAmount.toFixed(2)}`;
    if (hasLimit && utilization != null) {
      text += ` [${Math.round(utilization)}%]`;
    }
  } else {
    text = "--";
  }

  // Color thresholds based on utilization (only when limit exists)
  let colors: SegmentColor = theme.context;
  if (hasLimit && utilization != null) {
    const critPct = billingConfig?.criticalThreshold ?? 90;
    const warnPct = billingConfig?.warningThreshold ?? 70;
    if (utilization >= critPct) {
      colors = theme.critical;
    } else if (utilization >= warnPct) {
      colors = theme.warning;
    }
  }

  return { text, colors };
}

// ==================== Sparkline segment ====================

export function renderSparklineSegment(
  sparklineWidth: number,
  sparklineRange: number | undefined,
  blockPercent: number,
  warningThreshold: number,
  criticalThreshold: number,
  theme: ColorTheme,
  resetAtMs?: number | null,
): ExtSegment | null {
  const sparkline = getBlockSparkline(sparklineWidth, sparklineRange, resetAtMs);
  if (!sparkline) return null;

  let colors: SegmentColor = theme.block;
  if (blockPercent >= criticalThreshold) {
    colors = theme.critical;
  } else if (blockPercent >= warningThreshold) {
    colors = theme.warning;
  }

  return { text: sparkline, colors };
}

// ==================== Session ID segment ====================

export function renderSessionIdSegment(
  sessionId: string | null,
  theme: ColorTheme,
): ExtSegment | null {
  if (!sessionId) return null;
  return {
    text: sessionId,
    colors: theme.git,
  };
}
