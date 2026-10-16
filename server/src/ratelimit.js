// Tiny in-memory brute-force guard for login endpoints: after `max` failures
// for the same key within `windowMs`, further attempts are refused until the
// window passes. Good enough for a single-instance server.
export function createLoginGuard({ max = 8, windowMs = 15 * 60 * 1000 } = {}) {
  const fails = new Map();
  const prune = (key, now) => {
    const list = (fails.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length) fails.set(key, list); else fails.delete(key);
    return list;
  };
  return {
    blocked(key, now = Date.now()) {
      const list = prune(key, now);
      return list.length >= max ? Math.ceil((windowMs - (now - list[0])) / 60000) : 0;
    },
    fail(key, now = Date.now()) { fails.set(key, [...prune(key, now), now]); },
    reset(key) { fails.delete(key); },
  };
}
