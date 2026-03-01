import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { RebrickableService } from './rebrickable.service';
import { Prisma } from '@prisma/client';
import { PartCategoriesService } from './part-categories.service';
import { ColorsService } from './colors.service';
import { OfferSourceDescriptor, OfferSourceId } from './offer-sources.types';
import { parsePositiveInteger } from './offer-quantity.utils';
import { ConfigService } from '@nestjs/config';
import { ProviderTrafficGuardService } from './provider-traffic-guard.service';
import { OfferIndexService } from './offer-index.service';
import { OfferProviderGateway } from './offer-provider.gateway';
import {
  BatchOfferRequestItem,
  BatchOffersDiagnosticsAccumulator,
  CartOptimizationSummary,
  MixedRankingState,
  NormalizedBatchOfferRequestItem,
  OfferPriceSummary,
  ProviderDailyUsageState,
  ProviderOfferCacheEntry,
  ProviderOfferDiagnosticsAccumulator,
  ProviderRateLimiterState,
} from './parts-offers.types';

// Funkcja pomocnicza do opóźnień (Anty-Ban)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class PartsService {
  private readonly logger = new Logger(PartsService.name);
  private isSyncing = false;
  private readonly MISSING_SHIPPING_PENALTY = 9999;
  private readonly providerOfferCache = new Map<string, ProviderOfferCacheEntry>();
  private readonly providerOfferInFlight = new Map<string, Promise<any[]>>();
  private readonly providerRateLimiterState = new Map<
    OfferSourceId,
    ProviderRateLimiterState
  >();
  private readonly providerCooldownUntil = new Map<OfferSourceId, number>();
  private readonly providerDailyUsage = new Map<OfferSourceId, ProviderDailyUsageState>();
  
  private readonly STOP_WORDS = new Set(['with', 'and', 'for', 'the', 'part', 'from']);
  private readonly SEARCH_CATEGORY_ALIASES: Record<string, string[]> = {
    brick: ['brick', 'bricks', 'cegla', 'cegielka', 'klocek', 'klocki'],
    plate: ['plate', 'plates', 'plytka', 'plytki', 'płytka', 'płytki'],
    tile: ['tile', 'tiles'],
    slope: ['slope', 'slopes', 'skos', 'skosy'],
    technic: ['technic', 'liftarm', 'beam', 'axle', 'pin', 'gear'],
    minifigure: ['minifigure', 'minifig', 'minifigs', 'figurka', 'figurki'],
    wheel: ['wheel', 'wheels', 'tyre', 'tire'],
    panel: ['panel', 'panels'],
    wedge: ['wedge', 'wedges'],
    hinge: ['hinge', 'hinges'],
  };

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly rebrickable: RebrickableService,
    private readonly offerProviders: OfferProviderGateway,
    private readonly partCategories: PartCategoriesService,
    private readonly colorsService: ColorsService,
    private readonly trafficGuard: ProviderTrafficGuardService,
    private readonly offerIndex: OfferIndexService,
  ) {}

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

  private parseProviderIntegerConfig(
    baseEnvKey: string,
    providerId: OfferSourceId,
    fallback: number,
    minValue: number,
    maxValue: number,
  ) {
    const suffix = String(providerId || '').trim().toUpperCase();
    const providerEnvKey = `${baseEnvKey}_${suffix}`;
    const providerRaw = this.config.get<string>(providerEnvKey);
    if (providerRaw !== undefined) {
      return this.parseIntegerConfig(providerEnvKey, fallback, minValue, maxValue);
    }
    return this.parseIntegerConfig(baseEnvKey, fallback, minValue, maxValue);
  }

  private getBatchPartConcurrency(partsCount: number) {
    return Math.min(
      Math.max(1, partsCount),
      this.parseIntegerConfig('OFFERS_BATCH_PART_CONCURRENCY', 2, 1, 8),
    );
  }

  private getBatchProviderConcurrency(providersCount: number) {
    return Math.min(
      Math.max(1, providersCount),
      this.parseIntegerConfig(
        'OFFERS_BATCH_PROVIDER_CONCURRENCY',
        4,
        1,
        8,
      ),
    );
  }

  private getBatchRequestTimeoutMs() {
    return this.parseIntegerConfig(
      'OFFERS_BATCH_REQUEST_TIMEOUT_MS',
      45_000,
      5_000,
      300_000,
    );
  }

  private getBatchDeadlineGuardMs() {
    return this.parseIntegerConfig(
      'OFFERS_BATCH_DEADLINE_GUARD_MS',
      1_200,
      200,
      5_000,
    );
  }

  private isBatchPhasedFetchEnabled() {
    return false;
  }

  private getBatchPhaseOneProviderCount(providersCount: number, partsCount: number) {
    if (providersCount <= 1) return providersCount;
    if (partsCount <= 4) return providersCount;
    const configured = this.parseIntegerConfig(
      'OFFERS_BATCH_PHASE1_PROVIDER_COUNT',
      2,
      1,
      providersCount,
    );
    return Math.min(providersCount, configured);
  }

  private getBatchPhaseOneMinimumEligibleOffers() {
    return this.parseIntegerConfig(
      'OFFERS_BATCH_PHASE1_MIN_ELIGIBLE_OFFERS',
      6,
      1,
      40,
    );
  }

  private getBatchPhaseTwoForcedQuantityThreshold() {
    return this.parseIntegerConfig(
      'OFFERS_BATCH_PHASE2_FORCE_QUANTITY',
      20,
      1,
      999,
    );
  }

  private getBatchDisplayOffersLimit() {
    return this.parseIntegerConfig(
      'OFFERS_BATCH_DISPLAY_LIMIT',
      40,
      10,
      120,
    );
  }

  private getBatchOptimizationOffersLimit() {
    return this.parseIntegerConfig(
      'OFFERS_BATCH_OPTIMIZATION_LIMIT',
      80,
      20,
      200,
    );
  }

  private getMixedCandidatesPerPartLimit() {
    return this.parseIntegerConfig(
      'OFFERS_MIX_CANDIDATES_PER_PART',
      18,
      8,
      40,
    );
  }

  private getMixedBeamWidth() {
    return this.parseIntegerConfig(
      'OFFERS_MIX_BEAM_WIDTH',
      420,
      120,
      1600,
    );
  }

  private getMixedExactCombinationLimit() {
    return this.parseIntegerConfig(
      'OFFERS_MIX_EXACT_COMBINATION_LIMIT',
      180000,
      5000,
      2000000,
    );
  }

  private getMixedRankingLimit() {
    return this.parseIntegerConfig(
      'OFFERS_MIX_RANKING_LIMIT',
      30,
      5,
      80,
    );
  }

  private getProviderCacheTtlMs() {
    const seconds = this.parseIntegerConfig(
      'OFFERS_PROVIDER_CACHE_TTL_SECONDS',
      120,
      5,
      900,
    );
    return seconds * 1000;
  }

  private getProviderCacheMaxEntries() {
    return this.parseIntegerConfig(
      'OFFERS_PROVIDER_CACHE_MAX_ENTRIES',
      1200,
      100,
      10000,
    );
  }

  private getProviderRequestTimeoutMs() {
    return this.parseIntegerConfig(
      'OFFERS_PROVIDER_REQUEST_TIMEOUT_MS',
      30000,
      2000,
      120000,
    );
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

  private isDiagnosticsEnabled() {
    const raw = String(
      this.config.get<string>('OFFERS_DIAGNOSTICS_ENABLED') ?? '',
    )
      .trim()
      .toLowerCase();

    if (raw.length > 0) {
      return !['0', 'false', 'off', 'no'].includes(raw);
    }

    const nodeEnv = String(this.config.get<string>('NODE_ENV') || 'development')
      .trim()
      .toLowerCase();
    return nodeEnv !== 'production';
  }

  private getMinSellerRatingPercent(overrideValue?: number | null) {
    if (Number.isFinite(Number(overrideValue))) {
      const normalizedOverride = Number(overrideValue);
      if (normalizedOverride <= 0) return 0;
      return Math.max(0, Math.min(100, normalizedOverride));
    }

    const raw = String(
      this.config.get<string>('OFFERS_MIN_SELLER_RATING_PERCENT') ?? '0',
    )
      .trim()
      .replace(',', '.');
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.max(0, Math.min(100, parsed));
  }

  private supportsSellerRatingFilter(providerId: OfferSourceId) {
    return providerId === 'ebay' || providerId === 'erli';
  }

  private parseOfferSellerRatingPercent(offer: any): number | null {
    const parsed = Number.parseFloat(
      String(offer?.sellerFeedbackPercent ?? 'NaN').replace(',', '.'),
    );
    if (!Number.isFinite(parsed)) return null;
    return Math.max(0, Math.min(100, parsed));
  }

  private applySellerRatingFilterForProvider(
    providerId: OfferSourceId,
    offers: any[],
    minSellerRatingPercentOverride?: number | null,
  ) {
    const minRating = this.getMinSellerRatingPercent(minSellerRatingPercentOverride);
    if (minRating <= 0 || !this.supportsSellerRatingFilter(providerId)) {
      return Array.isArray(offers) ? offers : [];
    }

    const normalizedOffers = Array.isArray(offers) ? offers : [];
    return normalizedOffers.filter((offer) => {
      const ratingPercent = this.parseOfferSellerRatingPercent(offer);
      return ratingPercent !== null && ratingPercent >= minRating;
    });
  }

  private getProviderMinIntervalMs(providerId: OfferSourceId) {
    const providerDefault =
      providerId === 'brickowl'
        ? 1_100
        : providerId === 'erli'
          ? 450
          : providerId === 'ebay'
            ? 250
            : 150;
    const base = this.parseProviderIntegerConfig(
      'OFFERS_PROVIDER_MIN_INTERVAL_MS',
      providerId,
      providerDefault,
      0,
      10_000,
    );
    return this.applyThrottleReduction(base);
  }

  private getProviderMaxConcurrency(providerId: OfferSourceId) {
    const providerDefault = providerId === 'allegro' ? 2 : 1;
    return this.parseProviderIntegerConfig(
      'OFFERS_PROVIDER_MAX_CONCURRENCY',
      providerId,
      providerDefault,
      1,
      8,
    );
  }

  private getProviderCooldownMs(providerId: OfferSourceId) {
    const providerDefault =
      providerId === 'brickowl'
        ? 10 * 60 * 1000
        : providerId === 'erli'
          ? 60_000
          : providerId === 'ebay'
            ? 30_000
            : 45_000;
    return this.parseProviderIntegerConfig(
      'OFFERS_PROVIDER_COOLDOWN_MS',
      providerId,
      providerDefault,
      1_000,
      86_400_000,
    );
  }

  private getProviderDailyLimit(providerId: OfferSourceId) {
    const providerDefault =
      providerId === 'brickowl'
        ? 450
        : providerId === 'erli'
          ? 8_000
          : providerId === 'ebay'
            ? 4_500
            : 100_000;
    return this.parseProviderIntegerConfig(
      'OFFERS_PROVIDER_DAILY_LIMIT',
      providerId,
      providerDefault,
      10,
      2_000_000,
    );
  }

  private consumeProviderDailyBudget(providerId: OfferSourceId) {
    const dayKey = new Date().toISOString().slice(0, 10);
    const state = this.providerDailyUsage.get(providerId);
    const current =
      !state || state.dayKey !== dayKey
        ? { dayKey, count: 0 }
        : { dayKey: state.dayKey, count: state.count };

    const limit = this.getProviderDailyLimit(providerId);
    if (current.count >= limit) {
      this.providerDailyUsage.set(providerId, current);
      return false;
    }

    current.count += 1;
    this.providerDailyUsage.set(providerId, current);
    return true;
  }

  private parseRetryAfterMs(error: any): number | null {
    const headers = error?.response?.headers;
    if (!headers || typeof headers !== 'object') return null;
    const rawHeader =
      headers['retry-after'] ||
      headers['Retry-After'] ||
      headers['x-ratelimit-reset'];
    if (!rawHeader) return null;

    const rawValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const numeric = Number.parseInt(String(rawValue).trim(), 10);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return numeric * 1000;
    }

    const parsedDate = Date.parse(String(rawValue));
    if (!Number.isNaN(parsedDate)) {
      return Math.max(0, parsedDate - Date.now());
    }

    return null;
  }

  private getProviderRateLimiterState(providerId: OfferSourceId) {
    const existing = this.providerRateLimiterState.get(providerId);
    if (existing) return existing;

    const created: ProviderRateLimiterState = {
      active: 0,
      queue: [],
      nextAllowedAt: 0,
    };
    this.providerRateLimiterState.set(providerId, created);
    return created;
  }

  private getProviderCooldownRemainingMs(providerId: OfferSourceId) {
    const until = this.providerCooldownUntil.get(providerId) || 0;
    return Math.max(0, until - Date.now());
  }

  private shouldApplyProviderCooldown(error: unknown) {
    const message = String(
      (error as any)?.message ||
        (error as any)?.response?.data?.message ||
        error ||
        '',
    ).toLowerCase();
    return /(529|429|too many|rate limit|throttl|retry after)/i.test(
      message,
    );
  }

  private noteProviderFailure(providerId: OfferSourceId, error: unknown) {
    const retryAfterMs = this.parseRetryAfterMs(error as any);
    const shouldApply = this.shouldApplyProviderCooldown(error);
    if (!shouldApply && retryAfterMs === null) {
      return;
    }

    const cooldownMs =
      retryAfterMs !== null
        ? Math.max(this.getProviderCooldownMs(providerId), retryAfterMs)
        : this.getProviderCooldownMs(providerId);
    const until = Date.now() + cooldownMs;
    this.providerCooldownUntil.set(providerId, until);
    void this.trafficGuard.noteProviderBlock(providerId, cooldownMs);
  }

  private async acquireProviderSlot(providerId: OfferSourceId) {
    const state = this.getProviderRateLimiterState(providerId);
    const maxConcurrency = this.getProviderMaxConcurrency(providerId);

    await new Promise<void>((resolve) => {
      const tryAcquire = () => {
        if (state.active < maxConcurrency) {
          state.active += 1;
          resolve();
          return;
        }
        state.queue.push(tryAcquire);
      };
      tryAcquire();
    });

    const waitMs = state.nextAllowedAt - Date.now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    const baseIntervalMs = this.getProviderMinIntervalMs(providerId);
    const jitterMs = baseIntervalMs > 0 ? Math.floor(Math.random() * 80) : 0;
    state.nextAllowedAt = Date.now() + baseIntervalMs + jitterMs;

    return () => {
      state.active = Math.max(0, state.active - 1);
      const next = state.queue.shift();
      if (next) {
        next();
      }
    };
  }

  private async runWithProviderRateLimit<T>(
    providerId: OfferSourceId,
    task: () => Promise<T>,
  ): Promise<T> {
    const release = await this.acquireProviderSlot(providerId);
    try {
      return await task();
    } finally {
      release();
    }
  }

  private buildProviderFetchCacheKey(
    providerId: OfferSourceId,
    item: BatchOfferRequestItem,
  ) {
    const ids = this.buildProviderSearchIds(item).sort().slice(0, 12);

    const normalizedPartName = String(item.partName || '').trim().toLowerCase();
    const normalizedColorName = String(item.selectedColorName || '')
      .trim()
      .toLowerCase();

    return [
      providerId,
      `d:${String(item.designId || '').trim().toLowerCase()}`,
      `c:${normalizedColorName}`,
      `p:${normalizedPartName}`,
      `ids:${ids.join(',')}`,
    ].join('|');
  }

  private pruneProviderOfferCache() {
    const now = Date.now();
    for (const [key, entry] of this.providerOfferCache.entries()) {
      if (!entry || entry.expiresAt <= now) {
        this.providerOfferCache.delete(key);
      }
    }

    const maxEntries = this.getProviderCacheMaxEntries();
    if (this.providerOfferCache.size <= maxEntries) return;

    const excess = this.providerOfferCache.size - maxEntries;
    const keysToDrop = Array.from(this.providerOfferCache.keys()).slice(0, excess);
    keysToDrop.forEach((key) => this.providerOfferCache.delete(key));
  }

  private createBatchOffersDiagnosticsAccumulator(
    partsCount: number,
    providersRequested: string[],
    providersResolved: OfferSourceId[],
    partConcurrency: number,
    providerConcurrency: number,
    requestTimeoutMs: number,
    deadlineGuardMs: number,
    phasedFetchEnabled: boolean,
    phaseOneProviders: OfferSourceId[],
    phaseTwoProviders: OfferSourceId[],
  ): BatchOffersDiagnosticsAccumulator {
    const now = Date.now();
    return {
      startedAtMs: now,
      fetchOffersStartedAtMs: now,
      fetchOffersFinishedAtMs: now,
      optimizationStartedAtMs: now,
      optimizationFinishedAtMs: now,
      requestTimeoutMs,
      deadlineGuardMs,
      phasedFetchEnabled,
      partsCount,
      providersRequested: [...providersRequested],
      providersResolved: [...providersResolved],
      phaseOneProviders: [...phaseOneProviders],
      phaseTwoProviders: [...phaseTwoProviders],
      phaseTwoPartsCount: 0,
      phaseTwoSkippedDueDeadline: false,
      partConcurrency,
      providerConcurrency,
      cacheTtlMs: this.getProviderCacheTtlMs(),
      providerStats: new Map<OfferSourceId, ProviderOfferDiagnosticsAccumulator>(),
    };
  }

  private getOrCreateProviderDiagnostics(
    diagnostics: BatchOffersDiagnosticsAccumulator | null,
    providerId: OfferSourceId,
  ): ProviderOfferDiagnosticsAccumulator | null {
    if (!diagnostics) return null;

    const existing = diagnostics.providerStats.get(providerId);
    if (existing) return existing;

    const created: ProviderOfferDiagnosticsAccumulator = {
      providerId,
      cacheHits: 0,
      cacheMisses: 0,
      inFlightHits: 0,
      cooldownSkips: 0,
      deadlineSkips: 0,
      dailyLimitSkips: 0,
      requestsStarted: 0,
      requestsSucceeded: 0,
      requestsFailed: 0,
      offersReturned: 0,
      durationTotalMs: 0,
      minDurationMs: null,
      maxDurationMs: null,
    };
    diagnostics.providerStats.set(providerId, created);
    return created;
  }

  private updateProviderDiagnosticsDuration(
    providerDiagnostics: ProviderOfferDiagnosticsAccumulator | null,
    durationMs: number,
  ) {
    if (!providerDiagnostics) return;

    const safeDuration = Math.max(0, Math.round(durationMs));
    providerDiagnostics.durationTotalMs += safeDuration;
    providerDiagnostics.minDurationMs =
      providerDiagnostics.minDurationMs === null
        ? safeDuration
        : Math.min(providerDiagnostics.minDurationMs, safeDuration);
    providerDiagnostics.maxDurationMs =
      providerDiagnostics.maxDurationMs === null
        ? safeDuration
        : Math.max(providerDiagnostics.maxDurationMs, safeDuration);
  }

  private finalizeBatchOffersDiagnostics(
    diagnostics: BatchOffersDiagnosticsAccumulator | null,
  ) {
    if (!diagnostics) return null;

    const requestFinishedAtMs = Date.now();
    const providerStats = Array.from(diagnostics.providerStats.values())
      .map((entry) => {
        const completedRequests = entry.requestsSucceeded + entry.requestsFailed;
        const avgDurationMs =
          completedRequests > 0
            ? Math.round(entry.durationTotalMs / completedRequests)
            : null;
        const providerId = entry.providerId;

        return {
          providerId,
          cacheHits: entry.cacheHits,
          cacheMisses: entry.cacheMisses,
          inFlightHits: entry.inFlightHits,
          cooldownSkips: entry.cooldownSkips,
          deadlineSkips: entry.deadlineSkips,
          dailyLimitSkips: entry.dailyLimitSkips,
          requestsStarted: entry.requestsStarted,
          requestsSucceeded: entry.requestsSucceeded,
          requestsFailed: entry.requestsFailed,
          offersReturned: entry.offersReturned,
          avgDurationMs,
          minDurationMs: entry.minDurationMs,
          maxDurationMs: entry.maxDurationMs,
          maxConcurrency: this.getProviderMaxConcurrency(providerId),
          minIntervalMs: this.getProviderMinIntervalMs(providerId),
          cooldownMs: this.getProviderCooldownMs(providerId),
          dailyLimit: this.getProviderDailyLimit(providerId),
          dailyUsage:
            this.providerDailyUsage.get(providerId)?.count || 0,
          cooldownRemainingMs: this.getProviderCooldownRemainingMs(providerId),
        };
      })
      .sort((a, b) => a.providerId.localeCompare(b.providerId));

    return {
      enabled: true,
      requestStartedAt: new Date(diagnostics.startedAtMs).toISOString(),
      requestFinishedAt: new Date(requestFinishedAtMs).toISOString(),
      totalDurationMs: Math.max(0, requestFinishedAtMs - diagnostics.startedAtMs),
      partsCount: diagnostics.partsCount,
      providersRequested: diagnostics.providersRequested,
      providersResolved: diagnostics.providersResolved,
      phaseOneProviders: diagnostics.phaseOneProviders,
      phaseTwoProviders: diagnostics.phaseTwoProviders,
      phaseTwoPartsCount: diagnostics.phaseTwoPartsCount,
      phaseTwoSkippedDueDeadline: diagnostics.phaseTwoSkippedDueDeadline,
      requestTimeoutMs: diagnostics.requestTimeoutMs,
      deadlineGuardMs: diagnostics.deadlineGuardMs,
      phasedFetchEnabled: diagnostics.phasedFetchEnabled,
      partConcurrency: diagnostics.partConcurrency,
      providerConcurrency: diagnostics.providerConcurrency,
      cacheTtlMs: diagnostics.cacheTtlMs,
      fetchOffersMs: Math.max(
        0,
        diagnostics.fetchOffersFinishedAtMs - diagnostics.fetchOffersStartedAtMs,
      ),
      optimizationMs: Math.max(
        0,
        diagnostics.optimizationFinishedAtMs - diagnostics.optimizationStartedAtMs,
      ),
      providerStats,
    };
  }

  private async fetchOffersFromProviderCached(
    providerId: OfferSourceId,
    item: BatchOfferRequestItem,
    diagnostics: BatchOffersDiagnosticsAccumulator | null,
    timeoutOverrideMs?: number,
    requestDeadlineAtMs?: number,
    deadlineGuardMs = 0,
    options?: { forceProviderFetch?: boolean },
  ) {
    const providerDiagnostics = this.getOrCreateProviderDiagnostics(
      diagnostics,
      providerId,
    );
    const forceProviderFetch = Boolean(options?.forceProviderFetch);

    const cacheKey = this.buildProviderFetchCacheKey(providerId, item);
    if (!forceProviderFetch) {
      const cached = this.providerOfferCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        if (providerDiagnostics) {
          providerDiagnostics.cacheHits += 1;
        }
        return cached.value;
      }

      const inFlight = this.providerOfferInFlight.get(cacheKey);
      if (inFlight) {
        if (providerDiagnostics) {
          providerDiagnostics.inFlightHits += 1;
        }
        return inFlight;
      }
    }

    const inFlight = this.providerOfferInFlight.get(cacheKey);
    if (inFlight) {
      if (providerDiagnostics) {
        providerDiagnostics.inFlightHits += 1;
      }
      return inFlight;
    }

    let cacheMissRecorded = false;
    if (!forceProviderFetch && this.offerIndex.isEnabled()) {
      const indexed = await this.offerIndex.readOffers(providerId, {
        designId: item.designId,
        partIds: this.buildProviderSearchIds(item),
        partName: item.partName,
        colorName: item.selectedColorName || null,
      });
      const syncFallbackEnabled = this.offerIndex.isSyncFallbackEnabled();
      const hasIndexedSnapshot =
        indexed.state === 'fresh' || indexed.state === 'stale';

      if (hasIndexedSnapshot) {
        if (providerDiagnostics) {
          providerDiagnostics.cacheHits += 1;
          providerDiagnostics.offersReturned += indexed.offers.length;
        }
        if (indexed.offers.length > 0 || !syncFallbackEnabled) {
          this.providerOfferCache.set(cacheKey, {
            value: indexed.offers,
            expiresAt: Date.now() + this.getProviderCacheTtlMs(),
          });
          this.pruneProviderOfferCache();
          return indexed.offers;
        }
      }

      if (!hasIndexedSnapshot && !syncFallbackEnabled) {
        if (providerDiagnostics) {
          providerDiagnostics.cacheMisses += 1;
        }
        return [];
      }

      if (providerDiagnostics) {
        providerDiagnostics.cacheMisses += 1;
        cacheMissRecorded = true;
      }
    }

    const cooldownRemainingMs = this.getProviderCooldownRemainingMs(providerId);
    if (cooldownRemainingMs > 0) {
      if (providerDiagnostics) {
        providerDiagnostics.cooldownSkips += 1;
      }
      return [];
    }

    if (!this.consumeProviderDailyBudget(providerId)) {
      if (providerDiagnostics) {
        providerDiagnostics.dailyLimitSkips += 1;
      }
      return [];
    }

    if (providerDiagnostics) {
      if (!cacheMissRecorded) {
        providerDiagnostics.cacheMisses += 1;
      }
      providerDiagnostics.requestsStarted += 1;
    }

    const requestStartedAtMs = Date.now();
    const baseTimeoutMs = Math.max(
      500,
      timeoutOverrideMs || this.getProviderRequestTimeoutMs(),
    );
    const providerCall = this.runWithProviderRateLimit(providerId, async () => {
      const remainingBudgetMs =
        typeof requestDeadlineAtMs === 'number'
          ? requestDeadlineAtMs - Date.now() - Math.max(0, deadlineGuardMs)
          : Number.POSITIVE_INFINITY;

      if (remainingBudgetMs <= 0) {
        const budgetError = new Error(
          `Provider request budget exhausted (${providerId}/${item.designId})`,
        );
        (budgetError as any).isDeadlineSkip = true;
        throw budgetError;
      }

      const timeoutMs = Number.isFinite(remainingBudgetMs)
        ? Math.min(baseTimeoutMs, Math.max(300, remainingBudgetMs))
        : baseTimeoutMs;

      const fetchPromise = this.fetchOffersFromProvider(providerId, item);
      return await new Promise<any[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `Provider timeout after ${timeoutMs}ms (${providerId}/${item.designId})`,
            ),
          );
        }, timeoutMs);

        fetchPromise
          .then((offers) => resolve(Array.isArray(offers) ? offers : []))
          .catch((error) => reject(error))
          .finally(() => clearTimeout(timer));
      });
    });

    const promise = providerCall
      .then((offers) => {
        const requestDurationMs = Date.now() - requestStartedAtMs;
        this.updateProviderDiagnosticsDuration(providerDiagnostics, requestDurationMs);

        if (!Array.isArray(offers)) {
          if (providerDiagnostics) {
            providerDiagnostics.requestsFailed += 1;
          }
          return [];
        }

        if (providerDiagnostics) {
          providerDiagnostics.requestsSucceeded += 1;
          providerDiagnostics.offersReturned += offers.length;
        }

        const normalized = offers;
        this.providerOfferCache.set(cacheKey, {
          value: normalized,
          expiresAt: Date.now() + this.getProviderCacheTtlMs(),
        });
        this.pruneProviderOfferCache();
        void this.offerIndex
          .saveOffersSnapshot(providerId, {
            designId: item.designId,
            partIds: this.buildProviderSearchIds(item),
            partName: item.partName,
            colorName: item.selectedColorName || null,
          }, normalized)
          .catch(() => undefined);
        return normalized;
      })
      .catch((error) => {
        const requestDurationMs = Date.now() - requestStartedAtMs;
        this.updateProviderDiagnosticsDuration(providerDiagnostics, requestDurationMs);
        const isDeadlineSkip = Boolean((error as any)?.isDeadlineSkip);
        if (isDeadlineSkip && providerDiagnostics) {
          providerDiagnostics.deadlineSkips += 1;
        }
        if (providerDiagnostics) {
          providerDiagnostics.requestsFailed += 1;
        }
        if (!isDeadlineSkip) {
          this.noteProviderFailure(providerId, error);
          void this.offerIndex
            .noteRefreshFailure(providerId, {
              designId: item.designId,
              partIds: this.buildProviderSearchIds(item),
              partName: item.partName,
              colorName: item.selectedColorName || null,
            }, error)
            .catch(() => undefined);
        }
        this.logger.warn(
          `Provider ${providerId} failed for ${item.designId}/${item.selectedColorName || 'no-color'}: ${String(error?.message || error)}`,
        );
        return [];
      });

    this.providerOfferInFlight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.providerOfferInFlight.delete(cacheKey);
    }
  }

  private async runWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    if (items.length === 0) return [];

    const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
    const results = new Array<R>(items.length);
    let nextIndex = 0;

    const workers = Array.from({ length: safeConcurrency }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= items.length) {
          return;
        }

        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    });

    await Promise.all(workers);
    return results;
  }

  private normalizeSearchText(value?: string) {
    return String(value || '')
      .toLowerCase()
      .replace(/(\d)\s*x\s*(\d)/g, '$1 x $2')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeSearchIdToken(value?: string) {
    return String(value || '')
      .toLowerCase()
      .replace(/\.dat$/i, '')
      .replace(/[^a-z0-9]/g, '')
      .trim();
  }

  private isLikelyPartIdSearchToken(value: string) {
    if (value.length < 3 || value.length > 24) return false;
    if (!/^[a-z0-9]+$/i.test(value)) return false;

    if (/^\d{3,10}$/i.test(value)) return true;
    if (/^[a-z]{1,4}\d{2,10}$/i.test(value)) return true;
    if (/^\d{2,10}[a-z]{1,4}$/i.test(value)) return true;
    if (/^\d{3,6}pb\d{1,5}$/i.test(value)) return true;
    if (/^[a-z]{1,2}\d{2,6}[a-z]{1,3}$/i.test(value)) return true;
    return false;
  }

  private extractPartIdTokens(partIds: unknown): string[] {
    const unique = new Set<string>();
    const visit = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach((entry) => visit(entry));
        return;
      }

      if (value && typeof value === 'object') {
        Object.values(value as Record<string, unknown>).forEach((entry) =>
          visit(entry),
        );
        return;
      }

      const normalized = this.normalizeSearchIdToken(value as string);
      if (!normalized) return;
      unique.add(normalized);
    };

    visit(partIds);
    return Array.from(unique.values());
  }

  private async findPartIdsByPartIdsJsonToken(searchToken: string): Promise<number[]> {
    if (!this.isLikelyPartIdSearchToken(searchToken)) return [];

    const likePattern = `%${searchToken}%`;

    try {
      const rows = await this.prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`
        SELECT "id"
        FROM "Part"
        WHERE lower(regexp_replace(CAST("partIds" AS text), '[^a-zA-Z0-9]+', '', 'g')) LIKE ${likePattern}
        LIMIT 250
      `);

      return rows
        .map((row) => Number(row?.id))
        .filter((id) => Number.isInteger(id) && id > 0);
    } catch (error) {
      this.logger.warn(
        `partIds JSON search failed for token "${searchToken}": ${String((error as any)?.message || error)}`,
      );
      return [];
    }
  }

  private hasWholeWord(text: string, token: string) {
    const safeToken = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(^|[^a-z0-9])${safeToken}([^a-z0-9]|$)`, 'i');
    return regex.test(text);
  }

  private isCategoryKeywordToken(token: string) {
    const normalizedToken = this.normalizeSearchText(token);
    if (!normalizedToken) return false;

    return Object.values(this.SEARCH_CATEGORY_ALIASES).some((aliases) =>
      aliases.some(
        (alias) => this.normalizeSearchText(alias) === normalizedToken,
      ),
    );
  }

  private getQueryCategoryHints(normalizedSearch: string, tokens: string[]) {
    const hints = new Set<string>();
    const normalizedTokens = tokens
      .map((token) => this.normalizeSearchText(token))
      .filter((token) => token.length > 0);

    Object.entries(this.SEARCH_CATEGORY_ALIASES).forEach(([hint, aliases]) => {
      const hasAlias = aliases.some((alias) => {
        const normalizedAlias = this.normalizeSearchText(alias);
        if (!normalizedAlias) return false;

        return (
          normalizedTokens.includes(normalizedAlias) ||
          this.hasWholeWord(normalizedSearch, normalizedAlias)
        );
      });

      if (hasAlias) {
        hints.add(hint);
      }
    });

    return hints;
  }

  private getCategoryIntentBoost(
    part: any,
    normalizedSearch: string,
    queryCategoryHints: Set<string>,
  ) {
    if (queryCategoryHints.size === 0) return 0;

    const normalizedPartName = this.normalizeSearchText(part?.name || '');
    const normalizedCategoryName = this.normalizeSearchText(
      part?.partCategory?.name || '',
    );

    let score = 0;
    const hintEntries = Array.from(queryCategoryHints.values());
    const hasCategoryNameMatch = hintEntries.some((hint) =>
      this.hasWholeWord(normalizedCategoryName, hint),
    );
    const hasCategoryNameInPartName = hintEntries.some((hint) =>
      this.hasWholeWord(normalizedPartName, hint),
    );

    if (hasCategoryNameMatch) {
      score += 1400;
    } else if (hasCategoryNameInPartName) {
      score += 900;
    } else {
      score -= 1200;
    }

    const isSimpleCategoryDimensionQuery = /^(brick|plate|tile|slope|technic|minifigure|wheel|panel|wedge|hinge)\s+\d+\s*x\s*\d+$/i.test(
      normalizedSearch,
    );

    if (isSimpleCategoryDimensionQuery) {
      if (normalizedPartName === normalizedSearch) {
        score += 4200;
      } else if (normalizedPartName.startsWith(`${normalizedSearch} `)) {
        score += 950;
        const suffix = normalizedPartName.slice(normalizedSearch.length).trim();
        if (suffix.length > 0) {
          const noisySuffixTokens = [
            'with',
            'without',
            'print',
            'pattern',
            'tapered',
            'old',
            'new',
            'legs',
            'modified',
          ];
          const hasNoisySuffix = noisySuffixTokens.some((token) =>
            this.hasWholeWord(suffix, token),
          );

          if (hasNoisySuffix) {
            score -= 1500;
          } else {
            score -= Math.min(900, suffix.length * 20);
          }
        }
      } else if (normalizedPartName.includes(normalizedSearch)) {
        score += 550;
      }
    }

    return score;
  }

  /**
   * ZAAWANSOWANE WYSZUKIWANIE (Czyta z bazy danych)
   */
  async findAll(
    page: number,
    limit: number,
    search?: string,
    categoryIds?: number[],
    colorIds?: number[]
  ) {
    const skip = (page - 1) * limit;
    const andFilters: Prisma.PartWhereInput[] = [];
    const normalizedSearch = this.normalizeSearchText(search);
    const searchTokens =
      normalizedSearch.length > 0
        ? normalizedSearch.split(/\s+/).filter((t) => !this.STOP_WORDS.has(t))
        : [];
    const searchIdTokens = Array.from(
      new Set(
        searchTokens
          .map((token) => this.normalizeSearchIdToken(token))
          .filter((token) => this.isLikelyPartIdSearchToken(token)),
      ),
    );
    const primarySearchIdToken = searchIdTokens[0] || '';
    const shouldUseIdFilter =
      primarySearchIdToken.length > 0 &&
      (searchTokens.length === 1 ||
        !searchTokens.some((token) => this.isCategoryKeywordToken(token)));

    if (normalizedSearch.length > 0) {
      const dbKeywords = searchTokens.filter(
        (t) => t !== 'x' && t.length > 0 && !/^\d+$/.test(t),
      );

      if (dbKeywords.length > 0) {
        andFilters.push({
          AND: dbKeywords.map((word) => ({
            OR: [
              { name: { contains: word, mode: 'insensitive' } },
              { designId: { contains: word, mode: 'insensitive' } },
            ],
          })),
        });
      }

      if (shouldUseIdFilter) {
        const matchedByJsonPartIds = await this.findPartIdsByPartIdsJsonToken(
          primarySearchIdToken,
        );
        const idOr: Prisma.PartWhereInput[] = [
          {
            designId: {
              contains: primarySearchIdToken,
              mode: 'insensitive',
            },
          },
        ];

        if (matchedByJsonPartIds.length > 0) {
          idOr.push({
            id: {
              in: matchedByJsonPartIds,
            },
          });
        }

        andFilters.push({ OR: idOr });
      }
    }

    if (categoryIds && categoryIds.length > 0) {
      andFilters.push({
        partCatId: {
          in: categoryIds,
        },
      });
    }

    if (colorIds && colorIds.length > 0) {
      andFilters.push({
        colors: {
          some: {
            colorId: {
              in: colorIds,
            },
          },
        },
      });
    }

    const where: Prisma.PartWhereInput =
      andFilters.length === 0
        ? {}
        : andFilters.length === 1
        ? andFilters[0]
        : {
            AND: andFilters,
          };

    const include: Prisma.PartInclude = {
      colors: {
        where: {
          NOT: {
            color: {
              name: {
                startsWith: 'HO',
                mode: 'insensitive',
              },
            },
          },
        },
        include: {
          color: true,
        },
      },
    };

    if (this.partCategories.isCategoriesTableAvailable()) {
      include.partCategory = true;
    }

    const [rawParts, total] = await this.prisma.$transaction([
      this.prisma.part.findMany({
        where,
        take: search ? 1200 : limit,
        skip: search ? 0 : skip,
        ...(search
          ? {}
          : {
              orderBy: [
                {
                  colors: {
                    _count: 'desc' as const,
                  },
                },
                { id: 'asc' as const },
              ],
            }),
        include,
      }),
      this.prisma.part.count({ where }),
    ]);

    let processedData = rawParts;

    if (normalizedSearch.length > 0) {
      const queryCategoryHints = this.getQueryCategoryHints(
        normalizedSearch,
        searchTokens,
      );

      processedData = rawParts
        .map((part) => {
          let score = 0;
          const partName = this.normalizeSearchText(part.name);
          const partId = this.normalizeSearchText(part.designId);
          const partDesignIdToken = this.normalizeSearchIdToken(part.designId);
          const partExternalIdTokens = this.extractPartIdTokens(
            (part as any).partIds,
          );

          if (partId === normalizedSearch) score += 12000;
          if (partName === normalizedSearch) score += 9000;
          else if (partName.includes(normalizedSearch)) score += 5000;
          if (
            shouldUseIdFilter &&
            partDesignIdToken === primarySearchIdToken
          ) {
            score += 13000;
          } else if (
            shouldUseIdFilter &&
            partDesignIdToken.includes(primarySearchIdToken)
          ) {
            score += 5200;
          }

          if (
            shouldUseIdFilter &&
            partExternalIdTokens.includes(primarySearchIdToken)
          ) {
            score += 10500;
          } else if (
            shouldUseIdFilter &&
            partExternalIdTokens.some((token) =>
              token.includes(primarySearchIdToken),
            )
          ) {
            score += 4600;
          }

          searchTokens.forEach((token) => {
             const regex = new RegExp(`\\b${token}\\b`, 'i');
             if (regex.test(partName)) score += 1000;
             else if (partName.includes(token)) score += 100;
          });

          searchIdTokens.forEach((token) => {
            if (partDesignIdToken === token) score += 3000;
            else if (partDesignIdToken.includes(token)) score += 900;

            if (partExternalIdTokens.includes(token)) score += 2000;
            else if (partExternalIdTokens.some((entry) => entry.includes(token))) {
              score += 600;
            }
          });
          
          const dimMatch = normalizedSearch.match(/\d+\s*x\s*\d+/);
          if (dimMatch && partName.includes(dimMatch[0])) score += 3000;
          score += this.getCategoryIntentBoost(
            part,
            normalizedSearch,
            queryCategoryHints,
          );

          score -= partName.length * 5;
          return { ...part, _relevance: score };
        })
        .sort((a, b) => b._relevance - a._relevance)
        .slice(skip, skip + limit);
    }

    const data = processedData.map((part) => {
      const colors = (part as any).colors || [];
      const partCategory = (part as any).partCategory;

      return {
        ...part,
        partCategoryName: partCategory?.name || null,
        colorInfo: {
          totalColors: colors.length,
          colors: colors.map((pc: any) => ({
            color_id: pc.color.id,
            color_name: pc.color.name,
            color_rgb: pc.color.rgb,
            is_trans: pc.color.isTrans,
          })),
        },
      };
    });

    return { data, total, page, limit, lastPage: Math.ceil(total / limit) };
  }

  async getCategories() {
    return this.partCategories.getAll();
  }

  async getColors() {
    return this.colorsService.getAvailableColors();
  }

  getOfferSources(): OfferSourceDescriptor[] {
    return this.offerProviders.getSourceDescriptors();
  }

  private normalizeProviderPartId(value: unknown) {
    return String(value || '')
      .trim()
      .replace(/\.dat$/i, '')
      .replace(/\s+/g, '')
      .trim();
  }

  private isLikelyProviderPartId(value: string) {
    if (!value) return false;
    if (/^\d{3,10}$/i.test(value)) return true;
    if (/^[a-z]{1,3}\d{2,10}$/i.test(value)) return true;
    if (/^\d{2,10}[a-z]{1,3}$/i.test(value)) return true;
    if (/^\d{3,6}pb\d{1,5}$/i.test(value)) return true;
    if (/^[a-z0-9-]{2,20}$/i.test(value) && /\d/.test(value)) return true;
    return false;
  }

  private buildProviderSearchIds(item: BatchOfferRequestItem): string[] {
    const scored = new Map<string, number>();
    const upsert = (rawValue: unknown, score: number) => {
      const value = this.normalizeProviderPartId(rawValue);
      if (!value) return;

      const existing = scored.get(value);
      if (existing === undefined || score > existing) {
        scored.set(value, score);
      }
    };

    const normalizedDesignId = this.normalizeProviderPartId(item.designId || '');
    if (normalizedDesignId.length > 0) {
      upsert(normalizedDesignId, 10_000);
    }

    const rawIds = Array.isArray(item.partIds) ? item.partIds : [];
    rawIds.forEach((entry, index) => {
      const normalized = this.normalizeProviderPartId(entry);
      if (!normalized) return;
      if (normalized !== normalizedDesignId && !this.isLikelyProviderPartId(normalized)) {
        return;
      }

      let score = 5_000 - index * 5;
      if (/^\d{3,6}$/i.test(normalized)) score += 260;
      else if (/^[a-z]\d{3,7}$/i.test(normalized)) score += 200;
      else if (/^\d{3,6}pb\d{1,5}$/i.test(normalized)) score += 140;
      else if (/^\d{7,10}$/i.test(normalized)) score += 90;

      if (normalizedDesignId && normalized === normalizedDesignId) {
        score += 1_000;
      }

      upsert(normalized, score);
    });

    const sorted = Array.from(scored.entries())
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        if (a[0].length !== b[0].length) return a[0].length - b[0].length;
        return a[0].localeCompare(b[0]);
      })
      .map(([value]) => value)
      .slice(0, 12);

    return sorted.length > 0
      ? sorted
      : normalizedDesignId
      ? [normalizedDesignId]
      : [];
  }

  private sanitizeQuantity(value: unknown): number {
    const parsed = Number.parseInt(String(value ?? '1'), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 1;
    return Math.min(parsed, 999);
  }

  private hasMissingShippingPrice(offer: any): boolean {
    return Boolean(offer?.shippingMissingPrice);
  }

  private getOfferDeliveryForOptimization(offer: any): number {
    if (this.hasMissingShippingPrice(offer)) {
      return this.MISSING_SHIPPING_PENALTY;
    }

    return this.parseAmount(offer?.deliveryLowestPrice);
  }

  private getOfferIdentity(offer: any): string {
    const providerKey = offer?.provider ? String(offer.provider) : 'unknown';
    const offerId = String(offer?.offerId || offer?.id || '').trim() || 'unknown';
    return `${providerKey}:${offerId}`;
  }

  private normalizeSellerIdForShipping(offer: any): string | null {
    const sellerId = String(offer?.sellerId || '')
      .trim()
      .toLowerCase();
    return sellerId.length > 0 ? sellerId : null;
  }

  private normalizeSellerLoginForShipping(offer: any): string | null {
    const sellerLogin = String(offer?.sellerLogin || '')
      .trim()
      .toLowerCase();
    return sellerLogin.length > 0 ? sellerLogin : null;
  }

  private getSellerShippingKey(offer: any): string {
    const providerKey = offer?.provider ? String(offer.provider) : 'unknown';
    const sellerId = this.normalizeSellerIdForShipping(offer);
    if (sellerId) {
      return `${providerKey}:id:${sellerId}`;
    }

    const sellerLogin = this.normalizeSellerLoginForShipping(offer);
    if (sellerLogin) {
      return `${providerKey}:login:${sellerLogin}`;
    }

    return `${providerKey}:offer:${String(offer?.offerId || offer?.id || 'unknown')}`;
  }

  private upsertShippingBySeller(
    shippingBySeller: Map<string, number>,
    offer: any,
    shipping: number,
  ): void {
    const providerKey = offer?.provider ? String(offer.provider) : 'unknown';
    const sellerId = this.normalizeSellerIdForShipping(offer);
    const sellerLogin = this.normalizeSellerLoginForShipping(offer);
    const idKey = sellerId ? `${providerKey}:id:${sellerId}` : null;
    const loginKey = sellerLogin ? `${providerKey}:login:${sellerLogin}` : null;

    let targetKey: string;
    if (idKey && shippingBySeller.has(idKey)) {
      targetKey = idKey;
    } else if (loginKey && shippingBySeller.has(loginKey)) {
      targetKey = loginKey;
    } else if (idKey) {
      targetKey = idKey;
    } else if (loginKey) {
      targetKey = loginKey;
    } else {
      targetKey = this.getSellerShippingKey(offer);
    }

    const current = shippingBySeller.get(targetKey);
    if (current === undefined || shipping < current) {
      shippingBySeller.set(targetKey, shipping);
    }

    // If we know both identifiers, merge aliases so shipping is never double-counted.
    if (idKey && loginKey && idKey !== loginKey) {
      const idCost = shippingBySeller.get(idKey);
      const loginCost = shippingBySeller.get(loginKey);

      if (idCost !== undefined && loginCost !== undefined) {
        const mergedCost = Math.min(idCost, loginCost);
        shippingBySeller.set(idKey, mergedCost);
        shippingBySeller.delete(loginKey);
      } else if (idCost === undefined && loginCost !== undefined) {
        shippingBySeller.set(idKey, loginCost);
        shippingBySeller.delete(loginKey);
      }
    }
  }

  private getOversupplyPenaltyFactor(requestedQuantity: number): number {
    if (requestedQuantity <= 2) return 1;
    if (requestedQuantity <= 5) return 0.7;
    if (requestedQuantity <= 10) return 0.45;
    if (requestedQuantity <= 20) return 0.25;
    return 0.15;
  }

  private computeOversupplyPenalty(
    overPurchasedPieces: number,
    effectivePiecePrice: number,
    requestedQuantity: number,
  ): number {
    if (overPurchasedPieces <= 0 || effectivePiecePrice <= 0) {
      return 0;
    }

    const factor = this.getOversupplyPenaltyFactor(requestedQuantity);
    const oversupplyRatio = overPurchasedPieces / Math.max(1, requestedQuantity);
    const ratioModifier = Math.min(1.75, 1 + oversupplyRatio * 0.6);

    return overPurchasedPieces * effectivePiecePrice * factor * ratioModifier;
  }

  private compareOffersForRanking(
    a: any,
    b: any,
    requestedQuantity = 1,
  ): number {
    const shippingMissingDiff =
      Number(this.hasMissingShippingPrice(a)) - Number(this.hasMissingShippingPrice(b));
    if (shippingMissingDiff !== 0) return shippingMissingDiff;

    const aCost = this.buildOfferCostPlan(a, requestedQuantity);
    const bCost = this.buildOfferCostPlan(b, requestedQuantity);
    const availabilityDiff =
      Number(bCost.hasSufficientAvailability) - Number(aCost.hasSufficientAvailability);
    if (availabilityDiff !== 0) return availabilityDiff;

    const precisionDiff = Number(b?.precisionRank || 0) - Number(a?.precisionRank || 0);
    if (precisionDiff !== 0) return precisionDiff;

    const colorDiff = Number(b?.colorMatchScore || 0) - Number(a?.colorMatchScore || 0);
    if (colorDiff !== 0) return colorDiff;

    const priceDiff = aCost.effectiveUnitPrice - bCost.effectiveUnitPrice;
    if (priceDiff !== 0) return priceDiff;

    return this.parseAmount(a?.deliveryLowestPrice) - this.parseAmount(b?.deliveryLowestPrice);
  }

  private compareOffersForOptimization(
    a: any,
    b: any,
    requestedQuantity = 1,
  ): number {
    const shippingMissingDiff =
      Number(this.hasMissingShippingPrice(a)) - Number(this.hasMissingShippingPrice(b));
    if (shippingMissingDiff !== 0) return shippingMissingDiff;

    const aCost = this.buildOfferCostPlan(a, requestedQuantity);
    const bCost = this.buildOfferCostPlan(b, requestedQuantity);
    const availabilityDiff =
      Number(bCost.hasSufficientAvailability) - Number(aCost.hasSufficientAvailability);
    if (availabilityDiff !== 0) return availabilityDiff;

    const objectiveDiff = aCost.customerLineScore - bCost.customerLineScore;
    if (objectiveDiff !== 0) return objectiveDiff;

    const lineTotalDiff = aCost.lineTotal - bCost.lineTotal;
    if (lineTotalDiff !== 0) return lineTotalDiff;

    const oversupplyDiff = aCost.overPurchasedPieces - bCost.overPurchasedPieces;
    if (oversupplyDiff !== 0) return oversupplyDiff;

    const precisionDiff = Number(b?.precisionRank || 0) - Number(a?.precisionRank || 0);
    if (precisionDiff !== 0) return precisionDiff;

    const colorDiff = Number(b?.colorMatchScore || 0) - Number(a?.colorMatchScore || 0);
    if (colorDiff !== 0) return colorDiff;

    return this.getOfferDeliveryForOptimization(a) - this.getOfferDeliveryForOptimization(b);
  }

  private isBetterOfferForOptimization(
    currentOffer: any,
    candidateOffer: any,
    requestedQuantity = 1,
  ): boolean {
    if (!currentOffer) return true;
    return (
      this.compareOffersForOptimization(
        candidateOffer,
        currentOffer,
        requestedQuantity,
      ) < 0
    );
  }

  private buildOptimizationCandidates(
    offers: any[],
    requestedQuantity: number,
    limit = 12,
  ): any[] {
    const eligible = offers.filter((offer) =>
      this.isOfferEligibleForRequestedQuantity(offer, requestedQuantity),
    );

    if (eligible.length === 0) return [];

    const scored = eligible
      .map((offer) => ({
        offer,
        costPlan: this.buildOfferCostPlan(offer, requestedQuantity),
        sellerKey: this.getSellerShippingKey(offer),
      }))
      .sort((a, b) =>
        this.compareOffersForOptimization(a.offer, b.offer, requestedQuantity),
      );

    const selected: any[] = [];
    const selectedKeys = new Set<string>();
    const selectedSellers = new Set<string>();
    const pushEntry = (entry: (typeof scored)[number]) => {
      const key = this.getOfferIdentity(entry.offer);
      if (selectedKeys.has(key)) return;
      selectedKeys.add(key);
      selected.push(entry.offer);
    };

    // 1) Najlepszy koszt finalny dla klienta.
    scored.slice(0, 8).forEach((entry) => pushEntry(entry));

    // 2) Dodatkowo bierzemy "best fit" ilościowy (mniejszy nadmiar sztuk).
    [...scored]
      .sort((a, b) => {
        if (a.costPlan.overPurchasedPieces !== b.costPlan.overPurchasedPieces) {
          return a.costPlan.overPurchasedPieces - b.costPlan.overPurchasedPieces;
        }
        return a.costPlan.customerLineScore - b.costPlan.customerLineScore;
      })
      .slice(0, 4)
      .forEach((entry) => pushEntry(entry));

    // 3) Jedna mocna oferta per sprzedawca, aby dać szansę miksowi z jedną wysyłką.
    for (const entry of scored) {
      if (selectedSellers.has(entry.sellerKey)) continue;
      selectedSellers.add(entry.sellerKey);
      pushEntry(entry);
      if (selected.length >= limit) break;
    }

    // 4) Uzupełnienie do limitu.
    for (const entry of scored) {
      pushEntry(entry);
      if (selected.length >= limit) break;
    }

    return selected.slice(0, limit);
  }

  private resolveActiveProviderIds(requestedProviders?: string[]): OfferSourceId[] {
    const available = this.getOfferSources();
    const enabledAndConfigured = available
      .filter((source) => source.enabled && source.configured)
      .map((source) => source.id);

    if (enabledAndConfigured.length === 0) {
      return [];
    }

    const requested = Array.isArray(requestedProviders)
      ? Array.from(
          new Set(
            requestedProviders
              .map((entry) => String(entry || '').trim().toLowerCase())
              .filter((entry) => entry.length > 0),
          ),
        )
      : [];

    if (requested.length === 0) {
      return enabledAndConfigured;
    }

    const selected = enabledAndConfigured.filter((providerId) =>
      requested.includes(providerId),
    );

    return selected;
  }

  private getProviderPriority(providerId: OfferSourceId): number {
    switch (providerId) {
      case 'allegro':
        return 100;
      case 'erli':
        return 80;
      case 'ebay':
        return 60;
      case 'brickowl':
        return 40;
      default:
        return 10;
    }
  }

  private sortProvidersByPriority(providerIds: OfferSourceId[]): OfferSourceId[] {
    return [...providerIds].sort((a, b) => {
      const priorityDiff = this.getProviderPriority(b) - this.getProviderPriority(a);
      if (priorityDiff !== 0) return priorityDiff;
      return String(a).localeCompare(String(b));
    });
  }

  private splitProvidersForBatchPhases(
    activeProviders: OfferSourceId[],
    partsCount: number,
  ) {
    const sortedProviders = this.sortProvidersByPriority(activeProviders);
    const phasedEnabled = this.isBatchPhasedFetchEnabled();
    if (!phasedEnabled || sortedProviders.length <= 1) {
      return {
        phasedEnabled,
        phaseOneProviders: sortedProviders,
        phaseTwoProviders: [] as OfferSourceId[],
      };
    }

    const phaseOneCount = this.getBatchPhaseOneProviderCount(
      sortedProviders.length,
      partsCount,
    );
    return {
      phasedEnabled,
      phaseOneProviders: sortedProviders.slice(0, phaseOneCount),
      phaseTwoProviders: sortedProviders.slice(phaseOneCount),
    };
  }

  private setPartProviderOffers(
    offersByPartAndProvider: Map<string, Map<OfferSourceId, any[]>>,
    partKey: string,
    providerId: OfferSourceId,
    offers: any[],
  ) {
    const normalizedPartKey = String(partKey || '').trim();
    if (!normalizedPartKey) return;

    const byProvider =
      offersByPartAndProvider.get(normalizedPartKey) ||
      new Map<OfferSourceId, any[]>();
    byProvider.set(providerId, Array.isArray(offers) ? offers : []);
    offersByPartAndProvider.set(normalizedPartKey, byProvider);
  }

  private mergeAndRankOffersForPart(
    offersByProvider: Map<OfferSourceId, any[]>,
    requestedQuantity: number,
    optimizationOffersLimit: number,
  ): any[] {
    const mergedOffers = Array.from(offersByProvider.values()).flat();
    const deduped = new Map<string, any>();

    mergedOffers.forEach((offer) => {
      const key = `${offer?.provider || 'unknown'}:${String(offer?.id || '')}`;
      if (!offer?.id || !offer?.url) return;

      const existing = deduped.get(key);
      if (
        !existing ||
        this.isBetterOfferForBasket(existing, offer, requestedQuantity)
      ) {
        deduped.set(key, offer);
      }
    });

    return Array.from(deduped.values())
      .sort((a, b) => this.compareOffersForRanking(a, b, requestedQuantity))
      .slice(0, optimizationOffersLimit);
  }

  private buildDisplayOffersWithProviderCoverage(
    rankedOffers: any[],
    activeProviders: OfferSourceId[],
    limit: number,
    minPerProvider = 2,
  ) {
    if (!Array.isArray(rankedOffers) || rankedOffers.length === 0) {
      return [];
    }

    const safeLimit = Math.max(1, limit);
    const safeMinPerProvider = Math.max(0, minPerProvider);
    const byProvider = new Map<OfferSourceId, any[]>();
    const activeSet = new Set(activeProviders);

    rankedOffers.forEach((offer) => {
      const providerId = String(
        offer?.provider || '',
      ).toLowerCase() as OfferSourceId;
      if (!activeSet.has(providerId)) return;
      const list = byProvider.get(providerId) || [];
      list.push(offer);
      byProvider.set(providerId, list);
    });

    const selected: any[] = [];
    const seen = new Set<string>();
    const pick = (offer: any) => {
      const identity = this.getOfferIdentity(offer);
      if (!identity || seen.has(identity)) return;
      seen.add(identity);
      selected.push(offer);
    };

    for (const providerId of activeProviders) {
      const providerOffers = byProvider.get(providerId) || [];
      providerOffers.slice(0, safeMinPerProvider).forEach((offer) => pick(offer));
      if (selected.length >= safeLimit) {
        return selected.slice(0, safeLimit);
      }
    }

    for (const offer of rankedOffers) {
      pick(offer);
      if (selected.length >= safeLimit) break;
    }

    return selected.slice(0, safeLimit);
  }

  private countEligibleOffersForQuantity(
    offers: any[],
    requestedQuantity: number,
  ) {
    if (!Array.isArray(offers) || offers.length === 0) return 0;
    return offers.filter((offer) =>
      this.isOfferEligibleForRequestedQuantity(offer, requestedQuantity),
    ).length;
  }

  private shouldExpandPartToPhaseTwo(
    part: NormalizedBatchOfferRequestItem,
    phaseOneRankedOffers: any[],
  ): boolean {
    if (part.requestedQuantity >= this.getBatchPhaseTwoForcedQuantityThreshold()) {
      return true;
    }

    const eligibleOffers = this.countEligibleOffersForQuantity(
      phaseOneRankedOffers,
      part.requestedQuantity,
    );
    return eligibleOffers < this.getBatchPhaseOneMinimumEligibleOffers();
  }

  private shouldSkipProviderCallDueDeadline(
    requestDeadlineAtMs: number,
    deadlineGuardMs: number,
  ) {
    return Date.now() >= requestDeadlineAtMs - deadlineGuardMs;
  }

  private resolveProviderTimeoutForRemainingBudget(
    requestDeadlineAtMs: number,
    deadlineGuardMs: number,
  ) {
    const remaining = requestDeadlineAtMs - Date.now() - deadlineGuardMs;
    if (remaining <= 0) return 0;
    return Math.min(this.getProviderRequestTimeoutMs(), Math.max(1000, remaining));
  }

  private incrementProviderDeadlineSkip(
    diagnostics: BatchOffersDiagnosticsAccumulator | null,
    providerId: OfferSourceId,
  ) {
    const stats = this.getOrCreateProviderDiagnostics(diagnostics, providerId);
    if (!stats) return;
    stats.deadlineSkips += 1;
  }

  private async collectOffersForBatchPhase(
    parts: NormalizedBatchOfferRequestItem[],
    providers: OfferSourceId[],
    offersByPartAndProvider: Map<string, Map<OfferSourceId, any[]>>,
    diagnostics: BatchOffersDiagnosticsAccumulator | null,
    requestDeadlineAtMs: number,
    deadlineGuardMs: number,
    options?: {
      forceProviderFetchPartKeys?: Set<string>;
      minSellerRatingPercentOverride?: number | null;
    },
  ) {
    if (parts.length === 0 || providers.length === 0) return;
    const forceProviderFetchPartKeys =
      options?.forceProviderFetchPartKeys || new Set<string>();
    const minSellerRatingPercentOverride =
      options?.minSellerRatingPercentOverride ?? null;

    const providerConcurrency = this.getBatchProviderConcurrency(
      providers.length,
    );
    const partConcurrency = this.getBatchPartConcurrency(
      parts.length,
    );

    await this.runWithConcurrency(
      providers,
      providerConcurrency,
      async (providerId) => {
        await this.runWithConcurrency(parts, partConcurrency, async (part) => {
          if (
            this.shouldSkipProviderCallDueDeadline(
              requestDeadlineAtMs,
              deadlineGuardMs,
            )
          ) {
            this.incrementProviderDeadlineSkip(diagnostics, providerId);
            this.setPartProviderOffers(
              offersByPartAndProvider,
              part.key,
              providerId,
              [],
            );
            return;
          }

          const timeoutMs = this.resolveProviderTimeoutForRemainingBudget(
            requestDeadlineAtMs,
            deadlineGuardMs,
          );

          if (timeoutMs <= 0) {
            this.incrementProviderDeadlineSkip(diagnostics, providerId);
            this.setPartProviderOffers(
              offersByPartAndProvider,
              part.key,
              providerId,
              [],
            );
            return;
          }

          const providerOffers = await this.fetchOffersFromProviderCached(
            providerId,
            part,
            diagnostics,
            timeoutMs,
            requestDeadlineAtMs,
            deadlineGuardMs,
            {
              forceProviderFetch: forceProviderFetchPartKeys.has(String(part.key)),
            },
          );
          const providerOffersFilteredBySellerRating =
            this.applySellerRatingFilterForProvider(
              providerId,
              providerOffers,
              minSellerRatingPercentOverride,
            );

          const normalizedOffers = providerOffersFilteredBySellerRating.map((offer: any) => ({
            ...offer,
            provider: offer?.provider || providerId,
          }));

          this.setPartProviderOffers(
            offersByPartAndProvider,
            part.key,
            providerId,
            normalizedOffers,
          );
        });
      },
    );
  }

  private async fetchOffersFromProvider(
    providerId: OfferSourceId,
    item: BatchOfferRequestItem,
  ) {
    return this.offerProviders.findOffers(providerId, {
      ids: this.buildProviderSearchIds(item),
      colorName: item.selectedColorName || undefined,
      designId: item.designId,
      partName: item.partName,
    });
  }

  private isOptimizableOffer(offer: any): boolean {
    return !Boolean(offer?.isEstimated);
  }

  /**
   * SYNCHRONIZACJA (Lazy Mode)
   * Pobiera klocki i OD RAZU kolory dla tych konkretnych wyników.
   */
  async syncAndSearch(
    search: string,
    page: number,
    limit = 20,
    categoryIds?: number[],
    colorIds?: number[]
  ) {
    this.logger.log(`Syncing search: "${search}"`);
    
    const apiData = await this.rebrickable.searchParts({ search, page, limit });
    const partsToSave = apiData.results.filter((p) => !!p.imageUrl);

    for (const part of partsToSave) {
      const savedPart = await this.prisma.part.upsert({
        where: { designId: part.designId },
        update: {
          name: part.name,
          imageUrl: part.imageUrl,
          partCatId: part.partCatId ?? null,
          partIds: part.partIds || {},
        },
        create: {
          designId: part.designId,
          name: part.name,
          imageUrl: part.imageUrl,
          partCatId: part.partCatId ?? null,
          partIds: part.partIds || {},
        },
      });

      const hasColors = await this.prisma.partColor.count({ where: { partId: savedPart.id } });
      if (hasColors === 0) {
        await this.syncColorsForPart(savedPart.id, part.designId);
        await sleep(1500); 
      }
    }

    return this.findAll(page, limit, search, categoryIds, colorIds);
  }

  /**
   * UZUPEŁNIANIE BRAKUJĄCYCH KOLORÓW
   * Przechodzi przez bazę i dociąga kolory dla klocków, które ich nie mają.
   */
  async syncMissingColors() {
    if (this.isSyncing) return { message: 'Inna synchronizacja już trwa' };
    this.isSyncing = true;
    
    this.runMissingColorsProcess().catch(err => {
      this.logger.error('Błąd podczas uzupełniania kolorów', err);
      this.isSyncing = false;
    });

    return { message: 'Rozpoczęto uzupełnianie brakujących kolorów dla klocków w bazie.' };
  }

  private async runMissingColorsProcess() {
    this.logger.log('🚀 Start: Sprawdzanie klocków bez przypisanych kolorów...');
    
    const partsWithoutColors = await this.prisma.part.findMany({
      where: {
        colors: { none: {} }
      },
      select: { id: true, designId: true }
    });

    this.logger.log(`Znaleziono ${partsWithoutColors.length} klocków do uzupełnienia.`);

    for (const [index, part] of partsWithoutColors.entries()) {
      if (!this.isSyncing) break;

      try {
        await this.syncColorsForPart(part.id, part.designId);
        
        if ((index + 1) % 10 === 0 || index === 0) {
          this.logger.log(`[COLOR-SYNC] Postęp: ${index + 1}/${partsWithoutColors.length} (Design: ${part.designId})`);
        }

        await sleep(700 + Math.random() * 400); // Odstęp od 800 do 1200 ms
      } catch (error) {
        this.logger.error(`Błąd dla klocka ${part.designId}: ${error.message}`);
        await sleep(5000); 
      }
    }

    this.isSyncing = false;
    this.logger.log('✅ Zakończono proces uzupełniania kolorów.');
  }

  private async syncColorsForPart(dbPartId: number, designId: string) {
    try {
      const colorData = await this.rebrickable.getPartColors(designId);
      const rawColorIds: number[] = Array.from(
        new Set<number>(
          (colorData.results || [])
            .map((c: any) => Number(c?.color_id))
            .filter(
              (colorId: number): colorId is number =>
                Number.isFinite(colorId),
            ),
        ),
      );

      if (rawColorIds.length > 0) {
        const existingColors = await this.prisma.color.findMany({
          where: {
            id: {
              in: rawColorIds,
            },
          },
          select: {
            id: true,
          },
        });
        const existingColorIdSet = new Set(existingColors.map((entry) => entry.id));
        const colorIds = rawColorIds.filter((colorId) => existingColorIdSet.has(colorId));

        if (colorIds.length === 0) {
          return;
        }

        await this.prisma.$transaction(
          colorIds.map((colorId) =>
            this.prisma.partColor.upsert({
              where: { partId_colorId: { partId: dbPartId, colorId: colorId } },
              create: { partId: dbPartId, colorId: colorId },
              update: {},
            })
          )
        );
      }
    } catch (e) {
      this.logger.warn(`Nie udało się pobrać kolorów dla ${designId}: ${e.message}`);
    }
  }

  async getBatchOffers(
    partsToFetch: BatchOfferRequestItem[],
    requestedProviders?: string[],
    options?: {
      refreshMissingOnly?: boolean;
      refreshMissingPartKeys?: string[];
      minSellerRatingPercent?: number | null;
    },
  ) {
    const availableSources = this.getOfferSources();
    const activeProviders = this.resolveActiveProviderIds(requestedProviders);
    const providersRequested = Array.isArray(requestedProviders)
      ? Array.from(
          new Set(
            requestedProviders
              .map((entry) => String(entry || '').trim().toLowerCase())
              .filter((entry) => entry.length > 0),
          ),
        )
      : [];
    const displayOffersLimit = this.getBatchDisplayOffersLimit();
    const optimizationOffersLimit = Math.max(
      displayOffersLimit,
      this.getBatchOptimizationOffersLimit(),
    );
    const normalizedParts: NormalizedBatchOfferRequestItem[] = partsToFetch.map(
      (item) => ({
        ...item,
        requestedQuantity: this.sanitizeQuantity(item.quantity),
      }),
    );
    const forceProviderFetchPartKeys = new Set<string>(
      Boolean(options?.refreshMissingOnly)
        ? (Array.isArray(options?.refreshMissingPartKeys)
            ? options?.refreshMissingPartKeys
            : []
          )
            .map((entry) => String(entry || '').trim())
            .filter((entry) => entry.length > 0)
        : [],
    );
    const minSellerRatingPercentOverride = Number.isFinite(
      Number(options?.minSellerRatingPercent),
    )
      ? Number(options?.minSellerRatingPercent)
      : null;
    if (this.offerIndex.isEnabled()) {
      void this.offerIndex
        .warmupDemand(
          activeProviders,
          normalizedParts.map((item) => ({
            designId: item.designId,
            partIds: item.partIds,
            partName: item.partName,
            colorName: item.selectedColorName || null,
          })),
        )
        .catch(() => undefined);
    }

    const batchTimeoutMs = this.getBatchRequestTimeoutMs();
    const deadlineGuardMs = this.getBatchDeadlineGuardMs();
    const requestDeadlineAtMs = Date.now() + batchTimeoutMs;
    const phases = this.splitProvidersForBatchPhases(
      activeProviders,
      normalizedParts.length,
    );
    const phaseOneProviders = phases.phaseOneProviders;
    const phaseTwoProviders = phases.phaseTwoProviders;

    const partConcurrency = this.getBatchPartConcurrency(normalizedParts.length);
    const providerConcurrency = this.getBatchProviderConcurrency(activeProviders.length);
    const diagnostics = this.isDiagnosticsEnabled()
      ? this.createBatchOffersDiagnosticsAccumulator(
          normalizedParts.length,
          providersRequested,
          activeProviders,
          partConcurrency,
          providerConcurrency,
          batchTimeoutMs,
          deadlineGuardMs,
          phases.phasedEnabled,
          phaseOneProviders,
          phaseTwoProviders,
        )
      : null;
    if (diagnostics) {
      diagnostics.fetchOffersStartedAtMs = Date.now();
    }

    const offersByPartAndProvider = new Map<string, Map<OfferSourceId, any[]>>();
    normalizedParts.forEach((item) => {
      offersByPartAndProvider.set(String(item.key), new Map());
    });

    await this.collectOffersForBatchPhase(
      normalizedParts,
      phaseOneProviders,
      offersByPartAndProvider,
      diagnostics,
      requestDeadlineAtMs,
      deadlineGuardMs,
      {
        forceProviderFetchPartKeys,
        minSellerRatingPercentOverride,
      },
    );

    if (phaseTwoProviders.length > 0) {
      if (
        this.shouldSkipProviderCallDueDeadline(
          requestDeadlineAtMs,
          deadlineGuardMs,
        )
      ) {
        if (diagnostics) {
          diagnostics.phaseTwoSkippedDueDeadline = true;
        }
      } else {
        const phaseTwoParts = normalizedParts.filter((part) => {
          const byProvider =
            offersByPartAndProvider.get(String(part.key)) ||
            new Map<OfferSourceId, any[]>();
          const phaseOneOffersByProvider = new Map<OfferSourceId, any[]>();
          phaseOneProviders.forEach((providerId) => {
            phaseOneOffersByProvider.set(providerId, byProvider.get(providerId) || []);
          });

          const phaseOneRankedOffers = this.mergeAndRankOffersForPart(
            phaseOneOffersByProvider,
            part.requestedQuantity,
            optimizationOffersLimit,
          );
          return this.shouldExpandPartToPhaseTwo(part, phaseOneRankedOffers);
        });

        if (diagnostics) {
          diagnostics.phaseTwoPartsCount = phaseTwoParts.length;
        }

        if (phaseTwoParts.length > 0) {
          await this.collectOffersForBatchPhase(
            phaseTwoParts,
            phaseTwoProviders,
            offersByPartAndProvider,
            diagnostics,
            requestDeadlineAtMs,
            deadlineGuardMs,
            {
              forceProviderFetchPartKeys,
              minSellerRatingPercentOverride,
            },
          );
        }
      }
    }

    const results = normalizedParts.map((item) => {
      const byProvider =
        offersByPartAndProvider.get(String(item.key)) ||
        new Map<OfferSourceId, any[]>();
      const rankedOffers = this.mergeAndRankOffersForPart(
        byProvider,
        item.requestedQuantity,
        optimizationOffersLimit,
      );

      return {
        key: item.key,
        id: item.id,
        designId: item.designId,
        partName: item.partName,
        selectedColorId: item.selectedColorId,
        selectedColorName: item.selectedColorName,
        selectedColorRgb: item.selectedColorRgb,
        quantity: item.requestedQuantity,
        offers: this.buildDisplayOffersWithProviderCoverage(
          rankedOffers,
          activeProviders,
          displayOffersLimit,
          2,
        ),
        optimizationOffers: rankedOffers,
      };
    });
    if (diagnostics) {
      diagnostics.fetchOffersFinishedAtMs = Date.now();
      diagnostics.optimizationStartedAtMs = Date.now();
    }

    const optimizationInput = results.map((result) => ({
      ...result,
      offers: Array.isArray((result as any).optimizationOffers)
        ? (result as any).optimizationOffers
        : result.offers,
    }));

    const responseResults = results.map((result) => {
      const { optimizationOffers: _optimizationOffers, ...rest } = result as any;
      return rest;
    });

    const optimization = this.buildCartOptimizationSummary(optimizationInput);
    if (diagnostics) {
      diagnostics.optimizationFinishedAtMs = Date.now();
    }

    const finalizedDiagnostics = this.finalizeBatchOffersDiagnostics(diagnostics) as any;
    if (finalizedDiagnostics) {
      try {
        finalizedDiagnostics.offerIndex = await this.offerIndex.getQueueStats();
      } catch {
        finalizedDiagnostics.offerIndex = {
          enabled: false,
          workerEnabled: false,
          activeWorkers: 0,
        };
      }
    }

    return {
      results: responseResults,
      optimization,
      selectedProviders: activeProviders,
      availableSources,
      diagnostics: finalizedDiagnostics,
    };
  }

  async getOfferIndexStats() {
    return this.offerIndex.getQueueStats();
  }

  private parseAmount(value: unknown): number {
    const parsed = Number.parseFloat(String(value ?? '0'));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private parseOptionalInteger(
    value: unknown,
    min = 1,
    max = 1_000_000,
  ): number | null {
    return parsePositiveInteger(value, min, max);
  }

  private resolveOfferUnitQuantity(offer: any): number {
    const parsed = this.parseOptionalInteger(offer?.offerUnitQuantity, 1, 5000);
    return parsed || 1;
  }

  private resolveAvailableOfferUnits(offer: any): number | null {
    return this.parseOptionalInteger(offer?.availableOfferUnits, 1, 1_000_000);
  }

  private resolveAvailablePieceQuantity(
    offer: any,
    offerUnitQuantity: number,
  ): number | null {
    const direct = this.parseOptionalInteger(offer?.availablePieceQuantity, 1, 1_000_000_000);
    if (direct !== null) return direct;

    const fromBenchmark = this.parseOptionalInteger(
      offer?.benchmark?.totalQuantity,
      1,
      1_000_000_000,
    );
    if (fromBenchmark !== null) return fromBenchmark;

    const availableOfferUnits = this.resolveAvailableOfferUnits(offer);
    if (availableOfferUnits !== null) {
      return availableOfferUnits * offerUnitQuantity;
    }

    return null;
  }

  private buildOfferCostPlan(offer: any, requestedQuantity: number) {
    const normalizedRequestedQuantity = Math.max(1, this.sanitizeQuantity(requestedQuantity));
    const listingUnitPrice = this.parseAmount(offer?.price);
    const offerUnitQuantity = this.resolveOfferUnitQuantity(offer);
    const offerUnitsToBuy = Math.max(
      1,
      Math.ceil(normalizedRequestedQuantity / offerUnitQuantity),
    );
    const offeredPieceQuantity = offerUnitsToBuy * offerUnitQuantity;
    const lineTotal = listingUnitPrice * offerUnitsToBuy;
    const effectiveUnitPrice =
      normalizedRequestedQuantity > 0
        ? lineTotal / normalizedRequestedQuantity
        : lineTotal;
    const effectivePiecePrice =
      offeredPieceQuantity > 0 ? lineTotal / offeredPieceQuantity : lineTotal;
    const availableOfferUnits = this.resolveAvailableOfferUnits(offer);
    const availablePieceQuantity = this.resolveAvailablePieceQuantity(
      offer,
      offerUnitQuantity,
    );
    const knownPieces = availablePieceQuantity !== null;
    const knownUnits = availableOfferUnits !== null;
    const hasSufficientAvailability = knownPieces
      ? availablePieceQuantity >= normalizedRequestedQuantity
      : knownUnits
        ? availableOfferUnits >= offerUnitsToBuy
        : true;
    const missingPieces = hasSufficientAvailability
      ? 0
      : knownPieces
        ? Math.max(0, normalizedRequestedQuantity - availablePieceQuantity)
        : knownUnits
          ? Math.max(
              0,
              normalizedRequestedQuantity - availableOfferUnits * offerUnitQuantity,
            )
          : 0;
    const overPurchasedPieces = Math.max(
      0,
      offeredPieceQuantity - normalizedRequestedQuantity,
    );
    const oversupplyPenalty = this.computeOversupplyPenalty(
      overPurchasedPieces,
      effectivePiecePrice,
      normalizedRequestedQuantity,
    );
    const customerLineScore = lineTotal + oversupplyPenalty;

    return {
      normalizedRequestedQuantity,
      listingUnitPrice,
      offerUnitQuantity,
      offerUnitsToBuy,
      offeredPieceQuantity,
      overPurchasedPieces,
      lineTotal,
      effectiveUnitPrice,
      effectivePiecePrice,
      oversupplyPenalty,
      customerLineScore,
      availableOfferUnits,
      availablePieceQuantity,
      hasSufficientAvailability,
      missingPieces,
    };
  }

  private isOfferEligibleForRequestedQuantity(
    offer: any,
    requestedQuantity: number,
  ): boolean {
    if (!this.isOptimizableOffer(offer)) {
      return false;
    }

    const costPlan = this.buildOfferCostPlan(offer, requestedQuantity);
    return costPlan.listingUnitPrice > 0 && costPlan.hasSufficientAvailability;
  }

  private isBetterOfferForBasket(
    currentOffer: any,
    candidateOffer: any,
    requestedQuantity = 1,
  ): boolean {
    if (!currentOffer) return true;

    const candidateMissingShipping = this.hasMissingShippingPrice(candidateOffer);
    const currentMissingShipping = this.hasMissingShippingPrice(currentOffer);
    if (candidateMissingShipping !== currentMissingShipping) {
      return !candidateMissingShipping;
    }

    const candidateCost = this.buildOfferCostPlan(candidateOffer, requestedQuantity);
    const currentCost = this.buildOfferCostPlan(currentOffer, requestedQuantity);
    if (candidateCost.hasSufficientAvailability !== currentCost.hasSufficientAvailability) {
      return candidateCost.hasSufficientAvailability;
    }

    const candidatePrecision = Number(candidateOffer?.precisionRank || 0);
    const currentPrecision = Number(currentOffer?.precisionRank || 0);
    if (candidatePrecision !== currentPrecision) {
      return candidatePrecision > currentPrecision;
    }

    const candidateColorScore = Number(candidateOffer?.colorMatchScore || 0);
    const currentColorScore = Number(currentOffer?.colorMatchScore || 0);
    if (candidateColorScore !== currentColorScore) {
      return candidateColorScore > currentColorScore;
    }

    if (candidateCost.effectiveUnitPrice !== currentCost.effectiveUnitPrice) {
      return candidateCost.effectiveUnitPrice < currentCost.effectiveUnitPrice;
    }

    return candidateCost.lineTotal < currentCost.lineTotal;
  }

  private buildOfferPriceSummary(
    mode: 'single_seller' | 'mixed_sellers',
    partOrder: string[],
    partNames: Map<string, string>,
    requestedColorByPart: Map<string, string | null>,
    requestedQuantityByPart: Map<string, number>,
    selectionByPart: Map<string, any>,
    currency: string,
    sellerId: string | null,
    sellerLogin: string | null,
    sellersCount: number
  ): OfferPriceSummary {
    const usedOfferUnitsByOffer = new Map<string, number>();
    const selections = partOrder
      .filter((partKey) => selectionByPart.has(partKey))
      .map((partKey) => {
        const offer = selectionByPart.get(partKey);
        const requestedQuantity = Math.max(
          1,
          requestedQuantityByPart.get(partKey) || 1,
        );
        const costPlan = this.buildOfferCostPlan(offer, requestedQuantity);
        if (!costPlan.hasSufficientAvailability || costPlan.listingUnitPrice <= 0) {
          return null;
        }

        const offerIdentity = this.getOfferIdentity(offer);
        const alreadyUsedOfferUnits = usedOfferUnitsByOffer.get(offerIdentity) || 0;
        if (
          costPlan.availableOfferUnits !== null &&
          alreadyUsedOfferUnits + costPlan.offerUnitsToBuy > costPlan.availableOfferUnits
        ) {
          return null;
        }
        usedOfferUnitsByOffer.set(
          offerIdentity,
          alreadyUsedOfferUnits + costPlan.offerUnitsToBuy,
        );

        return {
          partKey,
          partName: partNames.get(partKey) || partKey,
          requestedColorName:
            requestedColorByPart.get(partKey) ||
            offer.requestedColorName ||
            null,
          requestedQuantity,
          offerColor: offer.color ? String(offer.color) : null,
          offerId: String(offer.id),
          offerName: String(offer.name || ''),
          offerUrl: String(offer.url || ''),
          provider: offer.provider ? String(offer.provider) : null,
          offerUnitQuantity: costPlan.offerUnitQuantity,
          offerUnitsToBuy: costPlan.offerUnitsToBuy,
          offeredPieceQuantity: costPlan.offeredPieceQuantity,
          overPurchasedPieces: costPlan.overPurchasedPieces,
          unitOfferPrice: costPlan.effectiveUnitPrice,
          offerPrice: costPlan.lineTotal,
          finalLineScore: costPlan.customerLineScore,
          offerCurrency: String(offer.currency || currency),
          estimatedDeliveryPrice: this.getOfferDeliveryForOptimization(offer),
          shippingMissingPrice: this.hasMissingShippingPrice(offer),
          availableOfferUnits: costPlan.availableOfferUnits,
          availablePieceQuantity: costPlan.availablePieceQuantity,
          insufficientAvailability: !costPlan.hasSufficientAvailability,
          missingPieces: costPlan.missingPieces,
          sellerId: offer.sellerId ? String(offer.sellerId) : null,
          sellerLogin: offer.sellerLogin ? String(offer.sellerLogin) : null,
          sellerCountryCode: offer.sellerCountryCode
            ? String(offer.sellerCountryCode)
            : null,
          sellerCountryFlagUrl: offer.sellerCountryFlagUrl
            ? String(offer.sellerCountryFlagUrl)
            : null,
          sellerIsSuperSeller: Boolean(offer.sellerIsSuperSeller),
          sellerIsTopRated: Boolean(offer.sellerIsTopRated),
          sellerFeedbackPercent: Number.isFinite(Number(offer.sellerFeedbackPercent))
            ? Number(offer.sellerFeedbackPercent)
            : null,
          sellerFeedbackScore: Number.isFinite(Number(offer.sellerFeedbackScore))
            ? Number(offer.sellerFeedbackScore)
            : null,
          sellerReviewsCount: Number.isFinite(Number(offer.sellerReviewsCount))
            ? Number(offer.sellerReviewsCount)
            : null,
        };
      })
      .filter((selection): selection is NonNullable<typeof selection> => Boolean(selection));
    const selectedPartKeys = new Set(selections.map((selection) => selection.partKey));
    const missingPartKeys = partOrder.filter((partKey) => !selectedPartKeys.has(partKey));

    const itemsTotal = selections.reduce((sum, selection) => sum + selection.offerPrice, 0);
    const oversupplyPenaltyTotal = selections.reduce(
      (sum, selection) => sum + Math.max(0, selection.finalLineScore - selection.offerPrice),
      0,
    );
    const cheapestShippingBySeller = new Map<string, number>();
    selections.forEach((selection) => {
      const shipping = selection.estimatedDeliveryPrice || 0;
      this.upsertShippingBySeller(cheapestShippingBySeller, selection, shipping);
    });
    const estimatedShippingTotal = Array.from(cheapestShippingBySeller.values()).reduce(
      (sum, shipping) => sum + shipping,
      0,
    );
    const resolvedSellersCount = Math.max(
      sellersCount,
      cheapestShippingBySeller.size,
    );
    const customerObjectiveTotal =
      itemsTotal + estimatedShippingTotal + oversupplyPenaltyTotal;

    return {
      mode,
      sellerId,
      sellerLogin,
      sellersCount: resolvedSellersCount,
      coveredParts: selections.length,
      missingPartKeys,
      missingPartNames: missingPartKeys.map((partKey) => partNames.get(partKey) || partKey),
      itemsTotal,
      estimatedShippingTotal,
      oversupplyPenaltyTotal,
      customerObjectiveTotal,
      estimatedGrandTotal: itemsTotal + estimatedShippingTotal,
      currency,
      selections,
    };
  }

  private createInitialMixedRankingState(): MixedRankingState {
    return {
      selections: new Map<string, any>(),
      itemsTotal: 0,
      oversupplyPenaltyTotal: 0,
      shippingBySeller: new Map<string, number>(),
      offerUnitsByIdentity: new Map<string, number>(),
      estimatedTotal: 0,
      customerObjectiveTotal: 0,
      sellersCount: 0,
    };
  }

  private getMixedRankingStateSignature(
    state: MixedRankingState,
    partOrder: string[],
  ): string {
    return partOrder
      .filter((partKey) => state.selections.has(partKey))
      .map((partKey) => {
        const offer = state.selections.get(partKey);
        return `${String(offer?.provider || 'unknown')}:${String(offer?.id || '')}`;
      })
      .join('|');
  }

  private sortAndDedupeMixedRankingStates(
    states: MixedRankingState[],
    partOrder: string[],
    keepLimit: number,
  ): MixedRankingState[] {
    const sorted = [...states].sort((a, b) => {
      if (a.customerObjectiveTotal !== b.customerObjectiveTotal) {
        return a.customerObjectiveTotal - b.customerObjectiveTotal;
      }
      if (a.estimatedTotal !== b.estimatedTotal) {
        return a.estimatedTotal - b.estimatedTotal;
      }
      if (a.sellersCount !== b.sellersCount) {
        return a.sellersCount - b.sellersCount;
      }
      return a.itemsTotal - b.itemsTotal;
    });

    const deduped: MixedRankingState[] = [];
    const seen = new Set<string>();
    for (const state of sorted) {
      const signature = this.getMixedRankingStateSignature(state, partOrder);
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      deduped.push(state);
      if (deduped.length >= keepLimit) {
        break;
      }
    }

    return deduped;
  }

  private buildNextMixedRankingState(
    state: MixedRankingState,
    partKey: string,
    offer: any,
    requestedQuantityByPart: Map<string, number>,
  ): MixedRankingState | null {
    const requestedQuantity = Math.max(
      1,
      requestedQuantityByPart.get(partKey) || 1,
    );
    const costPlan = this.buildOfferCostPlan(offer, requestedQuantity);
    if (!costPlan.hasSufficientAvailability || costPlan.lineTotal <= 0) {
      return null;
    }

    const nextOfferUnitsByIdentity = new Map(state.offerUnitsByIdentity);
    const offerIdentity = this.getOfferIdentity(offer);
    const alreadyUsedOfferUnits = nextOfferUnitsByIdentity.get(offerIdentity) || 0;
    if (
      costPlan.availableOfferUnits !== null &&
      alreadyUsedOfferUnits + costPlan.offerUnitsToBuy > costPlan.availableOfferUnits
    ) {
      return null;
    }
    nextOfferUnitsByIdentity.set(
      offerIdentity,
      alreadyUsedOfferUnits + costPlan.offerUnitsToBuy,
    );

    const nextSelections = new Map(state.selections);
    nextSelections.set(partKey, offer);

    const nextShippingBySeller = new Map(state.shippingBySeller);
    const shipping = this.getOfferDeliveryForOptimization(offer);
    this.upsertShippingBySeller(nextShippingBySeller, offer, shipping);

    const nextItemsTotal = state.itemsTotal + costPlan.lineTotal;
    const nextOversupplyPenaltyTotal =
      state.oversupplyPenaltyTotal + costPlan.oversupplyPenalty;
    const nextShippingTotal = Array.from(nextShippingBySeller.values()).reduce(
      (sum, value) => sum + value,
      0,
    );
    const sellersCount = nextShippingBySeller.size;
    const customerObjectiveTotal =
      nextItemsTotal + nextShippingTotal + nextOversupplyPenaltyTotal;

    return {
      selections: nextSelections,
      itemsTotal: nextItemsTotal,
      oversupplyPenaltyTotal: nextOversupplyPenaltyTotal,
      shippingBySeller: nextShippingBySeller,
      offerUnitsByIdentity: nextOfferUnitsByIdentity,
      estimatedTotal: nextItemsTotal + nextShippingTotal,
      customerObjectiveTotal,
      sellersCount,
    };
  }

  private buildMixedRankingStatesBeam(
    partOrder: string[],
    offersByPart: Map<string, any[]>,
    requestedQuantityByPart: Map<string, number>,
  ): MixedRankingState[] {
    const beamWidth = this.getMixedBeamWidth();
    let beam: MixedRankingState[] = [this.createInitialMixedRankingState()];

    for (const partKey of partOrder) {
      const partCandidates = offersByPart.get(partKey) || [];
      const expanded: MixedRankingState[] = [];

      for (const state of beam) {
        for (const offer of partCandidates) {
          const nextState = this.buildNextMixedRankingState(
            state,
            partKey,
            offer,
            requestedQuantityByPart,
          );
          if (!nextState) continue;
          expanded.push(nextState);
        }
      }

      if (expanded.length === 0) {
        return [];
      }

      beam = this.sortAndDedupeMixedRankingStates(expanded, partOrder, beamWidth);
      if (beam.length === 0) {
        return [];
      }
    }

    return beam;
  }

  private buildMixedRankingStatesExact(
    partOrder: string[],
    offersByPart: Map<string, any[]>,
    requestedQuantityByPart: Map<string, number>,
  ): MixedRankingState[] {
    const maxCombinations = this.getMixedExactCombinationLimit();
    const candidatesByPart = partOrder.map((partKey) => offersByPart.get(partKey) || []);
    const combinationsEstimate = candidatesByPart.reduce((acc, candidates) => {
      if (acc > maxCombinations) return acc;
      return acc * Math.max(1, candidates.length);
    }, 1);

    if (combinationsEstimate > maxCombinations) {
      return [];
    }

    const completedStates: MixedRankingState[] = [];
    const baseState = this.createInitialMixedRankingState();

    const walk = (index: number, currentState: MixedRankingState) => {
      if (index >= partOrder.length) {
        completedStates.push(currentState);
        return;
      }

      const partKey = partOrder[index];
      const partCandidates = candidatesByPart[index] || [];
      for (const offer of partCandidates) {
        const nextState = this.buildNextMixedRankingState(
          currentState,
          partKey,
          offer,
          requestedQuantityByPart,
        );
        if (!nextState) continue;
        walk(index + 1, nextState);
      }
    };

    walk(0, baseState);
    return completedStates;
  }

  private buildMixedRankingSummaries(
    results: any[],
    partOrder: string[],
    partNames: Map<string, string>,
    requestedColorByPart: Map<string, string | null>,
    requestedQuantityByPart: Map<string, number>,
    currency: string
  ): OfferPriceSummary[] {
    const offersByPart = new Map<string, any[]>();
    const candidatesPerPart = this.getMixedCandidatesPerPartLimit();
    const rankingLimit = this.getMixedRankingLimit();

    for (const result of results) {
      const partKey = String(result.key);
      const requestedQuantity = Math.max(
        1,
        requestedQuantityByPart.get(partKey) || 1,
      );
      const offers = Array.isArray(result.offers) ? result.offers : [];
      const normalizedOffers = this.buildOptimizationCandidates(
        offers,
        requestedQuantity,
        candidatesPerPart,
      );

      if (normalizedOffers.length === 0) {
        return [];
      }

      offersByPart.set(partKey, normalizedOffers);
    }

    const exactStates = this.buildMixedRankingStatesExact(
      partOrder,
      offersByPart,
      requestedQuantityByPart,
    );
    const mixedStates =
      exactStates.length > 0
        ? this.sortAndDedupeMixedRankingStates(
            exactStates,
            partOrder,
            Math.max(rankingLimit * 8, this.getMixedBeamWidth()),
          )
        : this.buildMixedRankingStatesBeam(
            partOrder,
            offersByPart,
            requestedQuantityByPart,
          );

    const summaries = mixedStates
      .map((state) =>
        this.buildOfferPriceSummary(
          'mixed_sellers',
          partOrder,
          partNames,
          requestedColorByPart,
          requestedQuantityByPart,
          state.selections,
          currency,
          null,
          null,
          state.sellersCount,
        ),
      )
      .filter((summary) => summary.missingPartKeys.length === 0)
      .sort((a, b) => {
        if (a.customerObjectiveTotal !== b.customerObjectiveTotal) {
          return a.customerObjectiveTotal - b.customerObjectiveTotal;
        }
        if (a.estimatedGrandTotal !== b.estimatedGrandTotal) {
          return a.estimatedGrandTotal - b.estimatedGrandTotal;
        }
        if (a.sellersCount !== b.sellersCount) {
          return a.sellersCount - b.sellersCount;
        }
        return a.itemsTotal - b.itemsTotal;
      });

    const uniqueSummaries: OfferPriceSummary[] = [];
    const seen = new Set<string>();
    for (const summary of summaries) {
      const signature = summary.selections
        .map(
          (selection) =>
            `${selection.provider || 'unknown'}:${selection.offerId}`,
        )
        .join('|');
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      uniqueSummaries.push(summary);
      if (uniqueSummaries.length >= rankingLimit) {
        break;
      }
    }

    return uniqueSummaries;
  }

  private sortAndDedupeOfferSummaries(
    summaries: OfferPriceSummary[],
    limit: number,
  ): OfferPriceSummary[] {
    const sorted = [...summaries].sort((a, b) => {
      if (a.customerObjectiveTotal !== b.customerObjectiveTotal) {
        return a.customerObjectiveTotal - b.customerObjectiveTotal;
      }
      if (a.estimatedGrandTotal !== b.estimatedGrandTotal) {
        return a.estimatedGrandTotal - b.estimatedGrandTotal;
      }
      if (a.sellersCount !== b.sellersCount) {
        return a.sellersCount - b.sellersCount;
      }
      return a.itemsTotal - b.itemsTotal;
    });

    const deduped: OfferPriceSummary[] = [];
    const seen = new Set<string>();
    for (const summary of sorted) {
      const signature = summary.selections
        .map((selection) => `${selection.provider || 'unknown'}:${selection.offerId}`)
        .join('|');
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      deduped.push(summary);
      if (deduped.length >= limit) {
        break;
      }
    }
    return deduped;
  }

  private buildCartOptimizationSummary(results: any[]): CartOptimizationSummary {
    const partOrder = results.map((result) => String(result.key));
    const partNames = new Map<string, string>(
      results.map((result) => [String(result.key), String(result.partName || result.designId || result.id)])
    );
    const requestedColorByPart = new Map<string, string | null>(
      results.map((result) => [
        String(result.key),
        result.selectedColorName ? String(result.selectedColorName) : null,
      ])
    );
    const requestedQuantityByPart = new Map<string, number>(
      results.map((result) => [
        String(result.key),
        this.sanitizeQuantity(result.quantity),
      ]),
    );

    const sellerBuckets = new Map<string, { sellerId: string; sellerLogin: string | null; byPart: Map<string, any> }>();
    const cheapestOfferByPart = new Map<string, any>();

    let partsWithAnyOffers = 0;
    let currency = 'PLN';

    results.forEach((result) => {
      const partKey = String(result.key);
      const requestedQuantity = Math.max(
        1,
        requestedQuantityByPart.get(partKey) || 1,
      );
      const offers = Array.isArray(result.offers) ? result.offers : [];
      if (
        offers.some((offer: any) =>
          this.isOfferEligibleForRequestedQuantity(offer, requestedQuantity),
        )
      ) {
        partsWithAnyOffers += 1;
      }

      offers.forEach((offer: any) => {
        if (!this.isOfferEligibleForRequestedQuantity(offer, requestedQuantity)) {
          return;
        }

        const offerCurrency = String(offer.currency || currency);
        currency = offerCurrency || currency;

        const providerKey = offer.provider ? String(offer.provider) : 'unknown';
        const sellerIdRaw = String(offer.sellerId || '').trim();
        const sellerLogin = offer.sellerLogin ? String(offer.sellerLogin) : null;
        const sellerId = sellerIdRaw
          ? `${providerKey}:${sellerIdRaw}`
          : sellerLogin
            ? `${providerKey}:login:${sellerLogin.toLowerCase()}`
            : null;

        const currentBestForPart = cheapestOfferByPart.get(partKey);
        if (
          this.isBetterOfferForOptimization(
            currentBestForPart,
            offer,
            requestedQuantity,
          )
        ) {
          cheapestOfferByPart.set(partKey, offer);
        }

        if (!sellerId) return;

        const sellerBucket = sellerBuckets.get(sellerId) || {
          sellerId,
          sellerLogin,
          byPart: new Map<string, any>(),
        };

        const existingSellerPartOffer = sellerBucket.byPart.get(partKey);
        if (
          this.isBetterOfferForOptimization(
            existingSellerPartOffer,
            offer,
            requestedQuantity,
          )
        ) {
          sellerBucket.byPart.set(partKey, offer);
        }

        sellerBuckets.set(sellerId, sellerBucket);
      });
    });

    const baselineMixedSummary =
      cheapestOfferByPart.size > 0
        ? this.buildOfferPriceSummary(
          'mixed_sellers',
          partOrder,
          partNames,
          requestedColorByPart,
          requestedQuantityByPart,
          cheapestOfferByPart,
          currency,
          null,
          null,
          (() => {
            const baselineShippingBySeller = new Map<string, number>();
            Array.from(cheapestOfferByPart.values()).forEach((offer) => {
              this.upsertShippingBySeller(
                baselineShippingBySeller,
                offer,
                this.getOfferDeliveryForOptimization(offer),
              );
            });
            return baselineShippingBySeller.size;
          })()
          )
        : null;

    const mixedRanking = this.buildMixedRankingSummaries(
      results,
      partOrder,
      partNames,
      requestedColorByPart,
      requestedQuantityByPart,
      currency
    );

    const singleSellerVariants: OfferPriceSummary[] = Array.from(sellerBuckets.values()).map((sellerBucket) =>
      this.buildOfferPriceSummary(
        'single_seller',
        partOrder,
        partNames,
        requestedColorByPart,
        requestedQuantityByPart,
        sellerBucket.byPart,
        currency,
        sellerBucket.sellerId,
        sellerBucket.sellerLogin,
        1
      )
    );

    singleSellerVariants.sort((a, b) => {
      if (b.coveredParts !== a.coveredParts) {
        return b.coveredParts - a.coveredParts;
      }
      if (a.customerObjectiveTotal !== b.customerObjectiveTotal) {
        return a.customerObjectiveTotal - b.customerObjectiveTotal;
      }
      if (a.estimatedGrandTotal !== b.estimatedGrandTotal) {
        return a.estimatedGrandTotal - b.estimatedGrandTotal;
      }
      return a.itemsTotal - b.itemsTotal;
    });

    const completeSingleSellerVariants = singleSellerVariants
      .filter((variant) => variant.missingPartKeys.length === 0)
      .sort((a, b) => {
        if (a.customerObjectiveTotal !== b.customerObjectiveTotal) {
          return a.customerObjectiveTotal - b.customerObjectiveTotal;
        }
        if (a.estimatedGrandTotal !== b.estimatedGrandTotal) {
          return a.estimatedGrandTotal - b.estimatedGrandTotal;
        }
        return a.itemsTotal - b.itemsTotal;
      });

    const rankingLimit = this.getMixedRankingLimit();
    const mergedMixedCandidates: OfferPriceSummary[] = [
      ...mixedRanking,
      ...completeSingleSellerVariants.slice(0, 5),
    ];
    if (baselineMixedSummary) {
      mergedMixedCandidates.push(baselineMixedSummary);
    }

    const normalizedMixedRanking = this.sortAndDedupeOfferSummaries(
      mergedMixedCandidates,
      rankingLimit,
    );
    const cheapestMixed = normalizedMixedRanking[0] || null;

    return {
      partsCount: partOrder.length,
      partsWithAnyOffers,
      currency,
      cheapestMixed,
      mixedRanking: normalizedMixedRanking,
      bestSingleSeller: completeSingleSellerVariants[0] || null,
      bestPartialSingleSeller: singleSellerVariants[0] || null,
      topSingleSellerAlternatives: completeSingleSellerVariants.slice(0, 5),
    };
  }
  
  async syncFullDatabase() {
    if (this.isSyncing) return { message: 'Synchronizacja w toku' };
    this.isSyncing = true;
    this.runFullSyncProcess().catch(err => {
      this.logger.error(err);
      this.isSyncing = false;
    });
    return { message: 'Turbo Sync started (check logs)' };
  }

  private async runFullSyncProcess() {
    let currentPage = 1;
    let hasNextPage = true;
    let totalSynced = 0;

    this.logger.log('🚀 Rozpoczynam TURBO SYNC (Szkielety klocków)...');

    while (hasNextPage && this.isSyncing) {
      try {
        const apiData = await this.rebrickable.searchParts({ page: currentPage, limit: 100 });
        const parts = apiData.results;

        if (parts.length > 0) {
          await this.prisma.$transaction(
            parts.map(part => this.prisma.part.upsert({
              where: { designId: part.designId },
              update: {
                name: part.name,
                imageUrl: part.imageUrl,
                partCatId: part.partCatId ?? null,
                partIds: part.partIds || {},
              },
              create: {
                designId: part.designId,
                name: part.name,
                imageUrl: part.imageUrl,
                partCatId: part.partCatId ?? null,
                partIds: part.partIds || {},
              },
            }))
          );
        }

        totalSynced += parts.length;
        this.logger.log(`[SYNC] Strona ${currentPage} gotowa. Łącznie: ${totalSynced}`);

        hasNextPage = !!apiData.next;
        currentPage++;
        
        await sleep(2000); 
      } catch (error) { 
        this.logger.error(`Błąd na stronie ${currentPage}: ${error.message}`);
        await sleep(5000);
      }
    }
    this.isSyncing = false;
    this.logger.log('✅ Synchronizacja klocków zakończona.');
  }

  async clearAllParts() {
    const deleted = await this.prisma.part.deleteMany({});
    return { message: 'Baza wyczyszczona', count: deleted.count };
  }
}
