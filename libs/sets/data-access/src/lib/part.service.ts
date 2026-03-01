import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, finalize, of, shareReplay, tap, timeout } from 'rxjs';
import {
  BatchOfferPartRequest,
  BatchOffersResponse,
  OfferSourcesResponse,
  PaginatedResponse,
  Part,
  PartCategory,
  PartFilterColor,
} from './part';

function resolveApiBaseUrl(): string {
  const runtimeValue = (globalThis as any)?.__BRICKOMAT_CONFIG__?.apiBaseUrl;
  const normalized = String(runtimeValue || '').trim();
  if (!normalized) return '';
  return normalized.replace(/\/+$/, '');
}

@Injectable({ providedIn: 'root' })
export class PartService {
  private readonly http = inject(HttpClient);
  private readonly apiBaseUrl = resolveApiBaseUrl();
  private readonly apiUrl = `${this.apiBaseUrl}/api/parts`;
  private readonly offerSourcesTimeoutMs = 12000;
  private readonly batchOffersTimeoutMs = 45000;
  private readonly batchOffersCacheTtlMs = 90_000;
  private readonly batchOffersCacheMaxEntries = 24;
  private readonly batchOffersCache = new Map<
    string,
    { response: BatchOffersResponse; expiresAt: number }
  >();
  private readonly batchOffersInFlight = new Map<
    string,
    Observable<BatchOffersResponse>
  >();

  // Pobiera to co już mamy w bazie
  getAll(
    page: number,
    limit: number,
    categoryIds: number[] = [],
    colorIds: number[] = []
  ): Observable<PaginatedResponse<Part>> {
    const params: Record<string, string> = {
      page: page.toString(),
      limit: limit.toString(),
    };

    if (categoryIds.length > 0) {
      params['categoryIds'] = categoryIds.join(',');
    }

    if (colorIds.length > 0) {
      params['colorIds'] = colorIds.join(',');
    }

    return this.http.get<PaginatedResponse<Part>>(this.apiUrl, {
      params,
    });
  }

  // Szuka w Rebrickable i zapisuje do bazy
  searchRemote(
    query: string,
    page: number,
    limit: number,
    categoryIds: number[] = [],
    colorIds: number[] = []
  ): Observable<PaginatedResponse<Part>> {
    const params: Record<string, string> = {
      search: query,
      page: page.toString(),
      limit: limit.toString(),
    };

    if (categoryIds.length > 0) {
      params['categoryIds'] = categoryIds.join(',');
    }

    if (colorIds.length > 0) {
      params['colorIds'] = colorIds.join(',');
    }

    return this.http.get<PaginatedResponse<Part>>(`${this.apiUrl}`, {
      params,
    });
  }

  getCategories(): Observable<PartCategory[]> {
    return this.http.get<PartCategory[]>(`${this.apiUrl}/categories`);
  }

  getColors(): Observable<PartFilterColor[]> {
    return this.http.get<PartFilterColor[]>(`${this.apiUrl}/colors`);
  }

  // NOWA METODA: Pobiera oferty dla wielu klocków naraz
  getBatchOffers(
    parts: BatchOfferPartRequest[],
    providers: string[] = [],
    options?: {
      forceRefresh?: boolean;
      refreshMissingOnly?: boolean;
      refreshMissingPartKeys?: string[];
      minSellerRatingPercent?: number | null;
    },
  ): Observable<BatchOffersResponse> {
    const requestKey = this.buildBatchOffersRequestKey(parts, providers, options);
    const forceRefresh = Boolean(options?.forceRefresh);
    const refreshMissingOnly = Boolean(options?.refreshMissingOnly);
    const refreshMissingPartKeys = this.normalizeMissingPartKeysForKey(
      options?.refreshMissingPartKeys || [],
    );
    const minSellerRatingPercent = Number.isFinite(
      Number(options?.minSellerRatingPercent),
    )
      ? Number(options?.minSellerRatingPercent)
      : null;

    if (!forceRefresh) {
      const cached = this.batchOffersCache.get(requestKey);
      if (cached && cached.expiresAt > Date.now()) {
        return of(cached.response);
      }

      const inFlight = this.batchOffersInFlight.get(requestKey);
      if (inFlight) {
        return inFlight;
      }
    }

    const request$ = this.http
      .post<BatchOffersResponse>(`${this.apiUrl}/batch-offers`, {
        parts,
        providers,
        refreshMissingOnly,
        refreshMissingPartKeys,
        minSellerRatingPercent,
      })
      .pipe(
        timeout({ first: this.batchOffersTimeoutMs }),
        tap((response) => {
          this.batchOffersCache.set(requestKey, {
            response,
            expiresAt: Date.now() + this.batchOffersCacheTtlMs,
          });
          this.pruneBatchOffersCache();
        }),
        finalize(() => {
          this.batchOffersInFlight.delete(requestKey);
        }),
        shareReplay(1),
      );

    this.batchOffersInFlight.set(requestKey, request$);
    return request$;
  }

