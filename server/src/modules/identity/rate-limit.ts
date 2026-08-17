export interface LoginRateLimiterOptions {
  maximumAttempts?: number;
  windowMs?: number;
  now?: () => number;
}

export class LoginRateLimiter {
  private readonly attempts = new Map<string, number[]>();
  private readonly maximumAttempts: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: LoginRateLimiterOptions = {}) {
    this.maximumAttempts = options.maximumAttempts ?? 10;
    this.windowMs = options.windowMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  consume(key: string): boolean {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.attempts.get(key) ?? []).filter(value => value > cutoff);
    if (recent.length >= this.maximumAttempts) {
      this.attempts.set(key, recent);
      return false;
    }
    recent.push(now);
    this.attempts.set(key, recent);
    return true;
  }
}
