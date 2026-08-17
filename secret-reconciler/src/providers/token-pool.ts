/**
 * TokenPool — round-robin multi-token rate-limit tracker for GitHub PATs.
 *
 * Pure state machine: no HTTP knowledge. The pipeline constructs one pool from
 * the parsed `githubPats` config array and passes it to FileFetcher.
 */

interface TokenSlot {
  token: string;
  index: number;
  /** How many requests remain in the current rate-limit window. Starts at Infinity. */
  remaining: number;
  /** UTC epoch seconds when the rate-limit window resets. Starts at 0. */
  resetAt: number;
}

export class TokenPool {
  private slots: TokenSlot[];
  private currentIndex = 0;

  constructor(tokens: string[]) {
    if (tokens.length === 0) {
      throw new Error("TokenPool requires at least one token.");
    }
    this.slots = tokens.map((token, index) => ({ token, index, remaining: Infinity, resetAt: 0 }));
  }

  /**
   * Returns the next token string via round-robin.
   */
  getToken(): string {
    const slot = this.slots[this.currentIndex % this.slots.length]!;
    this.currentIndex = (this.currentIndex + 1) % this.slots.length;
    return slot.token;
  }

  /**
   * Returns the next token string and its index via round-robin.
   */
  getTokenWithIndex(): { token: string; index: number } {
    const slot = this.slots[this.currentIndex % this.slots.length]!;
    this.currentIndex = (this.currentIndex + 1) % this.slots.length;
    return { token: slot.token, index: slot.index };
  }

  /**
   * Updates the rate-limit state for a specific token from GitHub response headers.
   * If the token is not in the pool, this is a no-op.
   */
  reportUsage(token: string, remaining: number, resetAt: number): void {
    const slot = this.slots.find((s) => s.token === token);
    if (!slot) return;
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
   */
  getEarliestReset(): number {
    const resets = this.slots.map((s) => s.resetAt).filter((r) => r > 0);
    if (resets.length === 0) return 0;
    return Math.min(...resets);
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
