/**
 * TokenPool — round-robin multi-token rate-limit tracker for GitHub PATs.
 *
 * Pure state machine: no HTTP knowledge. The pipeline constructs one pool from
 * the parsed `githubPats` config array and passes it to FileFetcher.
 */

interface TokenSlot {
  token: string;
  /** How many requests remain in the current rate-limit window. Starts at Infinity. */
  remaining: number;
  /** UTC epoch seconds when the rate-limit window resets. Starts at 0. */
  resetAt: number;
}

export class TokenPoolExhaustedError extends Error {
  readonly resetAt: number;

  constructor(resetAt: number) {
    super("All GitHub tokens are currently rate-limited.");
    this.name = "TokenPoolExhaustedError";
    this.resetAt = resetAt;
  }
}

export class TokenPool {
  private slots: TokenSlot[];
  private currentIndex = 0;

  constructor(tokens: string[]) {
    if (tokens.length === 0) {
      throw new Error("TokenPool requires at least one token.");
    }
    this.slots = tokens.map((token) => ({ token, remaining: Infinity, resetAt: 0 }));
  }

  /**
   * Returns the next usable token via round-robin and reserves one locally
   * known request. Exhausted tokens are skipped until their reset window.
   */
  getToken(): string {
    this.resetBlockedState();
    const nowSeconds = Date.now() / 1000;

    for (let offset = 0; offset < this.slots.length; offset++) {
      const index = (this.currentIndex + offset) % this.slots.length;
      const slot = this.slots[index]!;
      const blocked = slot.remaining === 0 && nowSeconds < slot.resetAt;
      if (blocked) continue;

      this.currentIndex = (index + 1) % this.slots.length;
      if (Number.isFinite(slot.remaining) && slot.remaining > 0) {
        slot.remaining--;
      }
      return slot.token;
    }

    throw new TokenPoolExhaustedError(this.getEarliestReset());
  }

  /**
   * Updates the rate-limit state for a specific token from GitHub response headers.
   * If the token is not in the pool, this is a no-op.
   */
  reportUsage(token: string, remaining: number, resetAt: number): void {
    const slot = this.slots.find((s) => s.token === token);
    if (!slot) return;

    this.resetBlockedState();
    if (slot.resetAt > 0 && resetAt > 0 && resetAt < slot.resetAt) {
      return;
    }
    if (slot.resetAt === resetAt) {
      slot.remaining = Math.min(slot.remaining, remaining);
      return;
    }

    slot.remaining = remaining;
    slot.resetAt = resetAt;
  }

  /**
   * True when every token has `remaining === 0` and its reset window is in the future.
   * When true, any new GitHub request would immediately 403.
   */
  get isBlocked(): boolean {
    const nowSeconds = Date.now() / 1000;
    return this.slots.every((s) => s.remaining === 0 && nowSeconds < s.resetAt);
  }

  /**
   * Returns the UTC epoch seconds of the soonest token reset, or 0 if no usage has been reported.
   * For rate-limited tokens, prioritizes the soonest reset in the future.
   */
  getEarliestReset(): number {
    const nowSeconds = Date.now() / 1000;
    const activeFutureResets = this.slots
      .filter((s) => s.remaining === 0 && s.resetAt > nowSeconds)
      .map((s) => s.resetAt);
    if (activeFutureResets.length > 0) {
      return Math.min(...activeFutureResets);
    }
    const allResets = this.slots.map((s) => s.resetAt).filter((r) => r > 0);
    if (allResets.length === 0) return 0;
    return Math.min(...allResets);
  }

  /**
   * Clears blocked state for any slot whose reset window has now passed,
   * restoring `remaining` to Infinity so those tokens can be used again.
   */
  resetBlockedState(): void {
    const nowSeconds = Date.now() / 1000;
    for (const slot of this.slots) {
      if (slot.remaining === 0 && nowSeconds >= slot.resetAt) {
        slot.remaining = Infinity;
        slot.resetAt = 0;
      }
    }
  }
}
