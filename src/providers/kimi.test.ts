import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KimiProvider } from "./kimi.js";
import { RateLimitError } from "./types.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const sampleResponse = () => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve({
    user: { userId: "d5ociammu6s7tavjas40", membership: { level: "LEVEL_BASIC" } },
    usage: { limit: "100", used: "23", remaining: "77", resetTime: "2026-07-15T22:40:32.568225Z" },
    limits: [
      { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", used: "15", remaining: "85", resetTime: "2026-07-09T18:40:32.568225Z" } },
    ],
  }),
});

describe("KimiProvider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-kimi-test";
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  it("advertises name Kimi and supportsUsage", () => {
    const p = new KimiProvider();
    expect(p.name).toBe("Kimi");
    expect(p.supportsUsage).toBe(true);
  });

  it("calls /usages with the API key and the allowlisted KimiCLI User-Agent", async () => {
    mockFetch.mockResolvedValue(sampleResponse());
    await new KimiProvider().fetchUsage();
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.kimi.com/coding/v1/usages",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer sk-kimi-test",
          "User-Agent": "KimiCLI/1.6",
        }),
      })
    );
  });

  it("maps the 5h limits window to short and top-level usage to weekly", async () => {
    mockFetch.mockResolvedValue(sampleResponse());
    const usage = await new KimiProvider().fetchUsage();
    expect(usage).not.toBeNull();
    const short = usage?.windows.find(w => w.name === "short");
    const weekly = usage?.windows.find(w => w.name === "weekly");
    expect(short?.percentUsed).toBe(15); // 15/100
    expect(short?.resetAt).toEqual(new Date("2026-07-09T18:40:32.568225Z"));
    expect(weekly?.percentUsed).toBe(23); // 23/100
    expect(weekly?.resetAt).toEqual(new Date("2026-07-15T22:40:32.568225Z"));
  });

  it("classifies a 7-day limits window as weekly (and skips the top-level usage)", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        usage: { limit: "100", used: "10", resetTime: "2026-07-15T22:40:32Z" },
        limits: [
          { window: { duration: 7, timeUnit: "TIME_UNIT_DAY" }, detail: { limit: "100", used: "50", resetTime: "2026-07-15T22:40:32Z" } },
        ],
      }),
    });
    const usage = await new KimiProvider().fetchUsage();
    expect(usage?.windows.find(w => w.name === "weekly")?.percentUsed).toBe(50);
    expect(usage?.windows.find(w => w.name === "short")).toBeUndefined();
  });

  it("marks isOverLimit when used >= limit", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        usage: { limit: "100", used: "100", resetTime: "2026-07-15T22:40:32Z" },
        limits: [
          { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", used: "120", resetTime: "2026-07-09T18:40:32Z" } },
        ],
      }),
    });
    const usage = await new KimiProvider().fetchUsage();
    expect(usage?.windows.find(w => w.name === "short")?.isOverLimit).toBe(true);
    expect(usage?.windows.find(w => w.name === "weekly")?.isOverLimit).toBe(true);
  });

  it("returns null on 403 (UA allowlist block)", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" });
    expect(await new KimiProvider().fetchUsage()).toBeNull();
  });

  it("throws RateLimitError on 429", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429, headers: { get: () => "30" } });
    await expect(new KimiProvider().fetchUsage()).rejects.toBeInstanceOf(RateLimitError);
  });

  it("returns null and does not call the API when no token", async () => {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    expect(await new KimiProvider().fetchUsage()).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
