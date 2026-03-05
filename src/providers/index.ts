/**
 * Provider factory and exports
 * Automatically detects and instantiates the appropriate provider
 */

import type { Provider } from "./types.js";
import { AnthropicProvider } from "./anthropic.js";
import { MoonshotProvider } from "./moonshot.js";
import { debug } from "../utils/logger.js";

export type { Provider, UsageResponse, UsageWindow, BillingInfo, TrendDirection, TrendInfo, ProviderConfig } from "./types.js";
export { RateLimitError } from "./types.js";
export { AnthropicProvider } from "./anthropic.js";
export { MoonshotProvider } from "./moonshot.js";

// Cache for the current provider instance
let currentProvider: Provider | null = null;
let providerDetectionDone = false;

/**
 * Detect which provider to use based on environment configuration
 * Detection order:
 * 1. ANTHROPIC_BASE_URL - if contains "moonshot", use Moonshot
 * 2. ANTHROPIC_AUTH_TOKEN format - if starts with "sk-ant-oat", use Anthropic
 * 3. Default to Anthropic
 */
export async function detectProvider(): Promise<Provider | null> {
  // Check ANTHROPIC_BASE_URL for moonshot
  const baseUrl = process.env.ANTHROPIC_BASE_URL || "";
  if (baseUrl.includes("moonshot")) {
    debug("Detected Moonshot provider from ANTHROPIC_BASE_URL");
    return new MoonshotProvider();
  }

  // Check token format
  const token = process.env.ANTHROPIC_AUTH_TOKEN || "";
  if (token) {
    if (token.startsWith("sk-ant-oat")) {
      debug("Detected Anthropic provider from token format");
      return new AnthropicProvider();
    } else {
      debug("Detected Moonshot provider from token format (non-Anthropic token)");
      return new MoonshotProvider();
    }
  }

  // Default to Anthropic
  debug("Defaulting to Anthropic provider");
  return new AnthropicProvider();
}

/**
 * Get the current provider instance (cached)
 * Returns null if no provider could be detected
 */
export async function getCurrentProvider(): Promise<Provider | null> {
  if (!providerDetectionDone) {
    currentProvider = await detectProvider();
    providerDetectionDone = true;
  }
  return currentProvider;
}

/**
 * Clear the provider cache (useful for testing)
 */
export function clearProviderCache(): void {
  currentProvider = null;
  providerDetectionDone = false;
}

/**
 * Set a specific provider (useful for testing or explicit configuration)
 */
export function setProvider(provider: Provider | null): void {
  currentProvider = provider;
  providerDetectionDone = true;
}
