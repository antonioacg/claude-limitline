import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getUsageTrend,
  getRealtimeUsage,
  clearUsageCache,
  clearBillingCache,
  getCurrentProvider,
  clearProviderCache,
} from "./oauth.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { MoonshotProvider } from "../providers/moonshot.js";
import { setProvider } from "../providers/index.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("oauth utilities", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUsageCache();
    clearBillingCache();
    clearProviderCache();
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.MOONSHOT_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getRealtimeUsage", () => {
    it("returns parsed usage data on success", async () => {
      const mockResponse = {
        five_hour: {
          resets_at: "2025-01-15T12:00:00Z",
          utilization: 45.5,
        },
        seven_day: {
          resets_at: "2025-01-20T00:00:00Z",
          utilization: 30.2,
        },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      // Create a mock Anthropic provider that returns a test token
      const mockProvider = new AnthropicProvider();
      vi.spyOn(mockProvider, "getToken").mockResolvedValue("sk-ant-oat-test-token");
      setProvider(mockProvider);

      const result = await getRealtimeUsage();

      expect(result).not.toBeNull();
      expect(result?.fiveHour?.percentUsed).toBe(45.5);
      expect(result?.sevenDay?.percentUsed).toBe(30.2);
      expect(result?.fiveHour?.isOverLimit).toBe(false);
    });

    it("sets isOverLimit to true when utilization >= 100", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            five_hour: { utilization: 100 },
            seven_day: { utilization: 150 },
          }),
      });

      const mockProvider = new AnthropicProvider();
      vi.spyOn(mockProvider, "getToken").mockResolvedValue("sk-ant-oat-test-token");
      setProvider(mockProvider);

      const result = await getRealtimeUsage();

      expect(result?.fiveHour?.isOverLimit).toBe(true);
      expect(result?.sevenDay?.isOverLimit).toBe(true);
    });

    it("returns null when API returns error status", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      });

      const mockProvider = new AnthropicProvider();
      vi.spyOn(mockProvider, "getToken").mockResolvedValue("sk-ant-oat-test-token");
      setProvider(mockProvider);

      const result = await getRealtimeUsage();

      expect(result).toBeNull();
    });

    it("returns null when fetch throws", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const mockProvider = new AnthropicProvider();
      vi.spyOn(mockProvider, "getToken").mockResolvedValue("sk-ant-oat-test-token");
      setProvider(mockProvider);

      const result = await getRealtimeUsage();

      expect(result).toBeNull();
    });

    it("handles missing five_hour data", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            seven_day: { utilization: 50 },
          }),
      });

      const mockProvider = new AnthropicProvider();
      vi.spyOn(mockProvider, "getToken").mockResolvedValue("sk-ant-oat-test-token");
      setProvider(mockProvider);

      const result = await getRealtimeUsage();

      expect(result?.fiveHour).toBeNull();
      expect(result?.sevenDay?.percentUsed).toBe(50);
    });

    it("handles missing seven_day data", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            five_hour: { utilization: 25 },
          }),
      });

      const mockProvider = new AnthropicProvider();
      vi.spyOn(mockProvider, "getToken").mockResolvedValue("sk-ant-oat-test-token");
      setProvider(mockProvider);

      const result = await getRealtimeUsage();

      expect(result?.fiveHour?.percentUsed).toBe(25);
      expect(result?.sevenDay).toBeNull();
    });

    it("parses seven_day_opus when present", async () => {
      const mockResponse = {
        five_hour: { utilization: 29.0, resets_at: "2025-01-15T12:00:00Z" },
        seven_day: { utilization: 47.0, resets_at: "2025-01-20T00:00:00Z" },
        seven_day_opus: { utilization: 15.0, resets_at: "2025-01-20T00:00:00Z" },
        seven_day_sonnet: null,
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const mockProvider = new AnthropicProvider();
      vi.spyOn(mockProvider, "getToken").mockResolvedValue("sk-ant-oat-test-token");
      setProvider(mockProvider);

      const result = await getRealtimeUsage();

      expect(result?.sevenDayOpus?.percentUsed).toBe(15.0);
      expect(result?.sevenDaySonnet).toBeNull();
    });

    it("parses seven_day_sonnet when present", async () => {
      const mockResponse = {
        five_hour: { utilization: 29.0 },
        seven_day: { utilization: 47.0 },
        seven_day_opus: null,
        seven_day_sonnet: { utilization: 85.0, resets_at: "2025-01-20T00:00:00Z" },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const mockProvider = new AnthropicProvider();
      vi.spyOn(mockProvider, "getToken").mockResolvedValue("sk-ant-oat-test-token");
      setProvider(mockProvider);

      const result = await getRealtimeUsage();

      expect(result?.sevenDaySonnet?.percentUsed).toBe(85.0);
      expect(result?.sevenDayOpus).toBeNull();
    });

    it("parses all model-specific limits when present", async () => {
      const mockResponse = {
        five_hour: { utilization: 50.0 },
        seven_day: { utilization: 60.0 },
        seven_day_opus: { utilization: 30.0 },
        seven_day_sonnet: { utilization: 70.0 },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const mockProvider = new AnthropicProvider();
      vi.spyOn(mockProvider, "getToken").mockResolvedValue("sk-ant-oat-test-token");
      setProvider(mockProvider);

      const result = await getRealtimeUsage();

      expect(result?.fiveHour?.percentUsed).toBe(50.0);
      expect(result?.sevenDay?.percentUsed).toBe(60.0);
      expect(result?.sevenDayOpus?.percentUsed).toBe(30.0);
      expect(result?.sevenDaySonnet?.percentUsed).toBe(70.0);
    });

    it("sends correct headers", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ five_hour: { utilization: 50 } }),
      });

      const mockProvider = new AnthropicProvider();
      vi.spyOn(mockProvider, "getToken").mockResolvedValue("sk-ant-oat-test-token");
      setProvider(mockProvider);

      await getRealtimeUsage();

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.anthropic.com/api/oauth/usage",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Authorization: "Bearer sk-ant-oat-test-token",
            "anthropic-beta": "oauth-2025-04-20",
          }),
        })
      );
    });
  });

  describe("getUsageTrend", () => {
    it("returns null trends when no cached data", () => {
      const trends = getUsageTrend();

      expect(trends.fiveHourTrend).toBeNull();
      expect(trends.sevenDayTrend).toBeNull();
      expect(trends.sevenDayOpusTrend).toBeNull();
      expect(trends.sevenDaySonnetTrend).toBeNull();
    });

    it("is a function that can be called", () => {
      expect(typeof getUsageTrend).toBe("function");
    });
  });

  describe("provider detection", () => {
    it("detects Moonshot provider from ANTHROPIC_BASE_URL", async () => {
      process.env.ANTHROPIC_BASE_URL = "https://api.moonshot.ai/anthropic";

      const provider = await getCurrentProvider();

      expect(provider).toBeInstanceOf(MoonshotProvider);
      expect(provider?.name).toBe("Moonshot");
    });

    it("detects Anthropic provider from token format", async () => {
      process.env.ANTHROPIC_AUTH_TOKEN = "sk-ant-oat-test-token";

      const provider = await getCurrentProvider();

      expect(provider).toBeInstanceOf(AnthropicProvider);
      expect(provider?.name).toBe("Anthropic");
    });

    it("detects Moonshot provider from non-Anthropic token format", async () => {
      process.env.ANTHROPIC_AUTH_TOKEN = "sk-YccH8MN0GYfiC8ChlyD3riEYLpQKfCFCg9GGa3lU8KALwYXi";

      const provider = await getCurrentProvider();

      expect(provider).toBeInstanceOf(MoonshotProvider);
      expect(provider?.name).toBe("Moonshot");
    });

    it("defaults to Anthropic when no indicators present", async () => {
      const provider = await getCurrentProvider();

      expect(provider).toBeInstanceOf(AnthropicProvider);
      expect(provider?.name).toBe("Anthropic");
    });
  });

  describe("Moonshot provider", () => {
    beforeEach(() => {
      process.env.ANTHROPIC_BASE_URL = "https://api.moonshot.ai/anthropic";
    });

    it("returns null for usage when using Moonshot provider", async () => {
      const result = await getRealtimeUsage();

      // Moonshot doesn't support usage via Anthropic-compatible API
      expect(result).toBeNull();
    });
  });
});
