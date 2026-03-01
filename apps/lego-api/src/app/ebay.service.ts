import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { OfferSourceDescriptor } from './offer-sources.types';
import {
  extractPackQuantityFromText,
  parsePositiveInteger,
} from './offer-quantity.utils';
import { ProviderTrafficGuardService } from './provider-traffic-guard.service';

interface EbaySearchQuery {
  phrase: string;
  sourceTier: number;
  containsColor: boolean;
  containsPartName: boolean;
}

interface EbayTokenCache {
  token: string;
  expiresAt: number;
}

interface EbaySearchCacheEntry {
  value: any;
  expiresAt: number;
}

interface EbaySearchRequestOptions {
  phrase: string;
  marketplaceId: string;
  limit?: number;
  categoryId?: string;
  aspectFilter?: string;
  fieldgroups?: string;
}

interface EbayColorAspectFilter {
  categoryId: string;
  aspectFilter: string;
}

@Injectable()
export class EbayService {
  private readonly logger = new Logger(EbayService.name);
  private tokenCache: EbayTokenCache | null = null;
  private readonly searchCache = new Map<string, EbaySearchCacheEntry>();
  private readonly searchInFlight = new Map<string, Promise<any>>();
  private blockedUntilMs = 0;
  private requestChain: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  private readonly COLOR_TOKENS = [
    'black',
    'white',
    'red',
    'blue',
    'green',
    'yellow',
    'orange',
    'brown',
    'tan',
    'pink',
    'purple',
    'gray',
    'grey',
    'dark bluish gray',
    'light bluish gray',
    'dark turquoise',
    'teal',
  ];

  private readonly COLOR_ASPECT_NAME_TOKENS = [
    'color',
    'colour',
    'kolor',
    'manufacturer color',
    'main color',
    'main colour',
  ];

  // eBay Browse API: auto_correct is not supported by all marketplaces (e.g. EBAY_PL).
  // Keep this allow-list aligned with API error 12028 valid marketplaces.
  private readonly AUTO_CORRECT_MARKETPLACES = new Set([
    'EBAY_US',
    'EBAY_AT',
    'EBAY_AU',
    'EBAY_CA',
    'EBAY_CH',
    'EBAY_DE',
    'EBAY_ES',
    'EBAY_FR',
    'EBAY_GB',
    'EBAY_IE',
    'EBAY_IT',
    'EBAY_BE',
  ]);

  private readonly PART_NAME_STOP_WORDS = new Set([
    'lego',
    'part',
    'parts',
    'piece',
    'pieces',
    'with',
    'without',
    'and',
    'x',
  ]);

  private readonly PRIMARY_PART_TYPE_TOKENS = [
    'brick',
    'plate',
    'tile',
    'slope',
    'wedge',
    'panel',
    'technic',
    'minifigure',
  ];

  private readonly SIMPLE_PART_NOISE_TOKENS = [
    'modified',
    'tapered',
    'pattern',
    'print',
    'printed',
    'jumper',
    'bracket',
    'curved',
    'corner',
    'inverted',
    'arch',
    'clip',
    'handle',
    'grille',
    'groove',
  ];

  private readonly STRICT_COLOR_EQUIVALENTS: Record<string, string[]> = {
    black: ['czarny'],
    white: ['bialy', 'biały'],
    red: ['czerwony'],
    blue: ['niebieski'],
    green: ['zielony'],
    yellow: ['zolty', 'żółty'],
    orange: ['pomaranczowy', 'pomarańczowy'],
    brown: ['brazowy', 'brązowy'],
    gray: ['grey', 'szary'],
    grey: ['gray', 'szary'],
    'dark bluish gray': [
      'dark bluish grey',
      'dark stone gray',
      'dark stone grey',
    ],
    'light bluish gray': [
      'light bluish grey',
      'light stone gray',
      'light stone grey',
    ],
    'dark turquoise': ['teal'],
  };

