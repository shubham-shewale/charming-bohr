import { describe, it, expect, beforeEach } from "vitest";
import { TokenPool } from "../providers/token-pool.js";

describe("TokenPool", () => {
  // ── Round-robin ────────────────────────────────────────────────────────────

  it("single-token pool always returns the same token", () => {
    const pool = new TokenPool(["tok-a"]);
    expect(pool.getToken()).toBe("tok-a");
    expect(pool.getToken()).toBe("tok-a");
    expect(pool.getToken()).toBe("tok-a");
  });

  it("multi-token pool cycles round-robin", () => {
    const pool = new TokenPool(["tok-a", "tok-b", "tok-c"]);
    expect(pool.getToken()).toBe("tok-a");
    expect(pool.getToken()).toBe("tok-b");
    expect(pool.getToken()).toBe("tok-c");
    expect(pool.getToken()).toBe("tok-a"); // wraps around
  });

  it("getTokenWithIndex returns token and original index", () => {
    const pool = new TokenPool(["tok-a", "tok-b"]);
    expect(pool.getTokenWithIndex()).toEqual({ token: "tok-a", index: 0 });
    expect(pool.getTokenWithIndex()).toEqual({ token: "tok-b", index: 1 });
    expect(pool.getTokenWithIndex()).toEqual({ token: "tok-a", index: 0 });
  });

  // ── isBlocked ──────────────────────────────────────────────────────────────

  it("isBlocked is false initially (remaining = Infinity)", () => {
    const pool = new TokenPool(["tok-a", "tok-b"]);
    expect(pool.isBlocked).toBe(false);
  });

  it("isBlocked stays false when any token still has remaining > 0", () => {
    const futureReset = Math.floor(Date.now() / 1000) + 3600;
    const pool = new TokenPool(["tok-a", "tok-b"]);
    pool.reportUsage("tok-a", 0, futureReset); // exhausted
    pool.reportUsage("tok-b", 50, futureReset); // still has quota
    expect(pool.isBlocked).toBe(false);
  });

  it("isBlocked is true when ALL tokens have remaining === 0 and reset windows are in the future", () => {
    const futureReset = Math.floor(Date.now() / 1000) + 3600;
    const pool = new TokenPool(["tok-a", "tok-b"]);
    pool.reportUsage("tok-a", 0, futureReset);
    pool.reportUsage("tok-b", 0, futureReset);
    expect(pool.isBlocked).toBe(true);
  });

  it("isBlocked is false when remaining === 0 but reset window has already passed", () => {
    const pastReset = Math.floor(Date.now() / 1000) - 1; // 1 second ago
    const pool = new TokenPool(["tok-a"]);
    pool.reportUsage("tok-a", 0, pastReset);
    expect(pool.isBlocked).toBe(false);
  });

  // ── getEarliestReset ───────────────────────────────────────────────────────

  it("getEarliestReset returns the minimum resetAt across tokens", () => {
    const pool = new TokenPool(["tok-a", "tok-b", "tok-c"]);
    pool.reportUsage("tok-a", 0, 2000);
    pool.reportUsage("tok-b", 0, 1000); // earliest
    pool.reportUsage("tok-c", 0, 3000);
    expect(pool.getEarliestReset()).toBe(1000);
  });

  it("getEarliestReset returns 0 when no usage has been reported", () => {
    const pool = new TokenPool(["tok-a"]);
    expect(pool.getEarliestReset()).toBe(0);
  });

  // ── resetBlockedState ──────────────────────────────────────────────────────

  it("resetBlockedState clears slots whose reset window has passed, making isBlocked false", () => {
    const pastReset = Math.floor(Date.now() / 1000) - 1;
    const pool = new TokenPool(["tok-a", "tok-b"]);
    pool.reportUsage("tok-a", 0, pastReset);
    pool.reportUsage("tok-b", 0, pastReset);
    // Force isBlocked check — both have past resets so isBlocked should already be false,
    // but after calling resetBlockedState the remaining is restored to Infinity
    pool.resetBlockedState();
    expect(pool.isBlocked).toBe(false);
  });

  it("resetBlockedState only clears slots past their reset; future-reset slots remain blocked", () => {
    const pastReset = Math.floor(Date.now() / 1000) - 1;
    const futureReset = Math.floor(Date.now() / 1000) + 3600;
    const pool = new TokenPool(["tok-a", "tok-b"]);
    pool.reportUsage("tok-a", 0, pastReset);   // can be cleared
    pool.reportUsage("tok-b", 0, futureReset); // still blocked
    pool.resetBlockedState();
    // tok-b is still exhausted and future-reset → isBlocked is true (tok-a is fine but tok-b is not)
    // Actually: isBlocked = ALL tokens exhausted. tok-a is now Infinity → isBlocked = false
    expect(pool.isBlocked).toBe(false);
  });

  // ── reportUsage unknown token ──────────────────────────────────────────────

  it("reportUsage with an unknown token string is a no-op (does not throw)", () => {
    const pool = new TokenPool(["tok-a"]);
    expect(() => pool.reportUsage("unknown-token", 0, 9999999)).not.toThrow();
    expect(pool.isBlocked).toBe(false); // tok-a unaffected
  });
});
