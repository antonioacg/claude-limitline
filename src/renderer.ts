import { SYMBOLS, TEXT_SYMBOLS, RESET_CODE } from "./utils/constants.js";
import { getTheme, ansi, type ColorTheme, type SegmentColor } from "./themes/index.js";
import { type LimitlineConfig, type SegmentName } from "./config/index.js";
import { type BlockInfo } from "./segments/block.js";
import { type WeeklyInfo } from "./segments/weekly.js";
import { type BillingSegmentInfo } from "./segments/billing.js";
import { type EnvironmentInfo } from "./utils/environment.js";
import { type TrendInfo } from "./utils/oauth.js";
import { getTerminalWidth } from "./utils/terminal.js";
import { getBlockSparkline } from "./utils/history.js";
import {
  renderBillingSegment,
  renderSparklineSegment,
  renderSessionIdSegment,
} from "./renderer-ext.js";

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
      ssh: symbolSet.ssh,
      kube: symbolSet.kube,
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

  private formatAbsoluteTime(resetAt: Date, format: "12h" | "24h"): string {
    const hours = resetAt.getHours();
    const minutes = resetAt.getMinutes();
    const paddedMinutes = minutes.toString().padStart(2, "0");

    if (format === "24h") {
      const paddedHours = hours.toString().padStart(2, "0");
      return `${paddedHours}:${paddedMinutes}`;
    }

    const hour12 = hours % 12 || 12;
    const ampm = hours < 12 ? "am" : "pm";
    return `${hour12}:${paddedMinutes}${ampm}`;
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

    const sshPrefix = ctx.envInfo.sshSession
      ? `${this.symbols.ssh} `
      : "";

    let text = `${sshPrefix}${name}`;

    // Wrap in OSC 8 hyperlink for Cmd+Click support
    if (ctx.envInfo.directoryPath) {
      text = `\x1b]8;;file://${ctx.envInfo.directoryPath}\x1b\\${text}\x1b]8;;\x1b\\`;
    }

    return {
      text,
      colors: this.theme.directory,
    };
  }

  private renderKubeContext(ctx: RenderContext): Segment | null {
    if (!this.config.kube?.enabled || !ctx.envInfo.kubeContext) {
      return null;
    }

    const icon = this.usePowerline ? this.symbols.kube : "K8S";
    return {
      text: `${icon} ${ctx.envInfo.kubeContext}`,
      colors: this.theme.kube,
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

    const ab = ctx.envInfo.gitAheadBehind;
    let aheadBehind = "";
    if (ab) {
      if (ab.ahead > 0) aheadBehind += ` ↑${ab.ahead}`;
      if (ab.behind > 0) aheadBehind += ` ↓${ab.behind}`;
    }

    return {
      text: `${prefix}${branch}${dirtyIndicator}${aheadBehind}`,
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

    // Add sparkline if enabled (skip in compact mode)
    const showSparkline = this.config.block?.showSparkline ?? false;
    if (showSparkline && !ctx.compact) {
      const sparklineWidth = this.config.block?.sparklineWidth ?? 8;
      const resetAtMs = ctx.blockInfo?.resetAt?.getTime() ?? null;
      const sparkline = getBlockSparkline(sparklineWidth, this.config.block?.sparklineRange, resetAtMs);
      if (sparkline) {
        text += ` ${sparkline}`;
      }
    }

    // Add time if available and enabled (skip in compact mode)
    if (showTime && !ctx.compact) {
      const timeDisplay = this.config.block?.timeDisplay ?? "remaining";
      const timeFormat = this.config.block?.timeFormat ?? "12h";

      if (timeDisplay === "absolute" && ctx.blockInfo.resetAt) {
        const timeStr = this.formatAbsoluteTime(ctx.blockInfo.resetAt, timeFormat);
        text += ` [${timeStr}]`;
      } else if (ctx.blockInfo.timeRemaining !== null) {
        const timeStr = this.formatTimeRemaining(ctx.blockInfo.timeRemaining, ctx.compact);
        text += ` [${timeStr}]`;
      }
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

  // Extension segments — delegated to renderer-ext.ts to reduce upstream diff

  private renderBilling(ctx: RenderContext): Segment | null {
    if (!ctx.billingInfo) return null;
    return renderBillingSegment(ctx.billingInfo, this.config.billing, this.theme) as Segment | null;
  }

  private renderSparkline(ctx: RenderContext): Segment | null {
    return renderSparklineSegment(
      this.config.block?.sparklineWidth ?? 8,
      this.config.block?.sparklineRange,
      ctx.blockInfo?.percentUsed ?? 0,
      this.config.budget?.warningThreshold ?? 70,
      this.config.budget?.criticalThreshold ?? 90,
      this.theme,
      ctx.blockInfo?.resetAt?.getTime() ?? null,
    ) as Segment | null;
  }

  private renderSessionId(ctx: RenderContext): Segment | null {
    return renderSessionIdSegment(ctx.envInfo.sessionId, this.theme) as Segment | null;
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
      case "sessionId":
        return this.renderSessionId(ctx);
      case "sparkline":
        return this.renderSparkline(ctx);
      case "kubeContext":
        return this.renderKubeContext(ctx);
      default:
        return null;
    }
  }

  private normalizeSegmentOrder(order: SegmentName[] | SegmentName[][]): SegmentName[][] {
    if (order.length === 0) return [];
    if (Array.isArray(order[0])) {
      return order as SegmentName[][];
    }
    // Flat array = single line (backward compat)
    return [order as SegmentName[]];
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

    const defaultOrder: SegmentName[][] = [
      ["directory", "git"],
      ["model", "block", "weekly"],
    ];
    const lines = this.normalizeSegmentOrder(this.config.segmentOrder ?? defaultOrder);

    const renderedLines: string[] = [];

    for (const lineOrder of lines) {
      const segments: Segment[] = [];
      for (const name of lineOrder) {
        const segment = this.getSegment(name, ctx);
        if (segment) segments.push(segment);
      }
      if (segments.length === 0) continue;

      if (this.usePowerline) {
        renderedLines.push(this.renderPowerline(segments));
      } else {
        renderedLines.push(this.renderFallback(segments));
      }
    }

    return renderedLines.join("\n");
  }
}
