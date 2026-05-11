// ============================================================
// CodeMorph — Cache Service
// Redis-backed caching with typed helpers & TTL management
// ============================================================
import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@liaoliaots/nestjs-redis';
import Redis from 'ioredis';

export interface CacheOptions {
  ttl?: number;       // seconds, default 300
  compress?: boolean; // future: gzip large payloads
}

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  // Default TTLs (seconds)
  static readonly TTL = {
    SHORT:    30,
    MEDIUM:   300,
    LONG:     3_600,
    DAY:      86_400,
    WEEK:     604_800,
  } as const;

  constructor(
    @InjectRedis()
    private readonly redis: Redis,
  ) {}

  // ── Generic get/set ──────────────────────────────────────
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch (err) {
      this.logger.warn(`Cache get error for key ${key}: ${(err as Error).message}`);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttl = CacheService.TTL.MEDIUM): Promise<void> {
    try {
      await this.redis.setex(key, ttl, JSON.stringify(value));
    } catch (err) {
      this.logger.warn(`Cache set error for key ${key}: ${(err as Error).message}`);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (!keys.length) return;
    try {
      await this.redis.del(...keys);
    } catch (err) {
      this.logger.warn(`Cache del error: ${(err as Error).message}`);
    }
  }

  async delPattern(pattern: string): Promise<number> {
    try {
      const keys = await this.redis.keys(pattern);
      if (!keys.length) return 0;
      await this.redis.del(...keys);
      return keys.length;
    } catch (err) {
      this.logger.warn(`Cache delPattern error for ${pattern}: ${(err as Error).message}`);
      return 0;
    }
  }

  // ── Cache-aside helper ───────────────────────────────────
  async remember<T>(
    key: string,
    factory: () => Promise<T>,
    ttl = CacheService.TTL.MEDIUM,
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const value = await factory();
    await this.set(key, value, ttl);
    return value;
  }

  // ── Atomic increment (rate limits, counters) ─────────────
  async incr(key: string, ttl?: number): Promise<number> {
    const val = await this.redis.incr(key);
    if (val === 1 && ttl) await this.redis.expire(key, ttl);
    return val;
  }

  async incrBy(key: string, amount: number, ttl?: number): Promise<number> {
    const val = await this.redis.incrby(key, amount);
    if (val === amount && ttl) await this.redis.expire(key, ttl);
    return val;
  }

  // ── Distributed lock (Redlock-lite) ─────────────────────
  async acquireLock(resource: string, ttlMs = 30_000): Promise<string | null> {
    const token = `lock:${resource}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const key   = `lock:${resource}`;
    const result = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? token : null;
  }

  async releaseLock(resource: string, token: string): Promise<void> {
    const key = `lock:${resource}`;
    const current = await this.redis.get(key);
    if (current === token) await this.redis.del(key);
  }

  // ── Sliding window rate limiter ──────────────────────────
  async rateLimitSliding(
    key: string,
    windowMs: number,
    limit: number,
  ): Promise<{ allowed: boolean; count: number; resetAt: number }> {
    const now       = Date.now();
    const windowKey = `ratelimit:${key}`;
    const cutoff    = now - windowMs;

    const pipe = this.redis.pipeline();
    pipe.zremrangebyscore(windowKey, '-inf', cutoff);
    pipe.zadd(windowKey, now, `${now}-${Math.random()}`);
    pipe.zcard(windowKey);
    pipe.pexpire(windowKey, windowMs);

    const results = await pipe.exec();
    const count   = (results?.[2]?.[1] as number) ?? 0;

    return {
      allowed: count <= limit,
      count,
      resetAt: now + windowMs,
    };
  }

  // ── Queue deduplication ──────────────────────────────────
  async isJobDuplicate(jobKey: string, ttl = 60): Promise<boolean> {
    const result = await this.redis.set(`dedup:${jobKey}`, '1', 'EX', ttl, 'NX');
    return result === null; // null = already exists = duplicate
  }

  // ── Health check ─────────────────────────────────────────
  async ping(): Promise<boolean> {
    try {
      const result = await this.redis.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  // ── Stats ────────────────────────────────────────────────
  async getStats(): Promise<{ keys: number; memoryMb: number; hitRate: string }> {
    const info = await this.redis.info('stats');
    const memory = await this.redis.info('memory');
    const keys = await this.redis.dbsize();

    const hitMatch = info.match(/keyspace_hits:(\d+)/);
    const missMatch = info.match(/keyspace_misses:(\d+)/);
    const memMatch = memory.match(/used_memory:(\d+)/);

    const hits  = parseInt(hitMatch?.[1] ?? '0', 10);
    const misses = parseInt(missMatch?.[1] ?? '0', 10);
    const memBytes = parseInt(memMatch?.[1] ?? '0', 10);
    const hitRate = hits + misses > 0
      ? `${((hits / (hits + misses)) * 100).toFixed(1)}%`
      : 'n/a';

    return {
      keys,
      memoryMb: Math.round(memBytes / 1024 / 1024),
      hitRate,
    };
  }
}
