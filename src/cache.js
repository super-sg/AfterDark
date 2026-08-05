'use strict';

/**
 * Tiny TTL cache with a size cap.
 *
 * Feeds are cached *without* per-user vote state so one cached list can serve
 * every reader; the caller stitches the viewer's own votes on afterwards from a
 * single indexed lookup. That is what lets a few hundred requests/second
 * collapse into a handful of feed queries.
 */
class TTLCache {
  constructor({ max = 500, ttl = 4000 } = {}) {
    this.max = max;
    this.ttl = ttl;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() > entry.expires) {
      this.map.delete(key);
      this.misses++;
      return undefined;
    }
    // Refresh recency for the LRU eviction below.
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key, value, ttl = this.ttl) {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, expires: Date.now() + ttl });
    return value;
  }

  /** Fetch through: returns the cached value or computes, stores and returns it. */
  wrap(key, fn, ttl = this.ttl) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    return this.set(key, fn(), ttl);
  }

  clear() {
    this.map.clear();
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      size: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? Number((this.hits / total).toFixed(3)) : 0,
    };
  }
}

module.exports = { TTLCache };
