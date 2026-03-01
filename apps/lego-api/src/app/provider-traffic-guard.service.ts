import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { OfferSourceId } from './offer-sources.types';

interface LocalCounterEntry {
  hits: number;
  expiresAtMs: number;
}

interface CooldownSyncState {
  untilMs: number;
  lastSyncAtMs: number;
}

interface GuardPermitOptions {
  minIntervalMs?: number;
  dailyLimit?: number;
  rpmLimit?: number;
  weight?: number;
}

interface GuardPermitResult {
  allowed: boolean;
  reason?: 'cooldown' | 'interval' | 'rpm' | 'daily';
  waitMs?: number;
}

@Injectable()
export class ProviderTrafficGuardService {
  private readonly logger = new Logger(ProviderTrafficGuardService.name);

  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private degradedToMemory = false;

  private readonly localCounters = new Map<string, LocalCounterEntry>();
  private readonly localCooldownUntil = new Map<string, number>();
  private readonly cooldownSync = new Map<string, CooldownSyncState>();
  private lastCleanupAtMs = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private normalizeProvider(providerId: OfferSourceId | string) {
    return String(providerId || '').trim().toLowerCase();
  }

  private parseIntegerConfig(
    envKey: string,
    fallback: number,
    minValue: number,
    maxValue: number,
  ) {
    const parsed = Number.parseInt(
      String(this.config.get<string>(envKey) || String(fallback)),
      10,
    );
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minValue, Math.min(maxValue, parsed));
  }

  private parseBooleanConfig(envKey: string, fallback: boolean) {
    const raw = String(this.config.get<string>(envKey) || '')
      .trim()
      .toLowerCase();
    if (!raw) return fallback;
    return !['0', 'false', 'off', 'no'].includes(raw);
  }

  private isEnabled() {
    return this.parseBooleanConfig('OFFERS_GLOBAL_GUARD_ENABLED', true);
  }

  private useDbBackend() {
    const raw = String(this.config.get<string>('OFFERS_GLOBAL_GUARD_BACKEND') || '')
      .trim()
      .toLowerCase();

    if (!raw) return true;
    return raw !== 'memory';
  }

  private getCooldownSyncMs() {
    return this.parseIntegerConfig('OFFERS_GLOBAL_GUARD_COOLDOWN_SYNC_MS', 2500, 250, 30_000);
  }

  private getProviderDefaultDailyHttpLimit(providerId: string) {
    if (providerId === 'ebay') return 4_500;
    if (providerId === 'brickowl') return 450;
    if (providerId === 'erli') return 12_000;
    if (providerId === 'allegro') return 120_000;
    return 60_000;
  }

  private getProviderDefaultRpmLimit(providerId: string) {
    if (providerId === 'ebay') return 180;
    if (providerId === 'brickowl') return 30;
    if (providerId === 'erli') return 120;
    if (providerId === 'allegro') return 3_000;
    return 600;
  }

  private getProviderDefaultMinIntervalMs(providerId: string) {
    if (providerId === 'ebay') return 250;
    if (providerId === 'brickowl') return 1_100;
    if (providerId === 'erli') return 450;
    if (providerId === 'allegro') return 120;
    return 200;
  }

  private getThrottleReductionPercent() {
    return this.parseIntegerConfig(
      'OFFERS_THROTTLE_REDUCTION_PERCENT',
      30,
      0,
      80,
    );
  }

  private applyThrottleReduction(valueMs: number) {
    const reduction = this.getThrottleReductionPercent();
    const multiplier = Math.max(0, 1 - reduction / 100);
    return Math.max(0, Math.floor(valueMs * multiplier));
  }

  private getProviderIntervalBurst(providerId: string) {
    if (providerId === 'allegro') return 4;
    if (providerId === 'ebay') return 2;
    return 1;
  }

  private resolveProviderConfigLimit(
    baseKey: string,
    providerId: string,
    fallback: number,
    minValue: number,
    maxValue: number,
  ) {
    const suffix = providerId.toUpperCase();
    const providerKey = `${baseKey}_${suffix}`;
    const providerRaw = this.config.get<string>(providerKey);
    if (providerRaw !== undefined) {
      return this.parseIntegerConfig(providerKey, fallback, minValue, maxValue);
    }
    return this.parseIntegerConfig(baseKey, fallback, minValue, maxValue);
  }

  private resolveDailyLimit(providerId: string, override?: number) {
    if (typeof override === 'number' && override > 0) return Math.floor(override);
    return this.resolveProviderConfigLimit(
      'OFFERS_PROVIDER_HTTP_DAILY_LIMIT',
      providerId,
      this.getProviderDefaultDailyHttpLimit(providerId),
      10,
      5_000_000,
    );
  }

  private resolveRpmLimit(providerId: string, override?: number) {
    if (typeof override === 'number' && override > 0) return Math.floor(override);
    return this.resolveProviderConfigLimit(
      'OFFERS_PROVIDER_HTTP_RPM_LIMIT',
      providerId,
      this.getProviderDefaultRpmLimit(providerId),
      1,
      100_000,
    );
  }

  private resolveMinIntervalMs(providerId: string, override?: number) {
    if (typeof override === 'number' && override >= 0) {
      return Math.floor(override);
    }
    const base = this.resolveProviderConfigLimit(
      'OFFERS_PROVIDER_HTTP_MIN_INTERVAL_MS',
      providerId,
      this.getProviderDefaultMinIntervalMs(providerId),
      0,
      60_000,
    );
    return this.applyThrottleReduction(base);
  }

  private resolveCounterKey(scope: string, bucket: string) {
    return `${scope}::${bucket}`;
  }

  private async ensureInitialized() {
    if (this.initialized) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = (async () => {
      if (!this.isEnabled() || !this.useDbBackend()) {
        this.initialized = true;
        return;
      }

      try {
        await this.prisma.$executeRawUnsafe(`
          CREATE TABLE IF NOT EXISTS provider_guard_counter (
            scope TEXT NOT NULL,
            bucket TEXT NOT NULL,
            hits INTEGER NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (scope, bucket)
          )
        `);

        await this.prisma.$executeRawUnsafe(`
          CREATE INDEX IF NOT EXISTS provider_guard_counter_expires_idx
          ON provider_guard_counter (expires_at)
        `);

        await this.prisma.$executeRawUnsafe(`
          CREATE TABLE IF NOT EXISTS provider_guard_cooldown (
            provider TEXT PRIMARY KEY,
            blocked_until TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
      } catch (error) {
        this.degradedToMemory = true;
        this.logger.warn(
          `Global guard DB init failed, fallback to memory mode: ${String((error as any)?.message || error)}`,
        );
      } finally {
        this.initialized = true;
      }
    })();

    await this.initPromise;
  }

  private async maybeCleanupDb() {
    if (this.degradedToMemory || !this.useDbBackend()) return;

    const nowMs = Date.now();
    const cleanupEveryMs = this.parseIntegerConfig(
      'OFFERS_GLOBAL_GUARD_CLEANUP_MS',
      5 * 60_000,
      30_000,
      60 * 60_000,
    );

    if (nowMs - this.lastCleanupAtMs < cleanupEveryMs) return;
    this.lastCleanupAtMs = nowMs;

    try {
      await this.prisma.$executeRawUnsafe(
        `DELETE FROM provider_guard_counter WHERE expires_at < now()`,
      );
      await this.prisma.$executeRawUnsafe(
        `DELETE FROM provider_guard_cooldown WHERE blocked_until < now() - interval '1 day'`,
      );
    } catch {
      // Best effort cleanup only.
    }
  }

  private consumeCounterMemory(
    scope: string,
    bucket: string,
    limit: number,
    ttlSeconds: number,
    weight: number,
  ) {
    const nowMs = Date.now();
    const key = this.resolveCounterKey(scope, bucket);
    const existing = this.localCounters.get(key);

    const expiresAtMs = nowMs + Math.max(1, ttlSeconds) * 1000;
    const currentHits =
      !existing || existing.expiresAtMs <= nowMs
        ? 0
        : Math.max(0, existing.hits);

    if (currentHits + weight > limit) {
      return false;
    }

    this.localCounters.set(key, {
      hits: currentHits + weight,
      expiresAtMs: !existing || existing.expiresAtMs <= nowMs ? expiresAtMs : existing.expiresAtMs,
    });

    return true;
  }

  private async consumeCounterDb(
    scope: string,
    bucket: string,
    limit: number,
    ttlSeconds: number,
    weight: number,
  ) {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ hits: number }>>(
      `
      INSERT INTO provider_guard_counter (scope, bucket, hits, expires_at, updated_at)
      VALUES ($1, $2, $3, now() + ($4 * interval '1 second'), now())
      ON CONFLICT (scope, bucket) DO UPDATE
      SET hits = CASE
          WHEN provider_guard_counter.expires_at <= now() THEN EXCLUDED.hits
          ELSE provider_guard_counter.hits + EXCLUDED.hits
        END,
        expires_at = CASE
          WHEN provider_guard_counter.expires_at <= now() THEN now() + ($4 * interval '1 second')
          ELSE provider_guard_counter.expires_at
        END,
        updated_at = now()
      WHERE provider_guard_counter.expires_at <= now()
         OR provider_guard_counter.hits + EXCLUDED.hits <= $5
      RETURNING hits
      `,
      scope,
      bucket,
      Math.max(1, Math.floor(weight)),
      Math.max(1, Math.floor(ttlSeconds)),
      Math.max(1, Math.floor(limit)),
    );

    return rows.length > 0;
  }

  private async consumeCounter(
    scope: string,
    bucket: string,
    limit: number,
    ttlSeconds: number,
    weight = 1,
  ) {
    if (limit <= 0) return true;

    if (!this.useDbBackend() || this.degradedToMemory) {
      return this.consumeCounterMemory(scope, bucket, limit, ttlSeconds, weight);
    }

    try {
      const allowed = await this.consumeCounterDb(
        scope,
        bucket,
        limit,
        ttlSeconds,
        weight,
      );
      await this.maybeCleanupDb();
      return allowed;
    } catch {
      this.degradedToMemory = true;
      this.logger.warn('Global guard DB consume failed, switched to memory mode.');
      return this.consumeCounterMemory(scope, bucket, limit, ttlSeconds, weight);
    }
  }

  async getCooldownRemainingMs(providerId: OfferSourceId | string) {
    await this.ensureInitialized();

    const provider = this.normalizeProvider(providerId);
    const nowMs = Date.now();

    const localUntil = this.localCooldownUntil.get(provider) || 0;
    if (localUntil > nowMs) {
      return localUntil - nowMs;
    }

    if (!this.useDbBackend() || this.degradedToMemory) {
      return 0;
    }

    const syncState = this.cooldownSync.get(provider) || {
      untilMs: 0,
      lastSyncAtMs: 0,
    };

    if (nowMs - syncState.lastSyncAtMs < this.getCooldownSyncMs()) {
      return Math.max(0, syncState.untilMs - nowMs);
    }

    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ blocked_until: Date | string }>>(
        `SELECT blocked_until FROM provider_guard_cooldown WHERE provider = $1`,
        provider,
      );

      const untilMs = rows[0]?.blocked_until
        ? new Date(rows[0].blocked_until).getTime()
        : 0;

      if (untilMs > nowMs) {
        this.localCooldownUntil.set(provider, untilMs);
      }

      this.cooldownSync.set(provider, {
        untilMs,
        lastSyncAtMs: nowMs,
      });

      return Math.max(0, untilMs - nowMs);
    } catch {
      this.degradedToMemory = true;
      this.logger.warn('Global guard DB cooldown read failed, switched to memory mode.');
      return 0;
    }
  }

  async noteProviderBlock(providerId: OfferSourceId | string, cooldownMs: number) {
    await this.ensureInitialized();

    const provider = this.normalizeProvider(providerId);
    const safeCooldownMs = Math.max(1_000, Math.floor(cooldownMs));
    const untilMs = Date.now() + safeCooldownMs;

    const existingLocal = this.localCooldownUntil.get(provider) || 0;
    if (untilMs > existingLocal) {
      this.localCooldownUntil.set(provider, untilMs);
    }

    this.cooldownSync.set(provider, {
      untilMs: Math.max(untilMs, this.cooldownSync.get(provider)?.untilMs || 0),
      lastSyncAtMs: Date.now(),
    });

    if (!this.useDbBackend() || this.degradedToMemory) {
      return;
    }

    try {
      await this.prisma.$executeRawUnsafe(
        `
        INSERT INTO provider_guard_cooldown (provider, blocked_until, updated_at)
        VALUES ($1, now() + ($2 * interval '1 millisecond'), now())
        ON CONFLICT (provider) DO UPDATE
        SET blocked_until = GREATEST(provider_guard_cooldown.blocked_until, EXCLUDED.blocked_until),
            updated_at = now()
        `,
        provider,
        safeCooldownMs,
      );
      await this.maybeCleanupDb();
    } catch {
      this.degradedToMemory = true;
      this.logger.warn('Global guard DB cooldown write failed, switched to memory mode.');
    }
  }

  async beforeExternalCall(
    providerId: OfferSourceId | string,
    _context: string,
    options?: GuardPermitOptions,
  ): Promise<GuardPermitResult> {
    if (!this.isEnabled()) {
      return { allowed: true };
    }

    await this.ensureInitialized();

    const provider = this.normalizeProvider(providerId);
    const weight = Math.max(1, Math.floor(options?.weight || 1));

    const cooldownRemainingMs = await this.getCooldownRemainingMs(provider);
    if (cooldownRemainingMs > 0) {
      return {
        allowed: false,
        reason: 'cooldown',
        waitMs: cooldownRemainingMs,
      };
    }

    const rpmLimit = this.resolveRpmLimit(provider, options?.rpmLimit);
    const minuteBucket = String(Math.floor(Date.now() / 60_000));
    const rpmAllowed = await this.consumeCounter(
      `rpm:${provider}`,
      minuteBucket,
      rpmLimit,
      120,
      weight,
    );
    if (!rpmAllowed) {
      return {
        allowed: false,
        reason: 'rpm',
        waitMs: 1_000,
      };
    }

    const minIntervalMs = this.resolveMinIntervalMs(provider, options?.minIntervalMs);
    if (minIntervalMs > 0) {
      const bucketSizeMs = Math.max(50, minIntervalMs);
      const bucket = String(Math.floor(Date.now() / bucketSizeMs));
      const burstLimit = this.getProviderIntervalBurst(provider);
      const intervalAllowed = await this.consumeCounter(
        `interval:${provider}`,
        bucket,
        burstLimit,
        Math.ceil(bucketSizeMs / 1000) + 2,
        1,
      );
      if (!intervalAllowed) {
        return {
          allowed: false,
          reason: 'interval',
          waitMs: bucketSizeMs,
        };
      }
    }

    const dailyLimit = this.resolveDailyLimit(provider, options?.dailyLimit);
    const dayBucket = new Date().toISOString().slice(0, 10);
    const dailyAllowed = await this.consumeCounter(
      `daily:${provider}`,
      dayBucket,
      dailyLimit,
      3 * 24 * 60 * 60,
      weight,
    );
    if (!dailyAllowed) {
      return {
        allowed: false,
        reason: 'daily',
        waitMs: 60_000,
      };
    }

    return { allowed: true };
  }
}
