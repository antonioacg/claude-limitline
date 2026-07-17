import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import fs from "node:fs";
import { GlmProvider } from "./glm.js";
import { RateLimitError } from "./types.js";

// Cache helpers use the real fs; mock it so tests don't touch disk and stay
// deterministic (cache miss by default; individual tests seed a hit).
vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("GlmProvider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.ANTHROPIC_AUTH_TOKEN = "test-glm-key";
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  it("advertises name GLM and supportsUsage", () => {
    const p = new GlmProvider();
    expect(p.name).toBe("GLM");
    expect(p.supportsUsage).toBe(true);
  });

  it("getToken reads ANTHROPIC_AUTH_TOKEN", async () => {
    expect(await new GlmProvider().getToken()).toBe("test-glm-key");
  });

  it("getToken returns null when no token", async () => {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    expect(await new GlmProvider().getToken()).toBeNull();
  });

  it("fetchUsage returns null without calling the API when no token", async () => {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    expect(await new GlmProvider().fetchUsage()).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("maps TOKENS_LIMIT windows to short/weekly by unit (not reset time) and skips TIME_LIMIT", async () => {
    // Reset times are deliberately inverted: the weekly window (unit 6) resets
    // BEFORE the ~5h window (unit 3) — the boundary condition that used to swap
    // the two labels when we sorted by nextResetTime. Mapping by unit must still
    // put unit 3 → "short", unit 6 → "weekly" regardless of reset order.
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        code: 200,
        data: {
          limits: [
            { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 4, nextResetTime: 1783577596998 },
            { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 0, nextResetTime: 1786237765994, usage: 1000, currentValue: 0, remaining: 1000 },
            { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 22, nextResetTime: 1784164165981 },
          ],
          level: "pro",
        },
      }),
    });

    const usage = await new GlmProvider().fetchUsage();
    expect(usage).not.toBeNull();
    expect(usage?.windows).toHaveLength(2);
    expect(usage?.windows[0]).toMatchObject({ name: "short", percentUsed: 22 });
    expect(usage?.windows[0].resetAt).toEqual(new Date(1784164165981));
    expect(usage?.windows[1]).toMatchObject({ name: "weekly", percentUsed: 4 });
    expect(usage?.windows[1].resetAt).toEqual(new Date(1783577596998));
  });

  it("marks isOverLimit when percentage >= 100", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        code: 200,
        data: { limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 100, nextResetTime: 1783577596998 },
          { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 150, nextResetTime: 1784164165981 },
        ] },
      }),
    });
    const usage = await new GlmProvider().fetchUsage();
    expect(usage?.windows[0].isOverLimit).toBe(true);
    expect(usage?.windows[1].isOverLimit).toBe(true);
  });

  it("returns null when API code is not 200", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ code: 401, msg: "invalid token" }),
    });
    expect(await new GlmProvider().fetchUsage()).toBeNull();
  });

  it("returns null on non-ok HTTP status", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: "Internal Server Error" });
    expect(await new GlmProvider().fetchUsage()).toBeNull();
  });

  it("throws RateLimitError on 429", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: () => "30" },
    });
    await expect(new GlmProvider().fetchUsage()).rejects.toBeInstanceOf(RateLimitError);
  });

  it("returns null (does not throw) when fetch rejects", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));
    expect(await new GlmProvider().fetchUsage()).toBeNull();
  });

  it("returns null when only TIME_LIMIT windows are present", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        code: 200,
        data: { limits: [{ type: "TIME_LIMIT", unit: 5, number: 1, percentage: 0, nextResetTime: 1786237765994 }] },
      }),
    });
    expect(await new GlmProvider().fetchUsage()).toBeNull();
  });

  describe("fetchBilling", () => {
    const subscriptionResp = () => ({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        code: 200,
        data: [{ customerId: "74431783559242660", productName: "GLM Coding Pro", status: "VALID", inCurrentPeriod: true, nextRenewTime: "2026-08-09", actualPrice: 64.8 }],
        success: true,
      }),
    });
    const balanceResp = (totalBalance: number) => ({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        code: 200,
        data: { accountList: [{ balance: 0, type: 10, frozenBalance: 0 }], totalBalance },
        success: true,
      }),
    });

    it("fetches customerId from subscription/list, then balance, and caches the id", async () => {
      mockFetch
        .mockResolvedValueOnce(subscriptionResp())
        .mockResolvedValueOnce(balanceResp(12.5));

      const billing = await new GlmProvider().fetchBilling();

      expect(billing?.availableBalance).toBe(1250); // $12.50 -> 1250 cents
      expect(billing?.spentCurrency).toBe("USD");
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const calls = mockFetch.mock.calls as unknown[][];
      expect((calls[0][1] as { method: string }).method).toBe("GET");   // subscription
      expect((calls[1][1] as { method: string }).method).toBe("POST");  // balance
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining("glm-customer-id-"),
        expect.stringContaining("74431783559242660"),
      );
    });

    it("uses cached customerId and skips subscription/list", async () => {
      (fs.readFileSync as unknown as Mock).mockReturnValue(
        JSON.stringify({ customerId: "74431783559242660", ts: Date.now() })
      );
      mockFetch.mockResolvedValueOnce(balanceResp(12.5));

      const billing = await new GlmProvider().fetchBilling();

      expect(billing?.availableBalance).toBe(1250);
      expect(mockFetch).toHaveBeenCalledTimes(1); // only accountBalance, no subscription/list
    });

    it("returns null when subscription list has no customerId", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ code: 200, data: [] }),
      });
      expect(await new GlmProvider().fetchBilling()).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1); // did not reach accountBalance
    });

    it("returns null when balance API code !== 200", async () => {
      mockFetch
        .mockResolvedValueOnce(subscriptionResp())
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ code: 500, msg: "denied" }) });
      expect(await new GlmProvider().fetchBilling()).toBeNull();
    });

    it("throws RateLimitError when subscription/list returns 429", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => "30" } });
      await expect(new GlmProvider().fetchBilling()).rejects.toBeInstanceOf(RateLimitError);
    });

    it("returns null and does not call the API when no token", async () => {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      expect(await new GlmProvider().fetchBilling()).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
