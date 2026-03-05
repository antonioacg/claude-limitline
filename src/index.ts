#!/usr/bin/env node

import { loadConfig } from "./config/index.js";
import { BlockProvider, WeeklyProvider, BillingProvider } from "./segments/index.js";
import { Renderer } from "./renderer.js";
import { getEnvironmentInfo } from "./utils/environment.js";
import { readHookData } from "./utils/claude-hook.js";
import { getUsageTrend, getCurrentProvider, initOAuth } from "./utils/oauth.js";
import { debug, initLogger } from "./utils/logger.js";
import { addSample } from "./utils/history.js";

async function main(): Promise<void> {
  try {
    // Load configuration
    const config = loadConfig();
    initLogger(config);
    initOAuth(config.budget ?? {});
    debug("Config loaded:", JSON.stringify(config));

    // Read hook data from stdin (Claude Code passes this)
    const hookData = await readHookData();
    debug("Hook data:", JSON.stringify(hookData));

    // Get environment info (repo name, git branch, model)
    const envInfo = getEnvironmentInfo(hookData);
    debug("Environment info:", JSON.stringify(envInfo));

    // Detect provider to check capabilities
    const provider = await getCurrentProvider();
    const supportsUsage = provider?.supportsUsage ?? true;
    debug(`Provider: ${provider?.name}, supportsUsage: ${supportsUsage}`);

    // Initialize providers
    const blockProvider = new BlockProvider();
    const weeklyProvider = new WeeklyProvider();
    const billingProvider = new BillingProvider();

    // Get data
    const pollInterval = config.budget?.pollInterval ?? 15;

    const [blockInfo, weeklyInfo, billingInfo] = await Promise.all([
      // Only fetch usage if provider supports it (Moonshot doesn't)
      config.block?.enabled && supportsUsage ? blockProvider.getBlockInfo(pollInterval) : null,
      config.weekly?.enabled && supportsUsage
        ? weeklyProvider.getWeeklyInfo(
            config.budget?.resetDay,
            config.budget?.resetHour,
            config.budget?.resetMinute,
            pollInterval
          )
        : null,
      config.billing?.enabled ? billingProvider.getBillingInfo(pollInterval) : null,
    ]);

    debug("Block info:", JSON.stringify(blockInfo));
    debug("Weekly info:", JSON.stringify(weeklyInfo));
    debug("Billing info:", JSON.stringify(billingInfo));

    // Record usage sample for sparkline history
    if (blockInfo?.percentUsed !== null || weeklyInfo?.percentUsed !== null) {
      addSample(
        blockInfo?.percentUsed ?? null,
        weeklyInfo?.percentUsed ?? null
      );
    }

    // Get trend info for usage changes
    const trendInfo = config.showTrend ? getUsageTrend() : null;
    debug("Trend info:", JSON.stringify(trendInfo));

    // Render output
    const renderer = new Renderer(config);
    const output = renderer.render(blockInfo, weeklyInfo, billingInfo, envInfo, trendInfo);

    if (output) {
      process.stdout.write(output);
    }
  } catch (error) {
    debug("Error in main:", error);
    // Silent failure for statusline - don't break the terminal
    process.exit(0);
  }
}

main();
