import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { OfferSourceId } from './offer-sources.types';
import { AllegroService } from './allegro.service';
import { EbayService } from './ebay.service';
import { ErliService } from './erli.service';
import { BrickowlService } from './brickowl.service';

interface OfferIndexLookupInput {
  designId?: string;
  partIds?: string[];
  partName?: string;
  colorName?: string | null;
}

interface OfferIndexLookupKey {
  providerId: OfferSourceId;
  designId: string;
  colorKey: string;
  requestPayload: {
    designId: string;
    partIds: string[];
    partName?: string;
    colorName?: string | null;
  };
}

export interface OfferIndexReadResult {
  state: 'fresh' | 'stale' | 'miss';
  offers: any[];
}

interface OfferIndexEntryRow {
  payload: unknown;
  fresh_until: Date | string;
  stale_until: Date | string;
}

interface OfferRefreshJobRow {
  id: number;
  provider: string;
  design_id: string;
  color_key: string;
  request_payload: unknown;
  attempts: number;
  max_attempts: number;
}

@Injectable()
export class OfferIndexService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OfferIndexService.name);

  private initialized = false;
  private disabled = false;
  private workerTimer: NodeJS.Timeout | null = null;
  private workerPumpRunning = false;
  private activeWorkers = 0;
  private readonly workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly allegro: AllegroService,
    private readonly ebay: EbayService,
    private readonly erli: ErliService,
    private readonly brickowl: BrickowlService,
  ) {}

  async onModuleInit() {
    if (!this.isEnabled()) {
      this.disabled = true;
      return;
    }

    try {
      await this.ensureTables();
      await this.recoverStaleRunningJobs();
      this.initialized = true;
      if (this.isWorkerEnabled()) {
        this.startWorkerLoop();
      }
    } catch (error) {
      this.disabled = true;
      this.logger.error(
        `Offer index initialization failed: ${String((error as any)?.message || error)}`,
      );
    }
  }

  async onModuleDestroy() {
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }
  }

  isEnabled() {
    return this.parseBooleanConfig('OFFERS_INDEX_ENABLED', false);
  }

  isSyncFallbackEnabled() {
    const raw = String(this.config.get<string>('OFFERS_INDEX_SYNC_FALLBACK_ENABLED') || '')
      .trim()
      .toLowerCase();
    if (raw) {
      return !['0', 'false', 'off', 'no'].includes(raw);
    }
    return true;
  }

  private isWorkerEnabled() {
    return this.parseBooleanConfig('OFFERS_INDEX_WORKER_ENABLED', true);
  }

  private parseBooleanConfig(envKey: string, fallback: boolean) {
    const raw = String(this.config.get<string>(envKey) || '')
      .trim()
      .toLowerCase();
    if (!raw) return fallback;
    return !['0', 'false', 'off', 'no'].includes(raw);
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

  private getWorkerPollMs() {
    return this.parseIntegerConfig(
      'OFFERS_INDEX_WORKER_POLL_MS',
      700,
      200,
      10_000,
    );
  }

  private getWorkerConcurrency() {
    return this.parseIntegerConfig(
      'OFFERS_INDEX_WORKER_CONCURRENCY',
      2,
      1,
      16,
    );
  }

  private getWorkerLockTimeoutMs() {
    return this.parseIntegerConfig(
      'OFFERS_INDEX_WORKER_LOCK_TIMEOUT_MS',
      300_000,
      10_000,
      86_400_000,
    );
  }

  private getDefaultFreshTtlMs(providerId: OfferSourceId) {
    if (providerId === 'allegro') return 6 * 60 * 60 * 1000;
    if (providerId === 'erli') return 10 * 60 * 60 * 1000;
    if (providerId === 'ebay') return 18 * 60 * 60 * 1000;
    if (providerId === 'brickowl') return 36 * 60 * 60 * 1000;
    return 12 * 60 * 60 * 1000;
  }

  private getDefaultStaleTtlMs(providerId: OfferSourceId) {
    if (providerId === 'allegro') return 24 * 60 * 60 * 1000;
    if (providerId === 'erli') return 30 * 60 * 60 * 1000;
    if (providerId === 'ebay') return 48 * 60 * 60 * 1000;
    if (providerId === 'brickowl') return 96 * 60 * 60 * 1000;
    return 36 * 60 * 60 * 1000;
  }

  private getDefaultEmptyFreshTtlMs(providerId: OfferSourceId) {
    if (providerId === 'allegro') return 30 * 60 * 1000;
    if (providerId === 'erli') return 45 * 60 * 1000;
    if (providerId === 'ebay') return 90 * 60 * 1000;
    if (providerId === 'brickowl') return 4 * 60 * 60 * 1000;
    return 60 * 60 * 1000;
  }

  private getDefaultEmptyStaleTtlMs(providerId: OfferSourceId) {
    if (providerId === 'allegro') return 4 * 60 * 60 * 1000;
    if (providerId === 'erli') return 6 * 60 * 60 * 1000;
    if (providerId === 'ebay') return 12 * 60 * 60 * 1000;
    if (providerId === 'brickowl') return 24 * 60 * 60 * 1000;
    return 8 * 60 * 60 * 1000;
  }

  private getNearStaleThresholdMs() {
    return this.parseIntegerConfig(
      'OFFERS_INDEX_NEAR_STALE_THRESHOLD_MS',
      20 * 60 * 1000,
      30_000,
      12 * 60 * 60 * 1000,
    );
  }

  private getJobMaxAttempts() {
    return this.parseIntegerConfig(
      'OFFERS_INDEX_JOB_MAX_ATTEMPTS',
      6,
      1,
      30,
    );
  }

  private getRetryBaseMs() {
    return this.parseIntegerConfig(
      'OFFERS_INDEX_RETRY_BASE_MS',
      15_000,
      1000,
      60 * 60 * 1000,
    );
  }

  private getRetryMaxMs() {
    return this.parseIntegerConfig(
      'OFFERS_INDEX_RETRY_MAX_MS',
      2 * 60 * 60 * 1000,
      10_000,
      24 * 60 * 60 * 1000,
    );
  }

  private getJobTimeoutMs(providerId: OfferSourceId) {
    return this.parseProviderIntegerConfig(
      'OFFERS_INDEX_JOB_TIMEOUT_MS',
      providerId,
      30_000,
      2_000,
      300_000,
    );
  }

  private getFreshTtlMs(providerId: OfferSourceId, isEmpty: boolean) {
    if (isEmpty) {
      return this.parseProviderIntegerConfig(
        'OFFERS_INDEX_EMPTY_FRESH_TTL_MS',
        providerId,
        this.getDefaultEmptyFreshTtlMs(providerId),
        60_000,
        14 * 24 * 60 * 60 * 1000,
      );
    }

    return this.parseProviderIntegerConfig(
      'OFFERS_INDEX_FRESH_TTL_MS',
      providerId,
      this.getDefaultFreshTtlMs(providerId),
      60_000,
      14 * 24 * 60 * 60 * 1000,
    );
  }

  private getStaleTtlMs(providerId: OfferSourceId, isEmpty: boolean) {
    if (isEmpty) {
      return this.parseProviderIntegerConfig(
        'OFFERS_INDEX_EMPTY_STALE_TTL_MS',
        providerId,
        this.getDefaultEmptyStaleTtlMs(providerId),
        60_000,
        30 * 24 * 60 * 60 * 1000,
      );
    }

    return this.parseProviderIntegerConfig(
      'OFFERS_INDEX_STALE_TTL_MS',
      providerId,
      this.getDefaultStaleTtlMs(providerId),
      60_000,
      30 * 24 * 60 * 60 * 1000,
    );
  }

  private getJobPriority(state: 'fresh' | 'stale' | 'miss') {
    if (state === 'miss') return 220;
    if (state === 'stale') return 170;
    return 90;
  }

  private normalizeText(value?: string | null) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private toArray(value: unknown) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  }

  private applyJitter(ms: number, ratio: number) {
    const safeMs = Math.max(1, Math.floor(ms));
    const amplitude = Math.floor(safeMs * Math.max(0, ratio));
    if (amplitude <= 0) return safeMs;
    const delta = Math.floor(Math.random() * (amplitude * 2 + 1)) - amplitude;
    return Math.max(1, safeMs + delta);
  }

  private buildLookupKey(
    providerId: OfferSourceId,
    input: OfferIndexLookupInput,
  ): OfferIndexLookupKey | null {
    const designCandidate =
      this.normalizeText(input.designId) ||
      this.normalizeText(Array.isArray(input.partIds) ? input.partIds[0] : '') ||
      '';

    if (!designCandidate) {
      return null;
    }

    const colorKey = this.normalizeText(input.colorName || '') || '__no_color__';
    const partIds = Array.from(
      new Set(
        (Array.isArray(input.partIds) ? input.partIds : [])
          .map((entry) => String(entry || '').trim())
          .filter((entry) => entry.length > 0),
      ),
    ).slice(0, 16);

    const requestPayload = {
      designId: String(input.designId || '').trim() || designCandidate,
      partIds,
      partName: String(input.partName || '').trim() || undefined,
      colorName: input.colorName || null,
    };

    return {
      providerId,
      designId: designCandidate,
      colorKey,
      requestPayload,
    };
  }

  private async ensureTables() {
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS offer_index_entry (
        provider TEXT NOT NULL,
        design_id TEXT NOT NULL,
        color_key TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '[]'::jsonb,
        fresh_until TIMESTAMPTZ NOT NULL,
        stale_until TIMESTAMPTZ NOT NULL,
        refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        fail_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (provider, design_id, color_key)
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS offer_index_entry_fresh_until_idx
      ON offer_index_entry (fresh_until)
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS offer_index_entry_stale_until_idx
      ON offer_index_entry (stale_until)
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS offer_refresh_job (
        id BIGSERIAL PRIMARY KEY,
        provider TEXT NOT NULL,
        design_id TEXT NOT NULL,
        color_key TEXT NOT NULL,
        request_payload JSONB NOT NULL,
        priority INTEGER NOT NULL DEFAULT 100,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 6,
        run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
        locked_at TIMESTAMPTZ,
        locked_by TEXT,
        last_error TEXT,
        last_duration_ms INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(provider, design_id, color_key)
      )
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS offer_refresh_job_status_run_after_idx
      ON offer_refresh_job (status, run_after, priority)
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS offer_refresh_job_locked_at_idx
      ON offer_refresh_job (locked_at)
    `);
  }

  private async recoverStaleRunningJobs() {
    const lockTimeoutSeconds = Math.max(
      1,
      Math.floor(this.getWorkerLockTimeoutMs() / 1000),
    );
    await this.prisma.$executeRawUnsafe(
      `
      UPDATE offer_refresh_job
      SET
        status = 'retry',
        run_after = now(),
        locked_at = NULL,
        locked_by = NULL,
        updated_at = now()
      WHERE status = 'running'
        AND (locked_at IS NULL OR locked_at < now() - ($1 * interval '1 second'))
      `,
      lockTimeoutSeconds,
    );
  }

  private isOperational() {
    return this.isEnabled() && this.initialized && !this.disabled;
  }

  private startWorkerLoop() {
    if (this.workerTimer) return;

    const pollMs = this.getWorkerPollMs();
    this.workerTimer = setInterval(() => {
      void this.pumpWorkerQueue();
    }, pollMs);

    void this.pumpWorkerQueue();
    this.logger.log(
      `Offer index worker started (poll=${pollMs}ms, concurrency=${this.getWorkerConcurrency()})`,
    );
  }

  private schedulePumpSoon() {
    setTimeout(() => {
      void this.pumpWorkerQueue();
    }, 20);
  }

  private async pumpWorkerQueue() {
    if (!this.isOperational() || !this.isWorkerEnabled()) return;
    if (this.workerPumpRunning) return;

    this.workerPumpRunning = true;
    try {
      const maxConcurrency = this.getWorkerConcurrency();
      while (this.activeWorkers < maxConcurrency) {
        const job = await this.claimNextJob();
        if (!job) break;

        this.activeWorkers += 1;
        void this.processJob(job)
          .catch((error) => {
            this.logger.warn(
              `Offer index worker job failed: ${String((error as any)?.message || error)}`,
            );
          })
          .finally(() => {
            this.activeWorkers = Math.max(0, this.activeWorkers - 1);
            this.schedulePumpSoon();
          });
      }
    } finally {
      this.workerPumpRunning = false;
    }
  }

  private async claimNextJob(): Promise<OfferRefreshJobRow | null> {
    const lockTimeoutSeconds = Math.max(
      1,
      Math.floor(this.getWorkerLockTimeoutMs() / 1000),
    );

    const rows = await this.prisma.$queryRawUnsafe<OfferRefreshJobRow[]>(
      `
      WITH candidate AS (
        SELECT id
        FROM offer_refresh_job
        WHERE status IN ('queued', 'retry')
          AND run_after <= now()
          AND (locked_at IS NULL OR locked_at < now() - ($2 * interval '1 second'))
        ORDER BY priority DESC, run_after ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE offer_refresh_job job
      SET
        status = 'running',
        locked_at = now(),
        locked_by = $1,
        updated_at = now()
      FROM candidate
      WHERE job.id = candidate.id
      RETURNING job.*
      `,
      this.workerId,
      lockTimeoutSeconds,
    );

    return rows[0] || null;
  }

  private parseJobPayload(payload: unknown) {
    if (!payload) return null;
    if (typeof payload === 'string') {
      try {
        return JSON.parse(payload);
      } catch {
        return null;
      }
    }

    if (typeof payload === 'object') {
      return payload as any;
    }

    return null;
  }

  private async fetchOffersFromProvider(
    providerId: OfferSourceId,
    input: OfferIndexLookupInput,
  ) {
    const ids = Array.from(
      new Set(
        [
          ...(Array.isArray(input.partIds) ? input.partIds : []),
          String(input.designId || '').trim(),
        ]
          .map((entry) => String(entry || '').trim())
          .filter((entry) => entry.length > 0),
      ),
    ).slice(0, 16);

    const colorName = input.colorName || undefined;
    const designId = String(input.designId || '').trim() || undefined;
    const partName = String(input.partName || '').trim() || undefined;

    if (ids.length === 0 && !designId) {
      return [];
    }

    switch (providerId) {
      case 'allegro':
        return this.allegro.findOffersByExternalIds(ids, colorName, designId, partName);
      case 'ebay':
        return this.ebay.findOffersByExternalIds(ids, colorName, designId, partName);
      case 'erli':
        return this.erli.findOffersByExternalIds(ids, colorName, designId, partName);
      case 'brickowl':
        return this.brickowl.findOffersByExternalIds(ids, colorName, designId, partName);
      default:
        return [];
    }
  }

  private async runWithTimeout<T>(
    task: Promise<T>,
    timeoutMs: number,
    context: string,
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Offer index job timeout (${context}/${timeoutMs}ms)`));
      }, timeoutMs);

      task
        .then((value) => resolve(value))
        .catch((error) => reject(error))
        .finally(() => clearTimeout(timer));
    });
  }

  private async completeJobSuccess(
    job: OfferRefreshJobRow,
    providerId: OfferSourceId,
    offersCount: number,
    durationMs: number,
  ) {
    const isEmpty = offersCount <= 0;
    const freshTtlMs = this.getFreshTtlMs(providerId, isEmpty);
    const nextRunMs = this.applyJitter(Math.floor(freshTtlMs * 0.85), 0.15);

    await this.prisma.$executeRawUnsafe(
      `
      UPDATE offer_refresh_job
      SET
        status = 'queued',
        attempts = 0,
        run_after = now() + ($2 * interval '1 millisecond'),
        locked_at = NULL,
        locked_by = NULL,
        last_error = NULL,
        last_duration_ms = $3,
        updated_at = now()
      WHERE id = $1
      `,
      job.id,
      nextRunMs,
      Math.max(0, Math.floor(durationMs)),
    );
  }

  private async completeJobFailure(
    job: OfferRefreshJobRow,
    providerId: OfferSourceId,
    error: unknown,
  ) {
    const attempts = Math.max(0, Number(job.attempts || 0)) + 1;
    const maxAttempts = Math.max(1, Number(job.max_attempts || this.getJobMaxAttempts()));
    const baseBackoff = this.getRetryBaseMs();
    const maxBackoff = this.getRetryMaxMs();

    const retryMs = this.applyJitter(
      Math.min(maxBackoff, baseBackoff * 2 ** Math.max(0, attempts - 1)),
      0.2,
    );

    const parkedMs = this.applyJitter(
      Math.max(retryMs, Math.floor(this.getFreshTtlMs(providerId, true) * 1.2)),
      0.2,
    );

    const errorMessage = String((error as any)?.message || error || '').slice(0, 1200);

    if (attempts >= maxAttempts) {
      await this.prisma.$executeRawUnsafe(
        `
        UPDATE offer_refresh_job
        SET
          status = 'queued',
          attempts = 0,
          run_after = now() + ($2 * interval '1 millisecond'),
          locked_at = NULL,
          locked_by = NULL,
          last_error = $3,
          updated_at = now()
        WHERE id = $1
        `,
        job.id,
        parkedMs,
        errorMessage,
      );
      return;
    }

    await this.prisma.$executeRawUnsafe(
      `
      UPDATE offer_refresh_job
      SET
        status = 'retry',
        attempts = $2,
        run_after = now() + ($3 * interval '1 millisecond'),
        locked_at = NULL,
        locked_by = NULL,
        last_error = $4,
        updated_at = now()
      WHERE id = $1
      `,
      job.id,
      attempts,
      retryMs,
      errorMessage,
    );
  }

  private async processJob(job: OfferRefreshJobRow) {
    const providerId = String(job.provider || '').trim().toLowerCase() as OfferSourceId;
    if (!['allegro', 'ebay', 'erli', 'brickowl'].includes(providerId)) {
      await this.prisma.$executeRawUnsafe(
        `DELETE FROM offer_refresh_job WHERE id = $1`,
        job.id,
      );
      return;
    }

    const payload = this.parseJobPayload(job.request_payload);
    if (!payload || typeof payload !== 'object') {
      await this.prisma.$executeRawUnsafe(
        `DELETE FROM offer_refresh_job WHERE id = $1`,
        job.id,
      );
      return;
    }

    const input: OfferIndexLookupInput = {
      designId: String((payload as any)?.designId || '').trim(),
      partIds: Array.isArray((payload as any)?.partIds)
        ? (payload as any).partIds.map((entry: unknown) => String(entry || '').trim())
        : [],
      partName: String((payload as any)?.partName || '').trim() || undefined,
      colorName:
        (payload as any)?.colorName === null || (payload as any)?.colorName === undefined
          ? null
          : String((payload as any).colorName),
    };

    try {
      const startedAt = Date.now();
      const offersRaw = await this.runWithTimeout(
        this.fetchOffersFromProvider(providerId, input),
        this.getJobTimeoutMs(providerId),
        providerId,
      );
      const offers = Array.isArray(offersRaw) ? offersRaw : [];
      const durationMs = Date.now() - startedAt;

      await this.saveOffersSnapshot(providerId, input, offers);
      await this.completeJobSuccess(job, providerId, offers.length, durationMs);
    } catch (error) {
      await this.noteRefreshFailure(providerId, input, error);
      await this.completeJobFailure(job, providerId, error);
    }
  }

  private async enqueueRefresh(
    key: OfferIndexLookupKey,
    state: 'fresh' | 'stale' | 'miss',
  ) {
    if (!this.isOperational()) return;

    const maxAttempts = this.getJobMaxAttempts();
    const priority = this.getJobPriority(state);

    await this.prisma.$executeRawUnsafe(
      `
      INSERT INTO offer_refresh_job (
        provider,
        design_id,
        color_key,
        request_payload,
        priority,
        status,
        attempts,
        max_attempts,
        run_after,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4::jsonb,
        $5,
        'queued',
        0,
        $6,
        now(),
        now()
      )
      ON CONFLICT (provider, design_id, color_key)
      DO UPDATE SET
        request_payload = CASE
          WHEN EXCLUDED.priority >= offer_refresh_job.priority
            THEN EXCLUDED.request_payload
          ELSE offer_refresh_job.request_payload
        END,
        priority = GREATEST(offer_refresh_job.priority, EXCLUDED.priority),
        status = CASE
          WHEN offer_refresh_job.status = 'running'
            THEN offer_refresh_job.status
          ELSE 'queued'
        END,
        run_after = CASE
          WHEN offer_refresh_job.status = 'running'
            THEN offer_refresh_job.run_after
          ELSE LEAST(offer_refresh_job.run_after, now())
        END,
        max_attempts = GREATEST(offer_refresh_job.max_attempts, EXCLUDED.max_attempts),
        updated_at = now()
      `,
      key.providerId,
      key.designId,
      key.colorKey,
      JSON.stringify(key.requestPayload),
      priority,
      maxAttempts,
    );

    this.schedulePumpSoon();
  }

  async readOffers(
    providerId: OfferSourceId,
    input: OfferIndexLookupInput,
  ): Promise<OfferIndexReadResult> {
    if (!this.isOperational()) {
      return { state: 'miss', offers: [] };
    }

    const key = this.buildLookupKey(providerId, input);
    if (!key) {
      return { state: 'miss', offers: [] };
    }

    const rows = await this.prisma.$queryRawUnsafe<OfferIndexEntryRow[]>(
      `
      SELECT payload, fresh_until, stale_until
      FROM offer_index_entry
      WHERE provider = $1
        AND design_id = $2
        AND color_key = $3
      LIMIT 1
      `,
      key.providerId,
      key.designId,
      key.colorKey,
    );

    const nowMs = Date.now();
    const row = rows[0];

    if (!row) {
      void this.enqueueRefresh(key, 'miss').catch(() => undefined);
      return { state: 'miss', offers: [] };
    }

    const freshUntilMs = row.fresh_until ? new Date(row.fresh_until).getTime() : 0;
    const staleUntilMs = row.stale_until ? new Date(row.stale_until).getTime() : 0;
    const offers = this.toArray(row.payload);

    if (freshUntilMs > nowMs) {
      const nearStale = freshUntilMs - nowMs <= this.getNearStaleThresholdMs();
      if (nearStale) {
        void this.enqueueRefresh(key, 'fresh').catch(() => undefined);
      }
      return {
        state: 'fresh',
        offers,
      };
    }

    if (staleUntilMs > nowMs) {
      void this.enqueueRefresh(key, 'stale').catch(() => undefined);
      return {
        state: 'stale',
        offers,
      };
    }

    void this.enqueueRefresh(key, 'miss').catch(() => undefined);
    return { state: 'miss', offers: [] };
  }

  async saveOffersSnapshot(
    providerId: OfferSourceId,
    input: OfferIndexLookupInput,
    offers: any[],
  ) {
    if (!this.isOperational()) return;

    const key = this.buildLookupKey(providerId, input);
    if (!key) return;

    const normalizedOffers = Array.isArray(offers) ? offers : [];
    const isEmpty = normalizedOffers.length === 0;
    const freshTtlMs = this.applyJitter(this.getFreshTtlMs(providerId, isEmpty), 0.08);
    const staleTtlMs = this.applyJitter(
      Math.max(this.getStaleTtlMs(providerId, isEmpty), freshTtlMs + 60_000),
      0.08,
    );

    await this.prisma.$executeRawUnsafe(
      `
      INSERT INTO offer_index_entry (
        provider,
        design_id,
        color_key,
        payload,
        fresh_until,
        stale_until,
        refreshed_at,
        fail_count,
        last_error,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4::jsonb,
        now() + ($5 * interval '1 millisecond'),
        now() + ($6 * interval '1 millisecond'),
        now(),
        0,
        NULL,
        now()
      )
      ON CONFLICT (provider, design_id, color_key)
      DO UPDATE SET
        payload = EXCLUDED.payload,
        fresh_until = EXCLUDED.fresh_until,
        stale_until = EXCLUDED.stale_until,
        refreshed_at = now(),
        fail_count = 0,
        last_error = NULL,
        updated_at = now()
      `,
      key.providerId,
      key.designId,
      key.colorKey,
      JSON.stringify(normalizedOffers),
      freshTtlMs,
      staleTtlMs,
    );
  }

  async noteRefreshFailure(
    providerId: OfferSourceId,
    input: OfferIndexLookupInput,
    error: unknown,
  ) {
    if (!this.isOperational()) return;

    const key = this.buildLookupKey(providerId, input);
    if (!key) return;

    const errorMessage = String((error as any)?.message || error || '').slice(0, 1200);

    await this.prisma.$executeRawUnsafe(
      `
      UPDATE offer_index_entry
      SET
        fail_count = fail_count + 1,
        last_error = $4,
        updated_at = now()
      WHERE provider = $1
        AND design_id = $2
        AND color_key = $3
      `,
      key.providerId,
      key.designId,
      key.colorKey,
      errorMessage,
    );
  }

  async warmupDemand(
    providers: OfferSourceId[],
    items: OfferIndexLookupInput[],
  ) {
    if (!this.isOperational()) return;

    const uniquePairs = new Map<string, OfferIndexLookupKey>();
    providers.forEach((providerId) => {
      items.forEach((item) => {
        const key = this.buildLookupKey(providerId, item);
        if (!key) return;
        const dedupKey = `${key.providerId}:${key.designId}:${key.colorKey}`;
        if (!uniquePairs.has(dedupKey)) {
          uniquePairs.set(dedupKey, key);
        }
      });
    });

    for (const key of uniquePairs.values()) {
      await this.enqueueRefresh(key, 'fresh');
    }
  }

  async getQueueStats() {
    if (!this.isOperational()) {
      return {
        enabled: false,
        workerEnabled: this.isWorkerEnabled(),
        activeWorkers: 0,
      };
    }

    const [queuedRows, runningRows, retryRows] = await Promise.all([
      this.prisma.$queryRawUnsafe<Array<{ count: string }>>(
        `SELECT COUNT(*)::text AS count FROM offer_refresh_job WHERE status = 'queued'`,
      ),
      this.prisma.$queryRawUnsafe<Array<{ count: string }>>(
        `SELECT COUNT(*)::text AS count FROM offer_refresh_job WHERE status = 'running'`,
      ),
      this.prisma.$queryRawUnsafe<Array<{ count: string }>>(
        `SELECT COUNT(*)::text AS count FROM offer_refresh_job WHERE status = 'retry'`,
      ),
    ]);

    return {
      enabled: true,
      workerEnabled: this.isWorkerEnabled(),
      activeWorkers: this.activeWorkers,
      queued: Number.parseInt(String(queuedRows[0]?.count || '0'), 10) || 0,
      running: Number.parseInt(String(runningRows[0]?.count || '0'), 10) || 0,
      retry: Number.parseInt(String(retryRows[0]?.count || '0'), 10) || 0,
    };
  }
}
