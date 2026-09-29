/**
 * In-memory fixed-window limiter (single API instance). Returns false when
 * `key` exceeded `max` failures in the current window.
 */
export function createFailureLimiter(max: number, windowMs: number) {
  const failures = new Map<string, { count: number; resetAt: number }>();
  return {
    isBlocked(key: string) {
      const entry = failures.get(key);
      if (entry && entry.resetAt < Date.now()) {
        failures.delete(key);
        return false;
      }
      return !!entry && entry.count >= max;
    },
    fail(key: string) {
      const now = Date.now();
      const entry = failures.get(key);
      if (!entry || entry.resetAt < now) {
        failures.set(key, { count: 1, resetAt: now + windowMs });
      } else {
        entry.count++;
      }
    },
    reset(key: string) {
      failures.delete(key);
    },
  };
}