  getOfferSources(): Observable<OfferSourcesResponse> {
    return this.http
      .get<OfferSourcesResponse>(`${this.apiUrl}/offer-sources`)
      .pipe(timeout({ first: this.offerSourcesTimeoutMs }));
  }

  private normalizeProvidersForKey(providers: string[]): string[] {
    return Array.from(
      new Set(
        (Array.isArray(providers) ? providers : [])
          .map((entry) => String(entry || '').trim().toLowerCase())
          .filter((entry) => entry.length > 0),
      ),
    ).sort();
  }

  private sanitizeQuantityForKey(value?: number | null): number {
    const parsed = Number.parseInt(String(value ?? '1'), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 1;
    return Math.min(parsed, 999);
  }

  private normalizePartIdsForKey(partIds: string[]): string[] {
    return Array.from(
      new Set(
        (Array.isArray(partIds) ? partIds : [])
          .map((entry) => String(entry || '').trim().toLowerCase())
          .filter((entry) => entry.length > 0),
      ),
    )
      .sort()
      .slice(0, 24);
  }

  private buildBatchOffersRequestKey(
    parts: BatchOfferPartRequest[],
    providers: string[],
    options?: {
      refreshMissingOnly?: boolean;
      refreshMissingPartKeys?: string[];
      minSellerRatingPercent?: number | null;
    },
  ): string {
    const providerSignature = this.normalizeProvidersForKey(providers).join(',');
    const partsSignature = (Array.isArray(parts) ? parts : [])
      .map((part) => {
        const safePartIds = this.normalizePartIdsForKey(part.partIds || []);
        return [
          String(part.key || '').trim(),
          String(part.designId || '').trim().toLowerCase(),
          String(part.partName || '').trim().toLowerCase(),
          String(part.selectedColorId ?? 'null'),
          String(part.selectedColorName || '').trim().toLowerCase(),
          this.sanitizeQuantityForKey(part.quantity),
          safePartIds.join('|'),
        ].join('~');
      })
      .sort()
      .join(';');
    const refreshMissingOnly = Boolean(options?.refreshMissingOnly);
    const refreshMissingPartSignature = this.normalizeMissingPartKeysForKey(
      options?.refreshMissingPartKeys || [],
    ).join('|');
    const minSellerRatingPercent = Number.isFinite(
      Number(options?.minSellerRatingPercent),
    )
      ? Number(options?.minSellerRatingPercent)
      : 0;
    return `${providerSignature}::${partsSignature}::${refreshMissingOnly ? 'missing' : 'all'}::${refreshMissingPartSignature}::rating:${minSellerRatingPercent}`;
  }

  private normalizeMissingPartKeysForKey(partKeys: string[]): string[] {
    return Array.from(
      new Set(
        (Array.isArray(partKeys) ? partKeys : [])
          .map((entry) => String(entry || '').trim())
          .filter((entry) => entry.length > 0),
      ),
    ).sort();
  }

  private pruneBatchOffersCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.batchOffersCache.entries()) {
      if (!entry || entry.expiresAt <= now) {
        this.batchOffersCache.delete(key);
      }
    }

    if (this.batchOffersCache.size <= this.batchOffersCacheMaxEntries) {
      return;
    }
    const overflow = this.batchOffersCache.size - this.batchOffersCacheMaxEntries;
    const keysToDrop = Array.from(this.batchOffersCache.keys()).slice(0, overflow);
    keysToDrop.forEach((key) => this.batchOffersCache.delete(key));
  }
}