  private readonly MARKETPLACE_COUNTRY_CODES: Record<string, string> = {
    EBAY_PL: 'PL',
    EBAY_US: 'US',
    EBAY_GB: 'GB',
    EBAY_DE: 'DE',
    EBAY_FR: 'FR',
    EBAY_IT: 'IT',
    EBAY_ES: 'ES',
    EBAY_BE: 'BE',
    EBAY_NL: 'NL',
    EBAY_CA: 'CA',
    EBAY_AU: 'AU',
    EBAY_CH: 'CH',
    EBAY_IE: 'IE',
    EBAY_AT: 'AT',
  };

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
    private readonly trafficGuard: ProviderTrafficGuardService,
  ) {}

  private async ensureExternalCallPermit(callType: string, minIntervalMs = 0) {
    const permit = await this.trafficGuard.beforeExternalCall('ebay', callType, {
      minIntervalMs,
    });
    if (permit.allowed) return;

    const reason = permit.reason || 'unknown';
    const waitMs = Math.max(0, Math.floor(permit.waitMs || 0));
    const error = new Error(
      `eBay provider guard blocked (${reason}${waitMs > 0 ? `/${waitMs}ms` : ''})`,
    );
    (error as any).isProviderGuardBlocked = true;
    (error as any).providerGuardReason = reason;
    throw error;
  }

  private normalize(value?: string) {
    return (value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  private escapeRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private hasWholeToken(haystack: string, needle: string) {
    const normalizedHaystack = this.normalize(haystack);
    const normalizedNeedle = this.normalize(needle);
    if (!normalizedHaystack || !normalizedNeedle) return false;

    const pattern = new RegExp(
      `(^|[^a-z0-9])${this.escapeRegex(normalizedNeedle)}([^a-z0-9]|$)`,
      'i',
    );
    return pattern.test(normalizedHaystack);
  }

  private isEnabled() {
    const raw = this.normalize(this.config.get<string>('EBAY_ENABLED') || '');
    return raw !== 'false' && raw !== '0' && raw !== 'off';
  }

  private isConfigured() {
    const clientId = this.config.get<string>('EBAY_CLIENT_ID');
    const clientSecret = this.config.get<string>('EBAY_CLIENT_SECRET');
    return Boolean(clientId && clientSecret);
  }

  private getEnvironment(): 'sandbox' | 'production' {
    const raw = this
      .normalize(this.config.get<string>('EBAY_ENV') || '')
      .replace(/^['"]+|['"]+$/g, '');
    return raw.startsWith('sandbox') ? 'sandbox' : 'production';
  }

  private getIdentityUrl() {
    return this.getEnvironment() === 'sandbox'
      ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
      : 'https://api.ebay.com/identity/v1/oauth2/token';
  }

  private getApiBaseUrl() {
    return this.getEnvironment() === 'sandbox'
      ? 'https://api.sandbox.ebay.com'
      : 'https://api.ebay.com';
  }

  private getMarketplaceId() {
    // Business decision: backend searches only on EBAY_PL to reduce fan-out latency.
    return 'EBAY_PL';
  }

  private isPrimaryMarketplaceOnlyMode() {
    const raw = this.normalize(
      this.config.get<string>('EBAY_PRIMARY_MARKETPLACE_ONLY') || 'true',
    );
    return raw !== 'false' && raw !== '0' && raw !== 'off';
  }

  private parseMarketplaceList(raw?: string | null): string[] {
    if (!raw) return [];
    return String(raw)
      .split(',')
      .map((entry) => entry.trim().toUpperCase())
      .filter((entry) => entry.startsWith('EBAY_'));
  }

  private getSearchMarketplaces(): string[] {
    const primary = this.getMarketplaceId();
    if (this.isPrimaryMarketplaceOnlyMode()) {
      return [primary];
    }
    const configuredFallbacks = this.parseMarketplaceList(
      this.config.get<string>('EBAY_FALLBACK_MARKETPLACES'),
    );
    const defaultSandboxFallback =
      this.getEnvironment() === 'sandbox' && primary !== 'EBAY_US'
        ? ['EBAY_US']
        : [];

    const markets = Array.from(
      new Set([
        primary,
        ...configuredFallbacks,
        ...defaultSandboxFallback,
      ]),
    );
    const maxMarkets = this.parseIntegerConfig(
      'EBAY_MAX_SEARCH_MARKETPLACES',
      2,
      1,
      6,
    );
    return markets.slice(0, maxMarkets);
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

  private supportsAutoCorrect(marketplaceId: string): boolean {
    const normalized = String(marketplaceId || '').trim().toUpperCase();
    return this.AUTO_CORRECT_MARKETPLACES.has(normalized);
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

  private getRequestMinIntervalMs() {
    const base = this.parseIntegerConfig(
      'EBAY_REQUEST_MIN_INTERVAL_MS',
      250,
      0,
      10_000,
    );
    return this.applyThrottleReduction(base);
  }

  private getCooldownMs() {
    return this.parseIntegerConfig(
      'EBAY_COOLDOWN_MS',
      30_000,
      5_000,
      3_600_000,
    );
  }

  private getBlockRemainingMs() {
    return Math.max(0, this.blockedUntilMs - Date.now());
  }

  private parseRetryAfterMs(error: any): number | null {
    const headers = error?.response?.headers;
    if (!headers || typeof headers !== 'object') return null;
    const rawHeader = headers['retry-after'] || headers['Retry-After'];
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

  private noteProviderBlockFromError(error: any) {
    const status = Number(error?.response?.status || 0);
    const retryAfterMs = this.parseRetryAfterMs(error);
    if (
      status !== 429 &&
      status !== 503 &&
      status !== 529 &&
      retryAfterMs === null
    ) {
      return;
    }

    const cooldownMs = retryAfterMs !== null
      ? Math.max(this.getCooldownMs(), retryAfterMs)
      : this.getCooldownMs();
    this.blockedUntilMs = Date.now() + cooldownMs;
    void this.trafficGuard.noteProviderBlock('ebay', cooldownMs);
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async runRequestWithThrottle<T>(request: () => Promise<T>) {
    let releaseQueue: () => void = () => {};
    const previous = this.requestChain;
    this.requestChain = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await previous;
    try {
      const minInterval = this.getRequestMinIntervalMs();
      const waitMs = this.lastRequestAt + minInterval - Date.now();
      if (waitMs > 0) {
        await this.sleep(waitMs);
      }
      await this.ensureExternalCallPermit('browse', minInterval);
      const result = await request();
      this.lastRequestAt = Date.now();
      return result;
    } finally {
      releaseQueue();
    }
  }

  private getSearchCacheTtlMs() {
    const seconds = this.parseIntegerConfig(
      'EBAY_SEARCH_CACHE_TTL_SECONDS',
      45,
      0,
      600,
    );
    return seconds * 1000;
  }

  private getSearchCacheMaxEntries() {
    return this.parseIntegerConfig(
      'EBAY_SEARCH_CACHE_MAX_ENTRIES',
      1200,
      100,
      10000,
    );
  }

  private getColorProbeQueryLimit() {
    return this.parseIntegerConfig('EBAY_COLOR_PROBE_QUERY_LIMIT', 2, 1, 8);
  }

  private getAspectColorQueryLimit() {
    return this.parseIntegerConfig('EBAY_ASPECT_COLOR_QUERY_LIMIT', 1, 1, 6);
  }

  private getGeneralQueryLimit() {
    return this.parseIntegerConfig('EBAY_GENERAL_QUERY_LIMIT', 6, 1, 12);
  }

  private getFinalOfferLimit() {
    return this.parseIntegerConfig('EBAY_FINAL_OFFERS_LIMIT', 40, 10, 120);
  }

  private clamp01(value: number) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
  }

  private getMarketplaceCountryCode(marketplaceId?: string | null) {
    const normalized = String(marketplaceId || '').trim().toUpperCase();
    if (!normalized) return '';
    return this.MARKETPLACE_COUNTRY_CODES[normalized] || '';
  }

  private resolveEffectiveUnitPrice(offer: any) {
    const price = Number.parseFloat(String(offer?.price || '0'));
    const shipping = Number.parseFloat(String(offer?.deliveryLowestPrice || 'NaN'));
    const unitQty =
      parsePositiveInteger(offer?.offerUnitQuantity, 1, 5000) || 1;
    const safePrice = Number.isFinite(price) && price > 0 ? price : 0;
    const safeShipping = Number.isFinite(shipping) && shipping >= 0 ? shipping : 0;
    return (safePrice + safeShipping) / Math.max(1, unitQty);
  }

  private computeHybridScore(offer: any) {
    const price = Number.parseFloat(String(offer?.price || '0'));
    const shipping = Number.parseFloat(String(offer?.deliveryLowestPrice || 'NaN'));
    const safePrice = Number.isFinite(price) && price > 0 ? price : 0;
    const shippingKnown = Number.isFinite(shipping) && shipping >= 0;
    const effectiveUnitPrice = this.resolveEffectiveUnitPrice(offer);
    const effectivePriceNorm = this.clamp01(effectiveUnitPrice / 20);

    const shippingPenalty = shippingKnown
      ? this.clamp01(
          (Number(shipping) || 0) /
            Math.max(0.01, safePrice + (Number(shipping) || 0)),
        )
      : 1;

    const marketplaceCountry = this.getMarketplaceCountryCode(
      offer?.sourceMarketplaceId,
    );
    const sellerCountry = String(offer?.sellerCountryCode || '')
      .trim()
      .toUpperCase();
    const locationPenalty =
      !marketplaceCountry || !sellerCountry
        ? 0.5
        : sellerCountry === marketplaceCountry
          ? 0
          : 1;

    const precisionNorm = this.clamp01(
      Number(offer?.precisionRank || 0) / 4500,
    );
    const colorNorm = this.clamp01(Number(offer?.colorMatchScore || 0) / 4);
    const confidence = this.clamp01(0.7 * precisionNorm + 0.3 * colorNorm);
    const confidencePenalty = 1 - confidence;

    return (
      0.65 * effectivePriceNorm +
      0.2 * shippingPenalty +
      0.1 * locationPenalty +
      0.05 * confidencePenalty
    );
  }

  private withHybridScore(offer: any) {
    if (!offer || typeof offer !== 'object') {
      return offer;
    }
    return {
      ...offer,
      hybridScore: this.computeHybridScore(offer),
    };
  }

  private getOfferIdentityKey(offer: any) {
    const provider = String(offer?.provider || 'ebay').trim().toLowerCase();
    const marketplace = String(offer?.sourceMarketplaceId || 'n/a')
      .trim()
      .toUpperCase();
    const id = String(offer?.id || '').trim();
    return `${provider}:${marketplace}:${id}`;
  }

  private compareOffersByHybrid(a: any, b: any) {
    const shippingMissingDiff =
      Number(Boolean(a?.shippingMissingPrice)) -
      Number(Boolean(b?.shippingMissingPrice));
    if (shippingMissingDiff !== 0) return shippingMissingDiff;

    const precisionDiff = Number(b?.precisionRank || 0) - Number(a?.precisionRank || 0);
    if (precisionDiff !== 0) return precisionDiff;

    const colorDiff = Number(b?.colorMatchScore || 0) - Number(a?.colorMatchScore || 0);
    if (colorDiff !== 0) return colorDiff;

    const aHybrid = Number.isFinite(Number(a?.hybridScore))
      ? Number(a.hybridScore)
      : this.computeHybridScore(a);
    const bHybrid = Number.isFinite(Number(b?.hybridScore))
      ? Number(b.hybridScore)
      : this.computeHybridScore(b);
    const hybridDiff = aHybrid - bHybrid;
    if (hybridDiff !== 0) return hybridDiff;

    const effectivePriceDiff =
      this.resolveEffectiveUnitPrice(a) - this.resolveEffectiveUnitPrice(b);
    if (effectivePriceDiff !== 0) return effectivePriceDiff;

    return Number.parseFloat(String(a?.price || '0')) - Number.parseFloat(String(b?.price || '0'));
  }

  private pruneSearchCache() {
    const now = Date.now();
    for (const [key, entry] of this.searchCache.entries()) {
      if (!entry || entry.expiresAt <= now) {
        this.searchCache.delete(key);
      }
    }

    const maxEntries = this.getSearchCacheMaxEntries();
    if (this.searchCache.size <= maxEntries) return;

    const overflow = this.searchCache.size - maxEntries;
    const keysToDrop = Array.from(this.searchCache.keys()).slice(0, overflow);
    keysToDrop.forEach((key) => this.searchCache.delete(key));
  }

  getSourceDescriptor(): OfferSourceDescriptor {
    return {
      id: 'ebay',
      label: 'eBay',
      enabled: this.isEnabled(),
      configured: this.isConfigured(),
      optimizable: true,
      description:
        'Oferty z eBay (Buy Browse API) z danymi sprzedawcy i kosztami dostawy.',
      requiresEnv: ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET'],
      supportsSellerRatingPercentFilter: true,
    };
  }

  private async getAccessToken() {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 30_000) {
      return this.tokenCache.token;
    }

    const clientId = this.config.get<string>('EBAY_CLIENT_ID')?.trim();
    const clientSecret = this.config.get<string>('EBAY_CLIENT_SECRET')?.trim();
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const body = new URLSearchParams();
    body.set('grant_type', 'client_credentials');
    body.set('scope', 'https://api.ebay.com/oauth/api_scope');

    await this.ensureExternalCallPermit('oauth-token', 0);

    const { data } = await firstValueFrom(
      this.httpService.post(this.getIdentityUrl(), body.toString(), {
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }),
    );

    const token = String(data?.access_token || '');
    const expiresIn = Number.parseInt(String(data?.expires_in || '7200'), 10);
    this.tokenCache = {
      token,
      expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000,
    };
    return token;
  }

  private buildStrictColorLabels(colorName?: string) {
    const labels = new Set<string>();
    const normalized = this.normalize(colorName);
    if (!normalized) return labels;

    labels.add(normalized);
    (this.STRICT_COLOR_EQUIVALENTS[normalized] || [])
      .map((value) => this.normalize(value))
      .filter((value) => value.length > 0)
      .forEach((value) => labels.add(value));

    if (normalized.includes(' gray')) {
      labels.add(normalized.replace(/ gray/g, ' grey'));
    }
    if (normalized.includes(' grey')) {
      labels.add(normalized.replace(/ grey/g, ' gray'));
    }

    return labels;
  }

  private hasColorMatchInTitle(title: string, strictColorLabels: Set<string>) {
    if (strictColorLabels.size === 0) return false;
    const normalizedTitle = this.normalize(title);
    return Array.from(strictColorLabels.values()).some((label) =>
      this.hasWholeToken(normalizedTitle, label),
    );
  }

  private hasAnyColorSignal(title: string) {
    const normalizedTitle = this.normalize(title);
    return this.COLOR_TOKENS.some((token) => this.hasWholeToken(normalizedTitle, token));
  }

  private hasConflictingColorSignal(
    title: string,
    strictColorLabels: Set<string>,
  ) {
    if (strictColorLabels.size === 0) return false;
    const normalizedTitle = this.normalize(title);

    const hasRequestedColor = Array.from(strictColorLabels.values()).some((label) =>
      this.hasWholeToken(normalizedTitle, label),
    );
    if (!hasRequestedColor) return false;

    const tokenMatches = this.COLOR_TOKENS.filter((token) =>
      this.hasWholeToken(normalizedTitle, token),
    ).map((token) => this.normalize(token));

    return tokenMatches.some((token) => {
      return !Array.from(strictColorLabels.values()).some((label) => {
        const normalizedLabel = this.normalize(label);
        return (
          token === normalizedLabel ||
          token.includes(normalizedLabel) ||
          normalizedLabel.includes(token)
        );
      });
    });
  }

  private extractPartDimensions(partName?: string) {
    const normalized = this.normalize(partName || '');
    const matches = normalized.match(/\d+\s*x\s*\d+/g) || [];
    return Array.from(
      new Set(matches.map((entry) => entry.replace(/\s+/g, ''))),
    );
  }

  private extractPartNameTokens(partName?: string): string[] {
    const normalized = this.normalize(partName || '')
      .replace(/(\d)\s*x\s*(\d)/g, '$1x$2')
      .replace(/[^a-z0-9\s]/g, ' ');

    return Array.from(
      new Set(
        normalized
          .split(/\s+/)
          .filter(
            (token) =>
              token.length >= 2 && !this.PART_NAME_STOP_WORDS.has(token),
          ),
      ),
    );
  }

  private getPartNameTokenHits(title: string, partNameTokens: string[]): number {
    if (partNameTokens.length === 0) return 0;
    const normalizedTitle = this.normalize(title);
    let hits = 0;
    for (const token of partNameTokens) {
      if (
        this.hasWholeToken(normalizedTitle, token) ||
        normalizedTitle.includes(token)
      ) {
        hits += 1;
      }
    }
    return hits;
  }

  private resolvePrimaryPartType(partNameTokens: string[]) {
    for (const token of this.PRIMARY_PART_TYPE_TOKENS) {
      if (partNameTokens.includes(token)) return token;
    }
    return null;
  }

  private hasConflictingPrimaryPartType(
    title: string,
    primaryPartType: string | null,
    partNameTokens: string[],
  ) {
    if (!primaryPartType) return false;
    const normalizedTitle = this.normalize(title);

    return this.PRIMARY_PART_TYPE_TOKENS.some((token) => {
      if (token === primaryPartType) return false;
      if (partNameTokens.includes(token)) return false;
      return this.hasWholeToken(normalizedTitle, token);
    });
  }

  private isSimpleDimensionPartName(partName?: string) {
    const normalizedPartName = this.normalize(partName || '')
      .replace(/\s+/g, ' ')
      .trim();
    return /^(brick|plate|tile|slope)\s+\d+\s*x\s*\d+$/i.test(normalizedPartName);
  }

  private hasSimplePartNoise(title: string, partNameTokens: string[]) {
    const normalizedTitle = this.normalize(title);
    return this.SIMPLE_PART_NOISE_TOKENS.some((token) => {
      if (partNameTokens.includes(token)) return false;
      return this.hasWholeToken(normalizedTitle, token);
    });
  }

  private choosePrimaryPartId(ids: string[], designId?: string): string {
    const normalizedDesignId = String(designId || '').trim();
    if (normalizedDesignId.length > 0) {
      return normalizedDesignId;
    }

    const candidates = Array.from(
      new Set(
        ids
          .map((value) => String(value || '').trim())
          .filter((value) => value.length > 0),
      ),
    );
    if (candidates.length === 0) return '';

    const scored = candidates
      .map((id) => {
        let score = 0;
        if (/^\d{3,6}$/.test(id)) score += 10;
        if (/^[a-z]\d{3,6}$/i.test(id)) score += 6;
        score -= Math.abs(id.length - 4);
        return { id, score };
      })
      .sort((a, b) => b.score - a.score);

    return scored[0]?.id || '';
  }

  private buildQueries(
    ids: string[],
    designId: string | undefined,
    hasColor: boolean,
    colorName: string | undefined,
    partName?: string,
  ): EbaySearchQuery[] {
    const partId = this.choosePrimaryPartId(ids, designId);
    const normalizedPartName = this.normalize(partName || '')
      .replace(/(\d)\s*x\s*(\d)/g, '$1 x $2')
      .replace(/\s+/g, ' ')
      .trim();
    const normalizedColor = this.normalize(colorName || '').trim();
    const base = `lego ${partId}`.trim();

    const queries: EbaySearchQuery[] = [];
    const push = (
      phrase: string,
      sourceTier: number,
      containsColor: boolean,
      containsPartName: boolean,
    ) => {
      const normalizedPhrase = phrase.replace(/\s+/g, ' ').trim();
      if (!normalizedPhrase) return;
      if (queries.some((entry) => entry.phrase === normalizedPhrase)) return;
      queries.push({
        phrase: normalizedPhrase,
        sourceTier,
        containsColor,
        containsPartName,
      });
    };

    if (hasColor && partId && normalizedPartName && normalizedColor) {
      push(`${base} ${normalizedPartName} ${normalizedColor}`, 9, true, true);
    }
    if (partId && normalizedPartName) {
      push(`${base} ${normalizedPartName}`, 8, false, true);
    }
    if (hasColor && normalizedPartName && normalizedColor) {
      push(`lego ${normalizedPartName} ${normalizedColor}`, 7, true, true);
    }
    if (normalizedPartName) {
      push(`lego ${normalizedPartName}`, 6, false, true);
    }
    if (hasColor && partId && normalizedColor) {
      push(`${base} ${normalizedColor}`, 5, true, false);
    }
    if (partId) {
      push(base, 4, false, false);
    }
    if (hasColor && normalizedColor && !partId && !normalizedPartName) {
      push(`lego ${normalizedColor}`, 3, true, false);
    }

    return queries;
  }

  private isColorAspectName(name: string): boolean {
    const normalizedName = this.normalize(name);
    if (!normalizedName) return false;
    return this.COLOR_ASPECT_NAME_TOKENS.some(
      (token) => normalizedName === token || normalizedName.includes(token),
    );
  }

  private buildAspectFilterValue(value: string): string {
    return String(value || '')
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\{/g, '')
      .replace(/\}/g, '')
      .trim();
  }

  private resolveColorAspectFilter(
    data: any,
    strictColorLabels: Set<string>,
  ): EbayColorAspectFilter | null {
    if (strictColorLabels.size === 0) return null;

    const categoryId = String(
      data?.dominantCategoryId ||
        data?.categoryDistributions?.[0]?.categoryId ||
        '',
    ).trim();
    if (!categoryId) return null;

    const aspects = Array.isArray(data?.aspectDistributions)
      ? data.aspectDistributions
      : [];

    for (const aspect of aspects) {
      const localizedAspectName = String(aspect?.localizedAspectName || '').trim();
      if (!localizedAspectName || !this.isColorAspectName(localizedAspectName)) {
        continue;
      }

      const values = Array.isArray(aspect?.aspectValueDistributions)
        ? aspect.aspectValueDistributions
        : [];
      for (const entry of values) {
        const localizedValue = String(
          entry?.localizedValue || entry?.localizedAspectValue || '',
        ).trim();
        if (!localizedValue) continue;
        const normalizedValue = this.normalize(localizedValue);
        if (!strictColorLabels.has(normalizedValue)) continue;

        const safeValue = this.buildAspectFilterValue(localizedValue);
        if (!safeValue) continue;

        return {
          categoryId,
          aspectFilter: `categoryId:${categoryId},${localizedAspectName}:{${safeValue}}`,
        };
      }
    }

    return null;
  }

  private async searchRaw(
    token: string,
    options: EbaySearchRequestOptions,
  ): Promise<any> {
    const params = new URLSearchParams();
    params.set('q', options.phrase);
    params.set('limit', String(options.limit || 50));
    params.set('filter', 'buyingOptions:{FIXED_PRICE|AUCTION}');
    params.set('fieldgroups', options.fieldgroups || 'MATCHING_ITEMS');
    if (this.supportsAutoCorrect(options.marketplaceId)) {
      params.set('auto_correct', 'KEYWORD');
    }
    if (options.categoryId) {
      params.set('category_ids', options.categoryId);
    }
    if (options.aspectFilter) {
      params.set('aspect_filter', options.aspectFilter);
    }

    const cacheTtlMs = this.getSearchCacheTtlMs();
    const cacheKey = `${options.marketplaceId}|${params.toString()}`;
    if (cacheTtlMs > 0) {
      const cached = this.searchCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
      }
    }

    const inFlight = this.searchInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async () => {
      const url = `${this.getApiBaseUrl()}/buy/browse/v1/item_summary/search?${params.toString()}`;
      const { data } = await this.runRequestWithThrottle(() =>
        firstValueFrom(
          this.httpService.get(url, {
            headers: {
              Authorization: `Bearer ${token}`,
              'X-EBAY-C-MARKETPLACE-ID': options.marketplaceId,
              Accept: 'application/json',
              Connection: 'keep-alive',
            },
          }),
        ),
      );

      const normalized = data || {};
      if (cacheTtlMs > 0) {
        this.searchCache.set(cacheKey, {
          value: normalized,
          expiresAt: Date.now() + cacheTtlMs,
        });
        this.pruneSearchCache();
      }
      return normalized;
    })().catch((error) => {
      this.noteProviderBlockFromError(error);
      throw error;
    });

    this.searchInFlight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.searchInFlight.delete(cacheKey);
    }
  }

  private async searchItems(
    token: string,
    options: EbaySearchRequestOptions,
  ) {
    const data = await this.searchRaw(token, options);
    return Array.isArray(data?.itemSummaries) ? data.itemSummaries : [];
  }

  private parseAspectsToText(item: any) {
    const localizedAspects = Array.isArray(item?.localizedAspects)
      ? item.localizedAspects
      : [];
    return localizedAspects
      .flatMap((aspect: any) => {
        const values = Array.isArray(aspect?.value)
          ? aspect.value
          : [aspect?.value];
        return [
          String(aspect?.name || ''),
          ...values.map((entry) => String(entry || '')),
        ];
      })
      .join(' ');
  }

  private getPartScore(
    title: string,
    ids: string[],
    designId?: string,
    partDimensions: string[] = [],
  ) {
    const normalizedTitle = this.normalize(title);
    let score = 0;
    let exactIdMatch = false;
    let partialIdMatch = false;

    ids.forEach((id) => {
      const normalizedId = this.normalize(id);
      if (!normalizedId) return;

      if (this.hasWholeToken(normalizedTitle, normalizedId)) {
        exactIdMatch = true;
        score = Math.max(score, 1400);
        return;
      }

      const boundedVariantPattern = new RegExp(
        `(^|[^a-z0-9])${this.escapeRegex(normalizedId)}[a-z]{1,3}([^a-z0-9]|$)`,
        'i',
      );
      if (boundedVariantPattern.test(normalizedTitle)) {
        partialIdMatch = true;
        score = Math.max(score, 980);
      }
    });

    const dimensionHits = partDimensions.filter((dim) =>
      normalizedTitle.includes(dim),
    ).length;

    if (partDimensions.length > 0) {
      if (dimensionHits > 0) {
        score += dimensionHits * 260;
      } else {
        score -= 320;
      }
    }

    const normalizedDesignId = this.normalize(designId || '');
    if (
      normalizedDesignId &&
      !normalizedDesignId.includes('pb') &&
      new RegExp(`${this.escapeRegex(normalizedDesignId)}\\s*pb\\d+`, 'i').test(
        normalizedTitle,
      )
    ) {
      score -= 1200;
    }

    return { score, exactIdMatch, partialIdMatch, dimensionHits };
  }

  private resolveOfferUnitQuantity(item: any) {
    const fromTitle = extractPackQuantityFromText(item?.title);
    if (fromTitle) {
      return {
        value: fromTitle,
        source: 'ebay-title',
      };
    }

    const aspectText = this.parseAspectsToText(item);

    const fromAspect = extractPackQuantityFromText(aspectText);
    if (fromAspect) {
      return {
        value: fromAspect,
        source: 'ebay-aspect',
      };
    }

    return {
      value: 1,
      source: 'default',
    };
  }

  private resolveAvailableOfferUnits(item: any): number | null {
    const availabilities = Array.isArray(item?.estimatedAvailabilities)
      ? item.estimatedAvailabilities
      : [];
    const candidates = availabilities
      .map((entry: any) =>
        parsePositiveInteger(
          entry?.estimatedAvailableQuantity ||
            entry?.estimatedRemainingQuantity ||
            entry?.availabilityThreshold,
          1,
          1_000_000,
        ),
      )
      .filter((entry: number | null): entry is number => entry !== null);

    const directAvailable = parsePositiveInteger(
      item?.availableQuantity || item?.quantity,
      1,
      1_000_000,
    );
    if (directAvailable !== null) {
      candidates.push(directAvailable);
    }

    const perBuyerLimit = parsePositiveInteger(
      item?.quantityLimitPerBuyer,
      1,
      1_000_000,
    );

    if (candidates.length > 0) {
      const candidate = Math.max(...candidates);
      if (perBuyerLimit !== null) {
        return Math.min(candidate, perBuyerLimit);
      }
      return candidate;
    }

    return perBuyerLimit;
  }

  async findOffersByExternalIds(
    ids: string[],
    colorName?: string,
    designId?: string,
    partName?: string,
  ) {
    if (!this.isEnabled() || !this.isConfigured()) {
      return [];
    }

    if (this.getBlockRemainingMs() > 0) {
      return [];
    }
    if ((await this.trafficGuard.getCooldownRemainingMs('ebay')) > 0) {
      return [];
    }

    try {
      const token = await this.getAccessToken();
      const strictColorLabels = this.buildStrictColorLabels(colorName);
      const hasColor = strictColorLabels.size > 0;
      const partDimensions = this.extractPartDimensions(partName);
      const partNameTokens = this.extractPartNameTokens(partName);
      const primaryPartType = this.resolvePrimaryPartType(partNameTokens);
      const isSimpleDimensionPart = this.isSimpleDimensionPartName(partName);
      const minTokenHits = partNameTokens.length > 0 ? Math.min(2, partNameTokens.length) : 0;
      const structuralPartNameTokens = partNameTokens.filter((token) =>
        /[a-z]/i.test(token) && !/^\d+x\d+$/i.test(token),
      );
      const minStructuralTokenHits = structuralPartNameTokens.length > 0 ? 1 : 0;

      const requestedIds = Array.from(
        new Set(
          [...ids.slice(0, 8), designId || '']
            .map((value) => String(value || '').trim())
            .filter((value) => value.length > 0),
        ),
      );
      const queries = this.buildQueries(
        requestedIds,
        designId,
        hasColor,
        colorName,
        partName,
      );
      const marketplaces = this.getSearchMarketplaces();
      const primaryMarketplace = this.getMarketplaceId();

      const strictOffers = new Map<string, any>();
      const relaxedOffers = new Map<string, any>();

      const upsertOffer = (
        bucket: Map<string, any>,
        key: string,
        prepared: any,
        priceValue: number,
      ) => {
        const existing = bucket.get(key);
        if (!existing) {
          bucket.set(key, prepared);
          return;
        }

        const existingPrice = Number.parseFloat(existing.price || '0');
        const existingHybrid = Number.isFinite(Number(existing.hybridScore))
          ? Number(existing.hybridScore)
          : this.computeHybridScore(existing);
        const preparedHybrid = Number.isFinite(Number(prepared.hybridScore))
          ? Number(prepared.hybridScore)
          : this.computeHybridScore(prepared);
        const shouldReplace =
          preparedHybrid < existingHybrid ||
          prepared.precisionRank > existing.precisionRank ||
          (prepared.precisionRank === existing.precisionRank &&
            prepared.colorMatchScore > existing.colorMatchScore) ||
          (prepared.precisionRank === existing.precisionRank &&
            prepared.colorMatchScore === existing.colorMatchScore &&
            preparedHybrid === existingHybrid &&
            this.resolveEffectiveUnitPrice(prepared) <
              this.resolveEffectiveUnitPrice(existing)) ||
          (prepared.precisionRank === existing.precisionRank &&
            prepared.colorMatchScore === existing.colorMatchScore &&
            priceValue < existingPrice);

        if (shouldReplace) {
          bucket.set(key, prepared);
        }
      };

      const collectItems = (
        items: any[],
        query: EbaySearchQuery,
        marketplaceId: string,
        forcedColorMatch = false,
        colorMatchSource: 'ebay-aspect-color' | 'ebay-title-color' | 'ebay-query' = 'ebay-query',
        allowLoosePartGate = false,
      ) => {
        items.forEach((item: any) => {
          const title = String(item?.title || '');
          if (!title) return;

          const partScore = this.getPartScore(
            title,
            requestedIds,
            designId,
            partDimensions,
          );
          const partTokenHits = this.getPartNameTokenHits(title, partNameTokens);
          const structuralTokenHits = this.getPartNameTokenHits(
            title,
            structuralPartNameTokens,
          );
          const hasDimensionsConstraint = partDimensions.length > 0;
          const dimensionsMatch =
            !hasDimensionsConstraint || partScore.dimensionHits > 0;
          const structuralMatch =
            minStructuralTokenHits === 0 ||
            structuralTokenHits >= minStructuralTokenHits;
          const tokenMatch = minTokenHits === 0 || partTokenHits >= minTokenHits;

          const strictPartMatch =
            partScore.exactIdMatch ||
            (partScore.partialIdMatch && dimensionsMatch && structuralMatch);
          const strongNameMatch = tokenMatch && dimensionsMatch && structuralMatch;
          const relaxedPartMatch = strictPartMatch || strongNameMatch;

          const hasConflictingPartType = this.hasConflictingPrimaryPartType(
            title,
            primaryPartType,
            partNameTokens,
          );
          if (hasConflictingPartType && !partScore.exactIdMatch) return;

          const hasSimpleNoise =
            isSimpleDimensionPart &&
            this.hasSimplePartNoise(title, partNameTokens);
          if (hasSimpleNoise && !partScore.exactIdMatch) return;

          if (!relaxedPartMatch && !allowLoosePartGate) return;
          if (requestedIds.length > 0 && !strictPartMatch && !strongNameMatch) return;

          const titleColorMatch = this.hasColorMatchInTitle(title, strictColorLabels);
          const hasConflictingColor = this.hasConflictingColorSignal(
            title,
            strictColorLabels,
          );
          const matchedRequestedColor =
            !hasColor ||
            forcedColorMatch ||
            (titleColorMatch && !hasConflictingColor);
          const colorConflict =
            hasColor &&
            !forcedColorMatch &&
            (hasConflictingColor ||
              (!matchedRequestedColor && this.hasAnyColorSignal(title)));
          if (colorConflict) return;

          const priceValue = Number.parseFloat(
            String(item?.price?.value || item?.price?.amount || '0'),
          );
          if (!Number.isFinite(priceValue) || priceValue <= 0) return;

          const shippingOptions = Array.isArray(item?.shippingOptions)
            ? item.shippingOptions
            : [];
          const shippingCandidates = shippingOptions
            .map((option: any) => {
              const amount = Number.parseFloat(
                String(
                  option?.shippingCost?.value ||
                    option?.shippingCost?.amount ||
                    'NaN',
                ),
              );
              return {
                option,
                amount,
              };
            })
            .filter((entry: { amount: number }) => Number.isFinite(entry.amount));
          const cheapestShipping = shippingCandidates.sort(
            (a: { amount: number }, b: { amount: number }) => a.amount - b.amount,
          )[0];
          const shippingValue = cheapestShipping?.amount;

          const currency = String(item?.price?.currency || 'PLN');
          const sourcePriority =
            1200 +
            query.sourceTier * 180 +
            (query.containsPartName ? 220 : 0) +
            (query.containsColor ? 160 : 0) +
            (matchedRequestedColor ? 600 : 0) +
            (forcedColorMatch ? 450 : 0) +
            (strictPartMatch ? 500 : 0) +
            partTokenHits * 90 +
            (partScore.dimensionHits > 0 ? partScore.dimensionHits * 140 : 0) +
            partScore.score +
            (marketplaceId === primaryMarketplace ? 30 : 0);
          const precisionRank = sourcePriority;
          const colorMatchScore = matchedRequestedColor ? 4 : 0;
          const unitQuantity = this.resolveOfferUnitQuantity(item);
          const availableOfferUnits = this.resolveAvailableOfferUnits(item);
          const sellerFeedbackPercentRaw = Number.parseFloat(
            String(item?.seller?.feedbackPercentage || 'NaN'),
          );
          const sellerFeedbackScoreRaw = Number.parseInt(
            String(item?.seller?.feedbackScore || ''),
            10,
          );

          const prepared = {
            id: String(item?.itemId || ''),
            name: title,
            price: String(priceValue.toFixed(2)),
            currency,
            url: String(item?.itemWebUrl || item?.itemHref || ''),
            thumbnail:
              item?.image?.imageUrl ||
              item?.thumbnailImages?.[0]?.imageUrl ||
              null,
            sellerId: item?.seller?.username || item?.seller?.userId || null,
            sellerLogin: item?.seller?.username || item?.seller?.userId || null,
            sellerFeedbackPercent: Number.isFinite(sellerFeedbackPercentRaw)
              ? sellerFeedbackPercentRaw
              : null,
            sellerFeedbackScore: Number.isFinite(sellerFeedbackScoreRaw)
              ? sellerFeedbackScoreRaw
              : null,
            sellerReviewsCount: Number.isFinite(sellerFeedbackScoreRaw)
              ? sellerFeedbackScoreRaw
              : null,
            sellerIsTopRated: Boolean(item?.topRatedBuyingExperience),
            sellerCountryCode:
              item?.itemLocation?.country ||
              item?.shippingOptions?.[0]?.shipToLocationUsedForEstimate?.country ||
              null,
            deliveryLowestPrice:
              typeof shippingValue === 'number' && Number.isFinite(shippingValue)
                ? String(shippingValue.toFixed(2))
                : null,
            deliveryCurrency: String(
              cheapestShipping?.option?.shippingCost?.currency || currency,
            ),
            shippingMissingPrice: !(
              typeof shippingValue === 'number' && Number.isFinite(shippingValue)
            ),
            offerUnitQuantity: unitQuantity.value,
            offerUnitQuantitySource: unitQuantity.source,
            availableOfferUnits,
            availablePieceQuantity:
              availableOfferUnits !== null
                ? availableOfferUnits * unitQuantity.value
                : null,
            requestedColorName: colorName || null,
            matchedRequestedColor,
            colorConflict,
            colorMatchScore,
            precisionRank,
            matchSource: matchedRequestedColor
              ? colorMatchSource
              : 'ebay-query',
            queryContainsColor: query.containsColor,
            queryContainsPartName: query.containsPartName,
            sourceMarketplaceId: marketplaceId,
            provider: 'ebay',
            providerLabel: 'eBay',
            isEstimated: false,
          };

          if (!prepared.id || !prepared.url) return;

          const key = `${prepared.provider}:${marketplaceId}:${prepared.id}`;
          const preparedWithHybrid = this.withHybridScore(prepared);
          if (strictPartMatch) {
            upsertOffer(strictOffers, key, preparedWithHybrid, priceValue);
          } else {
            upsertOffer(relaxedOffers, key, preparedWithHybrid, priceValue);
          }
        });
      };

      for (const marketplaceId of marketplaces) {
        let aspectColorFilter: EbayColorAspectFilter | null = null;

        if (hasColor) {
          for (const probeQuery of queries
            .filter((query) => query.containsColor)
            .slice(0, this.getColorProbeQueryLimit())) {
            try {
              const refinementData = await this.searchRaw(token, {
                phrase: probeQuery.phrase,
                marketplaceId,
                limit: 30,
                fieldgroups: 'ASPECT_REFINEMENTS,CATEGORY_REFINEMENTS',
              });
              aspectColorFilter = this.resolveColorAspectFilter(
                refinementData,
                strictColorLabels,
              );
              if (aspectColorFilter) break;
            } catch {
              // Refinements are often empty in sandbox; continue with title-based matching.
            }
          }
        }

        if (aspectColorFilter) {
          for (const query of queries
            .filter((entry) => entry.containsColor)
            .slice(0, this.getAspectColorQueryLimit())) {
            try {
              const aspectItems = await this.searchItems(token, {
                phrase: query.phrase,
                marketplaceId,
                limit: 50,
                categoryId: aspectColorFilter.categoryId,
                aspectFilter: aspectColorFilter.aspectFilter,
                fieldgroups: 'MATCHING_ITEMS',
              });
              collectItems(
                aspectItems,
                { ...query, sourceTier: query.sourceTier + 3 },
                marketplaceId,
                true,
                'ebay-aspect-color',
              );
            } catch {
              // If aspect_filter fails for a marketplace/category, fallback still runs below.
            }
          }
        }

        for (const query of queries.slice(0, this.getGeneralQueryLimit())) {
          try {
            const items = await this.searchItems(token, {
              phrase: query.phrase,
              marketplaceId,
              limit: 50,
              fieldgroups: 'MATCHING_ITEMS',
            });

            collectItems(
              items,
              query,
              marketplaceId,
              false,
              'ebay-title-color',
            );
          } catch {
            // Ignore single-query failures and continue with the rest of strategy tiers.
          }
        }
      }

      if (
        this.getEnvironment() === 'sandbox' &&
        strictOffers.size === 0 &&
        relaxedOffers.size === 0
      ) {
        const fallbackQuery: EbaySearchQuery = {
          phrase: 'lego',
          sourceTier: 0,
          containsColor: false,
          containsPartName: false,
        };

        for (const marketplaceId of marketplaces) {
          try {
            const broadItems = await this.searchItems(token, {
              phrase: fallbackQuery.phrase,
              marketplaceId,
              limit: 50,
              fieldgroups: 'MATCHING_ITEMS',
            });
            collectItems(
              broadItems,
              fallbackQuery,
              marketplaceId,
              false,
              'ebay-query',
              true,
            );
          } catch {
            // Ignore fallback failures; sandbox data quality is best-effort only.
          }
        }
      }

      const finalOfferLimit = this.getFinalOfferLimit();
      const sortOffers = (offers: any[]) =>
        offers
          .map((offer) => this.withHybridScore(offer))
          .sort((a, b) => {
            return this.compareOffersByHybrid(a, b);
          })
          .slice(0, finalOfferLimit);

      const strictSorted = sortOffers(Array.from(strictOffers.values()));
      const relaxedSorted = sortOffers(Array.from(relaxedOffers.values()));
      const strictColorSorted = strictSorted.filter(
        (offer) => offer.matchedRequestedColor && !offer.colorConflict,
      );
      const relaxedColorSorted = relaxedSorted.filter(
        (offer) => offer.matchedRequestedColor && !offer.colorConflict,
      );

      const merged = hasColor
        ? requestedIds.length > 0
          ? strictColorSorted.length > 0
            ? [...strictColorSorted]
            : [...relaxedColorSorted]
          : sortOffers([...strictColorSorted, ...relaxedColorSorted])
        : strictSorted.length === 0
          ? [...relaxedSorted]
          : [...strictSorted];

      if (!hasColor && strictSorted.length > 0) {
        const seen = new Set(
          merged.map(
            (offer) =>
              `${offer.provider}:${offer.sourceMarketplaceId || 'n/a'}:${offer.id}`,
          ),
        );
        for (const candidate of relaxedSorted) {
          if (merged.length >= Math.max(60, finalOfferLimit * 2)) break;
          const key = `${candidate.provider}:${candidate.sourceMarketplaceId || 'n/a'}:${candidate.id}`;
          if (seen.has(key)) continue;
          merged.push(candidate);
          seen.add(key);
        }
      }

      const mergedWithDetails = merged.map((offer) => this.withHybridScore(offer));

      return mergedWithDetails
        .sort((a, b) => {
          return this.compareOffersByHybrid(a, b);
        })
        .slice(0, finalOfferLimit);
    } catch (error) {
      this.noteProviderBlockFromError(error);
      const status = Number(error?.response?.status || 0);
      const message =
        error?.response?.data?.message ||
        error?.response?.data?.errors?.[0]?.message ||
        error?.message ||
        'Unknown eBay API error';
      this.logger.warn(
        `eBay search failed [HTTP ${status || 'n/a'}]: ${String(message)}`,
      );
      return [];
    }
  }
}
