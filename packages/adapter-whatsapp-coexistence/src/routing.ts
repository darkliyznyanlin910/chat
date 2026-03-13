/**
 * Conversation routing for WhatsApp coexistence mode.
 *
 * Tracks when the human operator last replied from the Business App
 * and decides whether the bot should respond to inbound customer messages.
 */

/**
 * Tracks human activity per thread for conversation routing.
 *
 * Uses an in-memory map with TTL-based cleanup. For multi-instance
 * deployments, replace with a shared store (Redis, etc.).
 */
export class ConversationRouter {
  /** Map of threadId -> timestamp of last human reply */
  private readonly lastHumanReply = new Map<string, number>();

  /** Duration in ms to suppress bot responses after a human reply */
  private readonly takeoverTtlMs: number;

  /** Interval handle for periodic cleanup */
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(takeoverTtlMs: number) {
    this.takeoverTtlMs = takeoverTtlMs;
  }

  /**
   * Record that the human replied from the Business App.
   */
  recordHumanReply(threadId: string): void {
    this.lastHumanReply.set(threadId, Date.now());
    this.ensureCleanup();
  }

  /**
   * Check if the human is currently handling this conversation.
   * Returns true if the human replied within the takeover window.
   */
  isHumanActive(threadId: string): boolean {
    const lastReply = this.lastHumanReply.get(threadId);
    if (lastReply === undefined) {
      return false;
    }
    const elapsed = Date.now() - lastReply;
    if (elapsed > this.takeoverTtlMs) {
      this.lastHumanReply.delete(threadId);
      return false;
    }
    return true;
  }

  /**
   * Get the timestamp of the last human reply for a thread.
   */
  getLastHumanReplyAt(threadId: string): Date | null {
    const ts = this.lastHumanReply.get(threadId);
    if (ts === undefined) {
      return null;
    }
    return new Date(ts);
  }

  /**
   * Get milliseconds since the last human reply, or Infinity if none.
   */
  getMsSinceHumanReply(threadId: string): number {
    const ts = this.lastHumanReply.get(threadId);
    if (ts === undefined) {
      return Number.POSITIVE_INFINITY;
    }
    return Date.now() - ts;
  }

  /**
   * Manually release a thread back to the bot.
   */
  releaseThread(threadId: string): void {
    this.lastHumanReply.delete(threadId);
  }

  /**
   * Stop the cleanup interval. Call this on shutdown.
   */
  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Start periodic cleanup of expired entries.
   */
  private ensureCleanup(): void {
    if (this.cleanupInterval) {
      return;
    }
    // Run cleanup every 5 minutes
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [threadId, ts] of this.lastHumanReply) {
        if (now - ts > this.takeoverTtlMs) {
          this.lastHumanReply.delete(threadId);
        }
      }
      if (this.lastHumanReply.size === 0 && this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }
    }, 5 * 60 * 1000);

    // Don't keep the process alive for cleanup
    if (this.cleanupInterval) {
      try {
        (this.cleanupInterval as { unref?: () => void }).unref?.();
      } catch {
        // unref() not available in this runtime (e.g. Edge Runtime)
      }
    }
  }
}
