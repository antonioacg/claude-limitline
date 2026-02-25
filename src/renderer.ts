import { SYMBOLS, TEXT_SYMBOLS, RESET_CODE } from "./utils/constants.js";
import { getTheme, ansi, type ColorTheme, type SegmentColor } from "./themes/index.js";
import { type LimitlineConfig, type SegmentName } from "./config/index.js";
import { type BlockInfo } from "./segments/block.js";
import { type WeeklyInfo } from "./segments/weekly.js";
import { type BillingSegmentInfo } from "./segments/billing.js";
import { type EnvironmentInfo } from "./utils/environment.js";
import { type TrendInfo } from "./utils/oauth.js";
import { getTerminalWidth } from "./utils/terminal.js";

interface SymbolSet {
  block: string;
  weekly: string;
  opus: string;
  sonnet: string;
  billing: string;
  autoReload: string;
  bottleneck: string;
  rightArrow: string;
  leftArrow: string;
  separator: string;
  branch: string;
  model: string;
  context: string;
  progressFull: string;
  progressEmpty: string;
  trendUp: string;
  trendDown: string;
}

interface Segment {
  text: string;
  colors: SegmentColor;
}

interface RenderContext {
  blockInfo: BlockInfo | null;
  weeklyInfo: WeeklyInfo | null;
  billingInfo: BillingSegmentInfo | null;
  envInfo: EnvironmentInfo;
  trendInfo: TrendInfo | null;
  compact: boolean;
}

export class Renderer {
  private config: LimitlineConfig;
  private theme: ColorTheme;
  private symbols: SymbolSet;
  private usePowerline: boolean;

  constructor(config: LimitlineConfig) {
    this.config = config;
    this.theme = getTheme(config.theme || "dark");

    const useNerd = config.display?.useNerdFonts ?? true;
    const symbolSet = useNerd ? SYMBOLS : TEXT_SYMBOLS;
    this.usePowerline = useNerd;

    this.symbols = {
      block: symbolSet.block_cost,
      weekly: symbolSet.weekly_cost,
      opus: symbolSet.opus_cost,
      sonnet: symbolSet.sonnet_cost,
      billing: symbolSet.billing,
      autoReload: symbolSet.auto_reload,
      bottleneck: symbolSet.bottleneck,
      rightArrow: symbolSet.right,
      leftArrow: symbolSet.left,
      separator: symbolSet.separator,
      branch: symbolSet.branch,
      model: symbolSet.model,
      context: "◐",  // Half-filled circle for context
      progressFull: symbolSet.progress_full,
      progressEmpty: symbolSet.progress_empty,
      trendUp: "↑",
      trendDown: "↓",
    };
  }

  private isCompactMode(): boolean {
    const mode = this.config.display?.compactMode ?? "auto";
    if (mode === "always") return true;
    if (mode === "never") return false;

    // Auto mode - check terminal width
    const threshold = this.config.display?.compactWidth ?? 80;
    const termWidth = getTerminalWidth();
    return termWidth < threshold;
  }

  private formatProgressBar(percent: number, width: number): string {
    const filled = Math.round((percent / 100) * width);
    const empty = width - filled;
    return this.symbols.progressFull.repeat(filled) + this.symbols.progressEmpty.repeat(empty);
  }

