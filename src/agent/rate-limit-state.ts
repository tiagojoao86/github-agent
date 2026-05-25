import { logger } from "../utils/logger";
import { calculateBackoffMs } from "./rate-limit";

export class RateLimitState {
  private hitCount = 0;
  private lastHitAt: Date | null = null;
  private cooldownUntil: Date | null = null;

  recordHit(retryAfterMs?: number): void {
    this.hitCount++;
    this.lastHitAt = new Date();

    const cooldownMs = retryAfterMs ?? calculateBackoffMs(this.hitCount);

    this.cooldownUntil = new Date(Date.now() + cooldownMs);

    logger.warn('Rate limit registrado', {
      hitCount: this.hitCount,
      cooldownUntil: this.cooldownUntil.toISOString(),
      cooldownMs,
    });
  }

  isInCooldown(): boolean {
    if (!this.cooldownUntil) return false;
    return new Date() < this.cooldownUntil;
  }

  getCooldownRemaingMs(): number {
    if (!this.cooldownUntil) return 0;
    return Math.max(0, this.cooldownUntil.getTime() - Date.now());
  }

  reset(): void {
    this.hitCount = 0;
    this.lastHitAt = null;
    this.cooldownUntil = null;
    logger.info('Rate limit state resetado');
  }

  getStatus(): object {
    return {
      hitCount: this.hitCount,
      lastHitAt: this.lastHitAt?.toISOString(),
      cooldownUntil: this.cooldownUntil?.toISOString(),
      isInCooldown: this.isInCooldown(),
      cooldownRemainingMs: this.getCooldownRemaingMs(),
    };
  }
}