  private formatTimeRemaining(minutes: number, compact: boolean): string {
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const mins = String(minutes % 60).padStart(2, '0');
      if (compact) {
        return `${hours}h${mins}m`;
      }
      return `${hours}h${mins}m`;
    }
    return `${String(minutes).padStart(2, '0')}m`;
  }

  private getTrendSymbol(trend: "up" | "down" | "same" | null): string {
    if (!this.config.showTrend) return "";
    if (trend === "up") return this.symbols.trendUp;
    if (trend === "down") return this.symbols.trendDown;
    return "";
  }

  private getColorsForPercent(percent: number, baseColors: SegmentColor): SegmentColor {
    const warningThreshold = this.config.budget?.warningThreshold ?? 70;
    const criticalThreshold = this.config.budget?.criticalThreshold ?? 90;

    if (percent >= criticalThreshold) {
      return this.theme.critical;
    } else if (percent >= warningThreshold) {
      return this.theme.warning;
    }
    return baseColors;
  }

  private renderPowerline(segments: Segment[]): string {
    if (segments.length === 0) return "";

    let output = "";

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const nextColors = i < segments.length - 1 ? segments[i + 1].colors : null;

      // Segment content with background and foreground
      output += ansi.bg(seg.colors.bg) + ansi.fg(seg.colors.fg) + seg.text;

      // Powerline arrow or separator
      output += RESET_CODE;
      if (this.symbols.rightArrow) {
        if (nextColors) {
          output += ansi.fg(seg.colors.bg) + ansi.bg(nextColors.bg) + this.symbols.rightArrow;
        } else {
          output += ansi.fg(seg.colors.bg) + this.symbols.rightArrow;
        }
      } else if (i < segments.length - 1) {
        output += this.symbols.separator;
      }
    }

    output += RESET_CODE;
    return output;
  }

  private renderRightPowerline(segments: Segment[]): string {
    if (segments.length === 0) return "";

    let output = "";

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];

      output += RESET_CODE;
      if (this.symbols.leftArrow) {
        output += ansi.fg(seg.colors.bg) + this.symbols.leftArrow;
      } else {
        output += this.symbols.separator;
      }

      // Segment content with background and foreground
      output += ansi.bg(seg.colors.bg) + ansi.fg(seg.colors.fg) + seg.text;
    }

    output += RESET_CODE;
    return output;
  }

  private renderFallback(segments: Segment[]): string {
    return segments
      .map(seg => ansi.bg(seg.colors.bg) + ansi.fg(seg.colors.fg) + seg.text + RESET_CODE)
      .join(` ${this.symbols.separator} `);
  }

  private renderDirectory(ctx: RenderContext): Segment | null {
    if (!this.config.directory?.enabled || !ctx.envInfo.directory) {
      return null;
    }

    const name = ctx.compact && ctx.envInfo.directory.length > 12
      ? ctx.envInfo.directory.slice(0, 10) + "…"
      : ctx.envInfo.directory;

    return {
      text: `${name}`,
      colors: this.theme.directory,
    };
  }

  private renderGit(ctx: RenderContext): Segment | null {
    if (!this.config.git?.enabled || !ctx.envInfo.gitBranch) {
      return null;
    }

    const showDirty = this.config.git?.showDirtyIndicator ?? true;
    const dirtyIndicator = (showDirty && ctx.envInfo.gitDirty) ? " ●" : "";
    const icon = this.usePowerline ? this.symbols.branch : "";
    const prefix = icon ? `${icon} ` : "";

    let branch = ctx.envInfo.gitBranch;
    if (ctx.compact && branch.length > 10) {
      branch = branch.slice(0, 8) + "…";
    }

    return {
      text: `${prefix}${branch}${dirtyIndicator}`,
      colors: this.theme.git,
    };
  }

  private renderModel(ctx: RenderContext): Segment | null {
    if (!this.config.model?.enabled || !ctx.envInfo.model) {
      return null;
    }

    const icon = this.usePowerline ? this.symbols.model : "";
    const prefix = icon ? `${icon} ` : "";

    return {
      text: `${prefix}${ctx.envInfo.model}`,
      colors: this.theme.model,
    };
  }

  private renderBlock(ctx: RenderContext): Segment | null {
    if (!ctx.blockInfo || !this.config.block?.enabled) {
      return null;
    }

    const icon = this.usePowerline ? this.symbols.block : "BLK";

    if (ctx.blockInfo.percentUsed === null) {
      return {
        text: `${icon} --`,
        colors: this.theme.block,
      };
    }

    const percent = ctx.blockInfo.percentUsed;
    const colors = this.getColorsForPercent(percent, this.theme.block);
    const displayStyle = this.config.block.displayStyle || "text";
    const barWidth = this.config.block.barWidth || 10;
    const showTime = this.config.block.showTimeRemaining ?? true;

    // Get trend symbol
    const trend = this.getTrendSymbol(ctx.trendInfo?.fiveHourTrend ?? null);

    let text: string;

    if (displayStyle === "bar" && !ctx.compact) {
      const bar = this.formatProgressBar(percent, barWidth);
      text = `${bar} ${Math.round(percent)}%${trend}`;
    } else {
      text = `${Math.round(percent)}%${trend}`;
    }

    // Add time remaining if available and enabled (skip in compact mode)
    if (showTime && ctx.blockInfo.timeRemaining !== null && !ctx.compact) {
      const timeStr = this.formatTimeRemaining(ctx.blockInfo.timeRemaining, ctx.compact);
      text += ` [${timeStr}]`;
    }

    return {
      text: `${icon} ${text}`,
      colors,
    };
  }

  private renderWeeklySimple(ctx: RenderContext): Segment | null {
    const info = ctx.weeklyInfo!;
    const icon = this.usePowerline ? this.symbols.weekly : "WK";

    if (info.percentUsed === null) {
      return {
        text: `${icon} --`,
        colors: this.theme.weekly,
      };
    }

    const percent = info.percentUsed;
    const displayStyle = this.config.weekly?.displayStyle || "text";
    const barWidth = this.config.weekly?.barWidth || 10;
    const showWeekProgress = this.config.weekly?.showWeekProgress ?? true;

    // Get trend symbol
    const trend = this.getTrendSymbol(ctx.trendInfo?.sevenDayTrend ?? null);

    let text: string;

    if (displayStyle === "bar" && !ctx.compact) {
      const bar = this.formatProgressBar(percent, barWidth);
      text = `${bar} ${Math.round(percent)}%${trend}`;
    } else {
      text = `${Math.round(percent)}%${trend}`;
    }

    // Add week progress if enabled (skip in compact mode)
    if (showWeekProgress && !ctx.compact) {
      text += ` [wk ${info.weekProgressPercent}%]`;
    }

    return {
      text: `${icon} ${text}`,
      colors: this.theme.weekly,
    };
  }

  private renderWeeklySmart(ctx: RenderContext): Segment | null {
    const info = ctx.weeklyInfo!;
    const overallIcon = this.usePowerline ? this.symbols.weekly : "All";
    const sonnetIcon = this.usePowerline ? this.symbols.sonnet : "So";
    const showWeekProgress = this.config.weekly?.showWeekProgress ?? true;

    // Detect current model from environment
    const currentModel = ctx.envInfo.model?.toLowerCase() ?? "";
    const isSonnet = currentModel.includes("sonnet");

    // If using Sonnet and we have Sonnet-specific data, show: Sonnet | Overall
    if (isSonnet && info.sonnetPercentUsed !== null && info.percentUsed !== null) {
      const sonnetTrend = this.getTrendSymbol(ctx.trendInfo?.sevenDaySonnetTrend ?? null);
      const overallTrend = this.getTrendSymbol(ctx.trendInfo?.sevenDayTrend ?? null);

      let text = `${sonnetIcon} ${Math.round(info.sonnetPercentUsed)}%${sonnetTrend} | ${overallIcon} ${Math.round(info.percentUsed)}%${overallTrend}`;

      if (showWeekProgress && !ctx.compact) {
        text += ` [wk ${info.weekProgressPercent}%]`;
      }

      // Use warning/critical colors based on highest percentage
      const maxPercent = Math.max(info.sonnetPercentUsed, info.percentUsed);
      const colors = this.getColorsForPercent(maxPercent, this.theme.weekly);

      return {
        text: `${text}`,
        colors,
      };
    }

    // For Opus, Haiku, or when no model-specific data: just show overall
    if (info.percentUsed === null) {
      return {
        text: `${overallIcon} --`,
        colors: this.theme.weekly,
      };
    }

    const trend = this.getTrendSymbol(ctx.trendInfo?.sevenDayTrend ?? null);
    let text = `${overallIcon} ${Math.round(info.percentUsed)}%${trend}`;

    if (showWeekProgress && !ctx.compact) {
      text += ` [wk ${info.weekProgressPercent}%]`;
    }

    const colors = this.getColorsForPercent(info.percentUsed, this.theme.weekly);

    return {
      text: `${text}`,
      colors,
    };
  }

  private renderWeekly(ctx: RenderContext): Segment | null {
    if (!ctx.weeklyInfo || !this.config.weekly?.enabled) {
      return null;
    }

    const viewMode = this.config.weekly?.viewMode ?? "simple";

    switch (viewMode) {
      case "smart":
        return this.renderWeeklySmart(ctx);
      case "simple":
      default:
        return this.renderWeeklySimple(ctx);
    }
  }

  private renderContext(ctx: RenderContext): Segment | null {
    if (!this.config.context?.enabled) {
      return null;
    }

    const percent = ctx.envInfo.contextPercent;
    const icon = this.usePowerline ? this.symbols.context : "CTX";
    const colors = this.getColorsForPercent(percent, this.theme.context);

    return {
      text: `${icon} ${percent}%`,
      colors,
    };
  }

  private formatCurrency(amount: number | null, currency: string | null): string {
    if (amount === null || currency === null) return "--";

    // Convert from minor units (cents) to major units
    const majorAmount = amount / 100;

    // Format based on currency
    if (currency === "BRL") {
      return `R$${majorAmount.toFixed(2)}`;
    } else if (currency === "USD") {
      return `$${majorAmount.toFixed(2)}`;
    } else if (currency === "EUR") {
      return `€${majorAmount.toFixed(2)}`;
    }

    // Fallback for other currencies
    return `${currency}${majorAmount.toFixed(2)}`;
  }

  private renderBilling(ctx: RenderContext): Segment | null {
    if (!ctx.billingInfo || !this.config.billing?.enabled) {
      return null;
    }

    const info = ctx.billingInfo;

    // If we have available balance (Moonshot), show it
    if (info.availableBalance !== undefined && info.availableBalance !== null) {
      const balanceStr = this.formatCurrency(info.availableBalance, info.spentCurrency);

      return {
        text: balanceStr,
        colors: this.theme.context,
      };
    }

    // Fallback: Only show spent amount
    const spentStr = this.formatCurrency(info.spentAmount, info.spentCurrency);

    // Use context colors for billing (configurable thresholds)
    let colors = this.theme.context;
    const warningThreshold = this.config.billing?.spendingWarning;
    const criticalThreshold = this.config.billing?.spendingCritical;
    if (criticalThreshold && info.spentAmount !== null && info.spentAmount >= criticalThreshold) {
      colors = this.theme.critical;
    } else if (warningThreshold && info.spentAmount !== null && info.spentAmount >= warningThreshold) {
      colors = this.theme.warning;
    }

    return {
      text: spentStr,
      colors,
    };
  }

  private getSegment(name: SegmentName, ctx: RenderContext): Segment | null {
    switch (name) {
      case "directory":
        return this.renderDirectory(ctx);
      case "git":
        return this.renderGit(ctx);
      case "model":
        return this.renderModel(ctx);
      case "block":
        return this.renderBlock(ctx);
      case "weekly":
        return this.renderWeekly(ctx);
      case "context":
        return this.renderContext(ctx);
      case "billing":
        return this.renderBilling(ctx);
      default:
        return null;
    }
  }

  render(
    blockInfo: BlockInfo | null,
    weeklyInfo: WeeklyInfo | null,
    billingInfo: BillingSegmentInfo | null,
    envInfo: EnvironmentInfo,
    trendInfo: TrendInfo | null = null
  ): string {
    const compact = this.isCompactMode();
    const ctx: RenderContext = {
      blockInfo,
      weeklyInfo,
      billingInfo,
      envInfo,
      trendInfo,
      compact,
    };

    const order = this.config.segmentOrder ?? ["directory", "git", "model", "block", "weekly"];

    // Line 1: directory + git
    const line1Segments: Segment[] = [];
    for (const name of order) {
      if (name === "directory" || name === "git") {
        const segment = this.getSegment(name, ctx);
        if (segment) line1Segments.push(segment);
      }
    }

    // Line 2: everything else (model, block, weekly, context)
    const line2Left: Segment[] = [];
    for (const name of order) {
      if (name === "directory" || name === "git" || name === "context") continue;
      const segment = this.getSegment(name, ctx);
      if (segment) line2Left.push(segment);
    }
    const contextSegment = this.renderContext(ctx);

    // Render
    let output = "";

    // Line 1
    if (line1Segments.length > 0) {
      if (this.usePowerline) {
        output += this.renderPowerline(line1Segments);
      } else {
        output += this.renderFallback(line1Segments);
      }
    }

    // Line 2
    let line2 = "";
    if (this.usePowerline) {
      if (line2Left.length > 0) {
        line2 += this.renderPowerline(line2Left);
      }
      if (contextSegment) {
        line2 += this.renderRightPowerline([contextSegment]);
      }
    } else {
      const allLine2 = contextSegment ? [...line2Left, contextSegment] : line2Left;
      if (allLine2.length > 0) {
        line2 += this.renderFallback(allLine2);
      }
    }
    if (line2) {
      output += "\n" + line2;
    }

    // Line 3: session ID
    if (ctx.envInfo.sessionId) {
      output += "\n" + ansi.fg(this.theme.git.fg) + ctx.envInfo.sessionId + RESET_CODE;
    }

    return output;
  }
}
