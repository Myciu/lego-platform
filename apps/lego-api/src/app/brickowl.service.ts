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

interface BrickowlCatalogItem {
  boid: string;
  name: string;
  href: string;
  image: string | null;
  price: number;
  currency: string;
}

interface BrickowlItemContext {
  itemId: string;
  token: string;
  pageUrl: string;
  itemName: string;
  colorFilters: Array<{ id: string; name: string }>;
}

interface BrickowlSearchQuery {
  phrase: string;
  sourceTier: number;
  queryContainsColor: boolean;
  queryContainsPartName: boolean;
}

@Injectable()
export class BrickowlService {
  private readonly logger = new Logger(BrickowlService.name);
  private readonly baseUrl = 'https://www.brickowl.com';
  private readonly browserUserAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  private complianceWarningLogged = false;
  private blockedUntilMs = 0;

  private readonly COLOR_TOKENS = [
    'black',
    'white',
    'red',
    'blue',
    'green',
    'yellow',
    'orange',
    'brown',
    'gray',
    'grey',
    'tan',
    'dark turquoise',
    'dark bluish gray',
    'light bluish gray',
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

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
    private readonly trafficGuard: ProviderTrafficGuardService,
  ) {}

  private getRequestMinIntervalMs() {
    const base = this.parseIntegerConfig(
      'BRICKOWL_REQUEST_MIN_INTERVAL_MS',
      1_100,
      0,
      60_000,
    );
    return this.applyThrottleReduction(base);
  }

  private async ensureExternalCallPermit(callType: string, minIntervalMs = 0) {
    const permit = await this.trafficGuard.beforeExternalCall('brickowl', callType, {
      minIntervalMs,
    });
    if (permit.allowed) return;

    const reason = permit.reason || 'unknown';
    const waitMs = Math.max(0, Math.floor(permit.waitMs || 0));
    const error = new Error(
      `BrickOwl provider guard blocked (${reason}${waitMs > 0 ? `/${waitMs}ms` : ''})`,
    );
    (error as any).isProviderGuardBlocked = true;
    (error as any).providerGuardReason = reason;
    throw error;
  }

  private async guardedGetText(
    url: string,
    headers: Record<string, string>,
    callType: string,
  ) {
    await this.ensureExternalCallPermit(callType, this.getRequestMinIntervalMs());
    const response = await firstValueFrom(
      this.httpService.get(url, {
        headers,
        responseType: 'text',
      }),
    );
    return String(response.data || '');
  }

  private normalize(value?: string) {
    return (value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  private normalizeText(value?: string) {
    return this.normalize(value || '')
      .replace(/[^a-z0-9\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private escapeRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private hasWholeToken(haystack: string, needle: string) {
    const normalizedHaystack = this.normalizeText(haystack);
    const normalizedNeedle = this.normalizeText(needle);
    if (!normalizedHaystack || !normalizedNeedle) return false;

    const pattern = new RegExp(
      `(^|[^a-z0-9])${this.escapeRegex(normalizedNeedle)}([^a-z0-9]|$)`,
      'i',
    );
    return pattern.test(normalizedHaystack);
  }

  private isEnabled() {
    const raw = this.normalize(this.config.get<string>('BRICKOWL_ENABLED') || '');
    return raw !== 'false' && raw !== '0' && raw !== 'off';
  }

  private isUnofficialScrapingAllowed() {
    const raw = this.normalize(
      this.config.get<string>('BRICKOWL_ALLOW_UNOFFICIAL_SCRAPING') || '',
    );
    if (!raw) return true;
    return !['false', '0', 'off', 'no'].includes(raw);
  }

  private isConfigured() {
    return this.isUnofficialScrapingAllowed();
  }

  private getBlockCooldownMs() {
    return this.parseIntegerConfig(
      'BRICKOWL_BLOCK_COOLDOWN_MS',
      10 * 60 * 1000,
      5_000,
      24 * 60 * 60 * 1000,
    );
  }

  private getBlockRemainingMs() {
    return Math.max(0, this.blockedUntilMs - Date.now());
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
      ? Math.max(this.getBlockCooldownMs(), retryAfterMs)
      : this.getBlockCooldownMs();
    this.blockedUntilMs = Date.now() + cooldownMs;
    void this.trafficGuard.noteProviderBlock('brickowl', cooldownMs);
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

  private getMaxSearchQueries() {
    return this.parseIntegerConfig('BRICKOWL_MAX_SEARCH_QUERIES', 6, 1, 12);
  }

  private getMaxCatalogCandidates() {
    return this.parseIntegerConfig('BRICKOWL_MAX_CATALOG_CANDIDATES', 8, 1, 20);
  }

  private getMaxDetailRequests() {
    return this.parseIntegerConfig('BRICKOWL_MAX_DETAIL_REQUESTS', 10, 1, 30);
  }

  private getFinalOfferLimit() {
    return this.parseIntegerConfig('BRICKOWL_FINAL_OFFERS_LIMIT', 40, 10, 120);
  }

  private getDtBuyPageSize() {
    return this.parseIntegerConfig('BRICKOWL_DT_BUY_PAGE_SIZE', 40, 10, 100);
  }

  private getDtBuyMaxRows() {
    return this.parseIntegerConfig('BRICKOWL_DT_BUY_MAX_ROWS', 120, 20, 300);
  }

  private normalizeRequestedId(value: unknown) {
    return String(value || '')
      .trim()
      .replace(/\.dat$/i, '')
      .replace(/\s+/g, '')
      .trim();
  }

  getSourceDescriptor(): OfferSourceDescriptor {
    const compliant = this.isConfigured();
    return {
      id: 'brickowl',
      label: 'BrickOwl',
      enabled: this.isEnabled(),
      configured: compliant,
      optimizable: true,
      description:
        compliant
          ? 'Realne oferty BrickOwl pobierane w trybie ograniczonym (ochrona anty-ban).'
          : 'BrickOwl wyłączony. Ustaw BRICKOWL_ALLOW_UNOFFICIAL_SCRAPING=true, aby włączyć pobieranie.',
      requiresEnv: compliant ? [] : ['BRICKOWL_ALLOW_UNOFFICIAL_SCRAPING=true'],
      supportsSellerRatingPercentFilter: false,
    };
  }

  private decodeEntities(value: string) {
    return value
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;quot;/g, '"')
      .replace(/&amp;#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&#(\d+);/g, (_match, dec) =>
        String.fromCharCode(Number.parseInt(dec, 10) || 0),
      )
      .replace(/&#x([0-9a-f]+);/gi, (_match, hex) =>
        String.fromCharCode(Number.parseInt(hex, 16) || 0),
      );
  }

  private stripHtml(value?: string) {
    const decoded = this.decodeEntities(String(value || ''));
    return decoded.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private toAbsoluteUrl(url?: string | null) {
    const raw = String(url || '').trim();
    if (!raw) return null;
    if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
    if (raw.startsWith('//')) return `https:${raw}`;
    if (raw.startsWith('/')) return `${this.baseUrl}${raw}`;
    return `${this.baseUrl}/${raw}`;
  }

  private extractFirstHref(html?: string) {
    const match = String(html || '').match(/href="([^"]+)"/i);
    return match?.[1] ? this.decodeEntities(String(match[1])) : null;
  }

  private extractFirstImageSrc(html?: string) {
    const match = String(html || '').match(/src="([^"]+)"/i);
    return match?.[1] ? this.decodeEntities(String(match[1])) : null;
  }

  private parseCurrency(text: string) {
    const normalized = this.stripHtml(text).trim();
    if (normalized.includes('zł')) return 'PLN';
    if (normalized.includes('€')) return 'EUR';
    if (normalized.includes('$')) return 'USD';
    return 'PLN';
  }

  private parsePrice(raw: string) {
    const plain = this.stripHtml(raw).replace(/[^\d,.-]/g, '');
    if (!plain) return 0;

    const comma = plain.lastIndexOf(',');
    const dot = plain.lastIndexOf('.');
    let normalized = plain;

    if (comma >= 0 && dot >= 0) {
      if (comma > dot) {
        normalized = plain.replace(/\./g, '').replace(',', '.');
      } else {
        normalized = plain.replace(/,/g, '');
      }
    } else if (comma >= 0) {
      normalized = plain.replace(',', '.');
    }

    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private buildBrowserHtmlHeaders(extra: Record<string, string> = {}) {
    return {
      'User-Agent': this.browserUserAgent,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,pl;q=0.8',
      ...extra,
    };
  }

  private getEstimatedShipping() {
    const parsed = Number.parseFloat(
      String(this.config.get<string>('BRICKOWL_ESTIMATED_SHIPPING') || '0'),
    );
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private getPreferredCountryCode() {
    const raw = String(
      this.config.get<string>('OFFERS_TARGET_COUNTRY') ||
        this.config.get<string>('BRICKOWL_TARGET_COUNTRY') ||
        'PL',
    )
      .trim()
      .toUpperCase();
    return raw || 'PL';
  }

  private clamp01(value: number) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
  }

  private resolveEffectiveUnitPrice(offer: any) {
    const price = this.parsePrice(String(offer?.price || '0'));
    const shipping = this.parsePrice(String(offer?.deliveryLowestPrice || '0'));
    const unitQty = parsePositiveInteger(offer?.offerUnitQuantity, 1, 5000) || 1;
    return (price + shipping) / Math.max(1, unitQty);
  }

  private computeHybridScore(offer: any) {
    const price = this.parsePrice(String(offer?.price || '0'));
    const delivery = this.parsePrice(String(offer?.deliveryLowestPrice || '0'));
    const shippingMissing = this.hasMissingShippingPrice(offer);
    const effectivePriceNorm = this.clamp01(this.resolveEffectiveUnitPrice(offer) / 20);

    const shippingPenalty = shippingMissing
      ? 1
      : this.clamp01(delivery / Math.max(0.01, price + delivery));

    const preferredCountry = this.getPreferredCountryCode();
    const sellerCountry = String(offer?.sellerCountryCode || '')
      .trim()
      .toUpperCase();
    const locationPenalty = !sellerCountry
      ? 0.5
      : sellerCountry === preferredCountry
        ? 0
        : 1;

    const precisionNorm = this.clamp01(Number(offer?.precisionRank || 0) / 4500);
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
    if (!offer || typeof offer !== 'object') return offer;
    return {
      ...offer,
      hybridScore: this.computeHybridScore(offer),
    };
  }

  private parseCatalogItems(html: string) {
    const items: BrickowlCatalogItem[] = [];
    const itemRegex =
      /<li class="category-item[\s\S]*?data-boid="([^"]+)"[\s\S]*?<\/li>/gi;

    let itemMatch: RegExpExecArray | null;
    while ((itemMatch = itemRegex.exec(html))) {
      const block = itemMatch[0];
      const boid = String(itemMatch[1] || '').trim();
      const nameMatch = block.match(
        /<h2 class="category-item-name">\s*<a[^>]*title="([^"]+)"/i,
      );
      const hrefMatch = block.match(
        /<h2 class="category-item-name">\s*<a[^>]*href="([^"]+)"/i,
      );
      const imageMatch = block.match(/<img[^>]*src="([^"]+)"/i);
      const priceMatch = block.match(
        /<span class=['"]price pr['"]>\s*<span>([^<]+)<\/span>\s*([^<]+)<\/span>/i,
      );

      const name = this.decodeEntities(String(nameMatch?.[1] || '').trim());
      const href = String(hrefMatch?.[1] || '').trim();
      if (!name || !href) continue;

      const price = priceMatch ? this.parsePrice(String(priceMatch[1])) : 0;
      const currency = priceMatch
        ? this.parseCurrency(String(priceMatch[2] || ''))
        : 'PLN';

      items.push({
        boid,
        name,
        href,
        image: imageMatch?.[1] ? String(imageMatch[1]) : null,
        price,
        currency,
      });
    }

    return items;
  }

  private buildStrictColorLabels(colorName?: string) {
    const labels = new Set<string>();
    const base = this.normalizeText(colorName);
    if (!base) return labels;

    labels.add(base);
    (this.STRICT_COLOR_EQUIVALENTS[base] || [])
      .map((entry) => this.normalizeText(entry))
      .filter((entry) => entry.length > 0)
      .forEach((entry) => labels.add(entry));

    if (base.includes(' gray')) {
      labels.add(base.replace(/ gray/g, ' grey'));
    }
    if (base.includes(' grey')) {
      labels.add(base.replace(/ grey/g, ' gray'));
    }

    return labels;
  }

  private hasColorMatch(text: string, strictColorLabels: Set<string>) {
    if (strictColorLabels.size === 0) return false;
    const normalizedText = this.normalizeText(text);
    return Array.from(strictColorLabels.values()).some((label) =>
      this.hasWholeToken(normalizedText, label),
    );
  }

  private hasAnyColorSignal(text: string) {
    const normalizedText = this.normalizeText(text);
    return this.COLOR_TOKENS.some((token) =>
      this.hasWholeToken(normalizedText, token),
    );
  }

  private extractPartDimensions(partName?: string) {
    const normalized = this.normalize(partName || '');
    const matches = normalized.match(/\d+\s*x\s*\d+/g) || [];
    return Array.from(new Set(matches.map((value) => value.replace(/\s+/g, ''))));
  }

  private buildRequestedIds(ids: string[], designId?: string) {
    const primaryDesignId = this.normalizeRequestedId(designId || '');
    const scored = new Map<string, number>();
    const add = (rawValue: unknown, score: number) => {
      const normalized = this.normalizeRequestedId(rawValue);
      if (!normalized) return;
      const existing = scored.get(normalized);
      if (existing === undefined || score > existing) {
        scored.set(normalized, score);
      }
    };

    if (primaryDesignId) {
      add(primaryDesignId, 10_000);
    }

    ids.forEach((id, index) => {
      const normalized = this.normalizeRequestedId(id);
      if (!normalized) return;

      let score = 4_000 - index * 4;
      if (/^\d{3,7}$/i.test(normalized)) score += 180;
      else if (/^[a-z]{1,3}\d{2,8}$/i.test(normalized)) score += 140;
      else if (/^\d{3,6}pb\d{1,5}$/i.test(normalized)) score += 100;

      if (primaryDesignId && normalized === primaryDesignId) {
        score += 900;
      }

      add(normalized, score);
    });

    return Array.from(scored.entries())
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        if (a[0].length !== b[0].length) return a[0].length - b[0].length;
        return a[0].localeCompare(b[0]);
      })
      .map(([value]) => value)
      .slice(0, 12);
  }

  private buildSearchQueries(
    requestedIds: string[],
    designId: string | undefined,
    partName: string | undefined,
    colorName: string | undefined,
  ): BrickowlSearchQuery[] {
    const normalizedPartName = this.normalize(partName || '')
      .replace(/(\d)\s*x\s*(\d)/g, '$1 x $2')
      .replace(/\s+/g, ' ')
      .trim();
    const normalizedColor = this.normalizeText(colorName || '').trim();
    const prioritizedIds = Array.from(
      new Set([
        this.normalizeRequestedId(designId || ''),
        ...requestedIds.map((entry) => this.normalizeRequestedId(entry)),
      ]),
    ).filter((entry) => entry.length > 0);

    const descriptors: BrickowlSearchQuery[] = [];
    const push = (
      phrase: string,
      sourceTier: number,
      queryContainsColor: boolean,
      queryContainsPartName: boolean,
    ) => {
      const normalizedPhrase = phrase.replace(/\s+/g, ' ').trim();
      if (!normalizedPhrase) return;
      if (descriptors.some((entry) => entry.phrase === normalizedPhrase)) {
        return;
      }
      descriptors.push({
        phrase: normalizedPhrase,
        sourceTier,
        queryContainsColor,
        queryContainsPartName,
      });
    };

    prioritizedIds.slice(0, 3).forEach((id, index) => {
      const idTierBoost = Math.max(0, 2 - index) * 2;
      const baseTier = 7 + idTierBoost;
      const base = `lego ${id}`;

      if (normalizedPartName && normalizedColor) {
        push(`${base} ${normalizedPartName} ${normalizedColor}`, baseTier + 2, true, true);
      }
      if (normalizedPartName) {
        push(`${base} ${normalizedPartName}`, baseTier + 1, false, true);
      }
      if (normalizedColor) {
        push(`${base} ${normalizedColor}`, baseTier, true, false);
      }
      push(base, baseTier - 1, false, false);
    });

    if (normalizedPartName && normalizedColor) {
      push(`lego ${normalizedPartName} ${normalizedColor}`, 5, true, true);
    }
    if (normalizedPartName) {
      push(`lego ${normalizedPartName}`, 4, false, true);
    }

    return descriptors.slice(0, this.getMaxSearchQueries());
  }

  private async fetchCatalogItemsForPhrase(phrase: string) {
    const searchUrl = `${this.baseUrl}/search/catalog?query=${encodeURIComponent(
      phrase,
    )}&cat=1`;
    const data = await this.guardedGetText(
      searchUrl,
      this.buildBrowserHtmlHeaders(),
      'catalog-search',
    );

    return this.parseCatalogItems(String(data || ''));
  }

  private pickColorFilterId(
    colorFilters: Array<{ id: string; name: string }>,
    strictColorLabels: Set<string>,
  ) {
    if (strictColorLabels.size === 0) {
      return null;
    }

    const normalizedByEntry = colorFilters.map((entry) => ({
      ...entry,
      normalizedName: this.normalizeText(entry.name),
    }));

    const exact = normalizedByEntry.find((entry) =>
      strictColorLabels.has(entry.normalizedName),
    );
    if (exact) {
      return exact;
    }

    const compatible = normalizedByEntry.find((entry) =>
      this.hasColorMatch(entry.name, strictColorLabels),
    );
    return compatible || null;
  }

  private parseItemContext(pageHtml: string, pageUrl: string): BrickowlItemContext | null {
    const tokenMatch = pageHtml.match(/"token":"([^"]+)"/i);
    const itemIdMatch = pageHtml.match(/"item_id":"(\d+)"/i);

    const token = tokenMatch?.[1] ? String(tokenMatch[1]) : '';
    const itemId = itemIdMatch?.[1] ? String(itemIdMatch[1]) : '';
    if (!token || !itemId) {
      return null;
    }

    const titleMatch = pageHtml.match(/<h1 id="page-title"[^>]*>([\s\S]*?)<\/h1>/i);
    const itemName = this.stripHtml(titleMatch?.[1] || '');

    const colorFilters: Array<{ id: string; name: string }> = [];
    const colorRegex =
      /<div class="button filter\s+filter-color[^"]*"[^>]*data-color="([^"]+)"[^>]*>\s*([\s\S]*?)\s*<\/div>/gi;
    let colorMatch: RegExpExecArray | null;
    while ((colorMatch = colorRegex.exec(pageHtml))) {
      const colorId = String(colorMatch[1] || '').trim();
      const colorName = this.stripHtml(String(colorMatch[2] || ''));
      if (!colorId || !colorName) continue;

      colorFilters.push({
        id: colorId,
        name: colorName,
      });
    }

    return {
      itemId,
      token,
      pageUrl,
      itemName,
      colorFilters,
    };
  }

  private scoreCatalogCandidate(
    item: BrickowlCatalogItem,
    requestedIds: string[],
    dimensions: string[],
    strictColorLabels: Set<string>,
    hasColor: boolean,
  ) {
    const normalizedName = this.normalizeText(item.name);
    const idMatchScore = requestedIds.reduce((best, requestedId) => {
      const normalizedId = this.normalizeText(requestedId);
      if (!normalizedId) return best;
      if (item.boid && normalizedId === this.normalizeText(item.boid)) {
        return Math.max(best, 2400);
      }
      if (this.hasWholeToken(normalizedName, normalizedId)) {
        return Math.max(best, 1700);
      }
      if (normalizedName.includes(normalizedId)) {
        return Math.max(best, 1000);
      }
      return best;
    }, 0);

    if (idMatchScore <= 0) {
      return {
        score: -9999,
        matchedRequestedColor: false,
      };
    }

    const dimensionHits = dimensions.filter((dim) =>
      normalizedName.includes(dim),
    ).length;
    const dimensionScore =
      dimensions.length > 0
        ? dimensionHits > 0
          ? dimensionHits * 280
          : -320
        : 0;

    const matchedRequestedColor =
      !hasColor || this.hasColorMatch(item.name, strictColorLabels);
    const colorConflict =
      hasColor && !matchedRequestedColor && this.hasAnyColorSignal(item.name);
    if (colorConflict) {
      return {
        score: -9999,
        matchedRequestedColor: false,
      };
    }

    const decoratedPenalty =
      this.hasWholeToken(normalizedName, 'sticker') ||
      this.hasWholeToken(normalizedName, 'pattern') ||
      this.hasWholeToken(normalizedName, 'print') ||
      this.hasWholeToken(normalizedName, 'with')
        ? 380
        : 0;

    return {
      score:
        1300 +
        idMatchScore +
        dimensionScore +
        (matchedRequestedColor ? 640 : 0) -
        decoratedPenalty,
      matchedRequestedColor,
    };
  }

  private buildDtBuyUrl(
    context: BrickowlItemContext,
    colorFilterId: string | null,
    start: number,
    length: number,
  ) {
    const params = new URLSearchParams();
    params.set('item_id', context.itemId);
    params.set('token', context.token);
    params.set('iDisplayStart', String(Math.max(0, start)));
    params.set('iDisplayLength', String(Math.max(1, length)));
    params.set('sEcho', '1');
    params.set('sSortDir_0', 'asc');
    if (colorFilterId) {
      params.set('col', colorFilterId);
    }

    return `${this.baseUrl}/ajax/dt_buy?${params.toString()}`;
  }

  private parseDtBuyPayload(rawData: unknown) {
    if (rawData && typeof rawData === 'object') {
      return rawData as any;
    }

    const text = String(rawData || '').trim();
    if (!text) return {};

    try {
      return JSON.parse(text);
    } catch {
      const cleaned = text
        .replace(/^\)\]\}',?\s*/g, '')
        .replace(/^[^{[]+/, '')
        .trim();
      if (!cleaned) return {};
      try {
        return JSON.parse(cleaned);
      } catch {
        return {};
      }
    }
  }

  private extractDtBuyTotalCount(payload: any) {
    const candidates = [
      parsePositiveInteger(payload?.recordsTotal, 1, 100_000),
      parsePositiveInteger(payload?.iTotalRecords, 1, 100_000),
      parsePositiveInteger(payload?.recordsFiltered, 1, 100_000),
      parsePositiveInteger(payload?.iTotalDisplayRecords, 1, 100_000),
    ].filter((value): value is number => value !== null);

    if (candidates.length === 0) {
      return null;
    }

    return Math.max(...candidates);
  }

  private async fetchDtBuyRows(
    context: BrickowlItemContext,
    colorFilterId: string | null,
    refererUrl: string,
  ) {
    const pageSize = this.getDtBuyPageSize();
    const maxRows = this.getDtBuyMaxRows();
    const rows: any[] = [];
    let start = 0;
    let knownTotal: number | null = null;

    while (start < maxRows) {
      const dtBuyUrl = this.buildDtBuyUrl(
        context,
        colorFilterId,
        start,
        pageSize,
      );
      const dtData = await this.guardedGetText(
        dtBuyUrl,
        this.buildBrowserHtmlHeaders({
          Accept: 'application/json, text/javascript, */*; q=0.01',
          Referer: refererUrl,
          'X-Requested-With': 'XMLHttpRequest',
        }),
        'dt-buy',
      );

      const payload = this.parseDtBuyPayload(dtData);
      const pageRows = Array.isArray(payload?.aaData) ? payload.aaData : [];
      if (pageRows.length === 0) {
        break;
      }

      rows.push(...pageRows);
      knownTotal = this.extractDtBuyTotalCount(payload) || knownTotal;
      start += pageRows.length;

      if (pageRows.length < pageSize) {
        break;
      }
      if (knownTotal !== null && start >= knownTotal) {
        break;
      }
      if (rows.length >= maxRows) {
        break;
      }
    }

    return rows.slice(0, maxRows);
  }

  private parseShippingFromSellerCell(sellerCellHtml: string) {
    const normalizedSellerCell = String(sellerCellHtml || '');
    if (/Request a Shipping Quote/i.test(normalizedSellerCell)) {
      return {
        value: 0,
        known: false,
      };
    }

    const shippingLabelMatch = normalizedSellerCell.match(
      /Shipping(?:&nbsp;|\s)*[\s\S]{0,180}?<span[^>]*>([\d.,\s]+)<\/span>/i,
    );
    if (!shippingLabelMatch?.[1]) {
      return {
        value: 0,
        known: false,
      };
    }

    return {
      value: this.parsePrice(shippingLabelMatch[1]),
      known: /\d/.test(String(shippingLabelMatch[1] || '')),
    };
  }

  private parseSellerName(sellerCellHtml: string) {
    const preferred = String(sellerCellHtml || '').match(
      /<span class=['"]after-flag['"]>\s*<a[^>]*>([\s\S]*?)<\/a>/i,
    );
    if (preferred?.[1]) {
      return this.stripHtml(preferred[1]);
    }

    const fallback = String(sellerCellHtml || '').match(/<a[^>]*>([\s\S]*?)<\/a>/i);
    return fallback?.[1] ? this.stripHtml(fallback[1]) : null;
  }

  private parseSellerUrl(sellerCellHtml: string) {
    const preferred = String(sellerCellHtml || '').match(
      /<span class=['"]after-flag['"]>\s*<a[^>]*href="([^"]+)"/i,
    );
    if (preferred?.[1]) {
      return this.toAbsoluteUrl(preferred[1]);
    }

    const fallback = this.extractFirstHref(sellerCellHtml);
    return this.toAbsoluteUrl(fallback);
  }

  private parseSellerId(sellerCellHtml: string, sellerUrl: string | null) {
    const userMatch = String(sellerCellHtml || '').match(/\/user\/(\d+)/i);
    if (userMatch?.[1]) {
      return `brickowl-user-${userMatch[1]}`;
    }

    if (sellerUrl) {
      const storeMatch = sellerUrl.match(/https?:\/\/([a-z0-9-]+)\.brickowl\.com/i);
      if (storeMatch?.[1]) {
        return `brickowl-store-${storeMatch[1].toLowerCase()}`;
      }
    }

    return null;
  }

  private parseCountryDetails(sellerCellHtml: string) {
    const sellerCell = String(sellerCellHtml || '');
    const countryNameMatch = sellerCell.match(/alt="([^"]+)"/i);
    const countryName = countryNameMatch?.[1]
      ? this.decodeEntities(countryNameMatch[1]).trim()
      : null;

    const flagMatch = sellerCell.match(/src="([^"]*\/flg\/24\/([A-Z]{2})\.png)"/i);
    const sellerCountryFlagUrl = flagMatch?.[1]
      ? this.toAbsoluteUrl(this.decodeEntities(flagMatch[1]))
      : null;
    const sellerCountryCode = flagMatch?.[2] ? String(flagMatch[2]).toUpperCase() : null;

    return {
      sellerCountry: countryName,
      sellerCountryCode,
      sellerCountryFlagUrl,
    };
  }

  private parseSellerFeedbackPercent(sellerCellHtml: string): number | null {
    const sellerCell = this.decodeEntities(String(sellerCellHtml || ''));
    if (!sellerCell) return null;

    const contextualMatch = sellerCell.match(
      /(feedback|rating|positive|opinia|opinie|ocen)[\s\S]{0,40}?(\d{1,3}(?:[.,]\d+)?)\s*%/i,
    );
    const fallbackMatch = sellerCell.match(/(\d{1,3}(?:[.,]\d+)?)\s*%/i);
    const raw = contextualMatch?.[2] || fallbackMatch?.[1] || null;
    if (!raw) return null;

    const parsed = Number.parseFloat(String(raw).replace(',', '.'));
    if (!Number.isFinite(parsed)) return null;
    return Math.max(0, Math.min(100, parsed));
  }

  private parseSellerFeedbackScore(sellerCellHtml: string): number | null {
    const sellerCell = this.decodeEntities(String(sellerCellHtml || ''));
    if (!sellerCell) return null;

    const scoreMatch = sellerCell.match(
      /(feedback|rating|opinia|opinie|ocen)[\s\S]{0,40}?(\d[\d\s,.]{0,10})/i,
    );
    const raw = scoreMatch?.[2] ? String(scoreMatch[2]) : '';
    if (!raw) return null;

    const normalized = raw.replace(/[^\d]/g, '');
    if (!normalized) return null;
    const parsed = Number.parseInt(normalized, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  private hasMissingShippingPrice(offer: any): boolean {
    return Boolean(offer?.shippingMissingPrice);
  }

  private compareOffers(a: any, b: any): number {
    const shippingMissingDiff =
      Number(this.hasMissingShippingPrice(a)) - Number(this.hasMissingShippingPrice(b));
    if (shippingMissingDiff !== 0) {
      return shippingMissingDiff;
    }

    const aHybrid = Number.isFinite(Number(a?.hybridScore))
      ? Number(a.hybridScore)
      : this.computeHybridScore(a);
    const bHybrid = Number.isFinite(Number(b?.hybridScore))
      ? Number(b.hybridScore)
      : this.computeHybridScore(b);
    const hybridDiff = aHybrid - bHybrid;
    if (hybridDiff !== 0) {
      return hybridDiff;
    }

    if ((b?.precisionRank || 0) !== (a?.precisionRank || 0)) {
      return (b?.precisionRank || 0) - (a?.precisionRank || 0);
    }

    const effectivePriceDiff =
      this.resolveEffectiveUnitPrice(a) - this.resolveEffectiveUnitPrice(b);
    if (effectivePriceDiff !== 0) {
      return effectivePriceDiff;
    }

    return this.parsePrice(String(a?.price || '0')) - this.parsePrice(String(b?.price || '0'));
  }

  private extractListingId(url: string | null) {
    const match = String(url || '').match(/#(\d+)\s*$/);
    return match?.[1] ? String(match[1]) : null;
  }

  private async fetchMarketOffersForCatalogItem(
    item: BrickowlCatalogItem,
    requestedIds: string[],
    colorName: string | undefined,
    strictColorLabels: Set<string>,
    hasColor: boolean,
    dimensions: string[],
    rankBonus: number,
    designId?: string,
    queryContainsPartName = false,
    queryContainsColor = false,
  ) {
    const pageUrl = this.toAbsoluteUrl(item.href);
    if (!pageUrl) return [];

    const pageHtml = await this.guardedGetText(
      pageUrl,
      this.buildBrowserHtmlHeaders(),
      'item-page',
    );
    const context = this.parseItemContext(pageHtml, pageUrl);
    if (!context) return [];

    const selectedColorFilter = this.pickColorFilterId(
      context.colorFilters,
      strictColorLabels,
    );
    if (hasColor && !selectedColorFilter) {
      return [];
    }

    const rows = await this.fetchDtBuyRows(
      context,
      selectedColorFilter?.id || null,
      pageUrl,
    );
    const normalizedDesignId = this.normalizeText(designId || '');
    const offers = rows
      .map((row: any) => {
        if (!Array.isArray(row) || row.length < 7) return null;

        const offerUrl = this.toAbsoluteUrl(
          this.extractFirstHref(String(row[2] || '')) ||
            this.extractFirstHref(String(row[0] || '')),
        );
        if (!offerUrl) return null;

        const thumbnail = this.toAbsoluteUrl(this.extractFirstImageSrc(String(row[0] || '')));
        const offerName = this.stripHtml(String(row[2] || '')) || context.itemName || item.name;
        const offerPrice = this.parsePrice(String(row[4] || ''));
        if (offerPrice <= 0) return null;

        const currency = this.parseCurrency(String(row[4] || row[5] || ''));
        const shippingCellRaw = String(row[5] || '');
        const shippingCellPlain = this.stripHtml(shippingCellRaw).trim();
        const columnHasShippingPrice =
          /\d/.test(shippingCellPlain) && !/^n\/?a$/i.test(shippingCellPlain);

        let delivery = columnHasShippingPrice ? this.parsePrice(shippingCellRaw) : 0;
        let shippingMissingPrice = !columnHasShippingPrice;
        if (shippingMissingPrice) {
          const shippingFromSellerCell = this.parseShippingFromSellerCell(String(row[6] || ''));
          if (shippingFromSellerCell.known) {
            delivery = shippingFromSellerCell.value;
            shippingMissingPrice = false;
          }
        }

        const sellerCell = String(row[6] || '');
        const sellerLogin = this.parseSellerName(sellerCell);
        const sellerUrl = this.parseSellerUrl(sellerCell);
        const sellerId = this.parseSellerId(sellerCell, sellerUrl);
        const sellerFeedbackPercent = this.parseSellerFeedbackPercent(sellerCell);
        const sellerFeedbackScore = this.parseSellerFeedbackScore(sellerCell);
        const {
          sellerCountry,
          sellerCountryCode,
          sellerCountryFlagUrl,
        } = this.parseCountryDetails(sellerCell);

        const listingId = this.extractListingId(offerUrl);
        const availableQty = Number.parseInt(this.stripHtml(String(row[3] || '')), 10);
        const condition = this.stripHtml(String(row[1] || ''));
        const normalizedName = this.normalizeText(offerName);
        if (
          normalizedDesignId &&
          !normalizedDesignId.includes('pb') &&
          new RegExp(
            `(^|[^a-z0-9])${this.escapeRegex(normalizedDesignId)}\\s*pb\\d+([^a-z0-9]|$)`,
            'i',
          ).test(normalizedName)
        ) {
          return null;
        }
        const unitQuantity =
          extractPackQuantityFromText(`${offerName} ${condition}`) || 1;
        const availableOfferUnits = parsePositiveInteger(
          availableQty,
          1,
          1_000_000,
        );

        const idMatchScore = requestedIds.reduce((best, requestedId) => {
          const normalizedId = this.normalizeText(requestedId);
          if (!normalizedId) return best;
          if (this.hasWholeToken(normalizedName, normalizedId)) {
            return Math.max(best, 1700);
          }
          if (normalizedName.includes(normalizedId)) {
            return Math.max(best, 1000);
          }
          if (item.boid && normalizedId === this.normalizeText(item.boid)) {
            return Math.max(best, 2400);
          }
          return best;
        }, 0);

        if (idMatchScore <= 0) return null;

        const dimensionHits = dimensions.filter((dim) =>
          normalizedName.includes(dim),
        ).length;
        const dimensionScore =
          dimensions.length > 0
            ? dimensionHits > 0
              ? dimensionHits * 260
              : -260
            : 0;

        const matchedRequestedColor =
          !hasColor ||
          Boolean(selectedColorFilter) ||
          this.hasColorMatch(`${offerName} ${condition}`, strictColorLabels);
        const colorConflict =
          hasColor &&
          !matchedRequestedColor &&
          this.hasAnyColorSignal(`${offerName} ${condition}`);
        if (colorConflict) {
          return null;
        }

        const fallbackId = `${sellerId || 'brickowl'}-${this.normalizeText(offerName).slice(0, 42)}-${offerPrice.toFixed(3)}`;

        return this.withHybridScore({
          id: listingId ? `brickowl-${listingId}` : fallbackId,
          name: offerName,
          price: offerPrice.toFixed(3),
          currency,
          url: offerUrl,
          thumbnail: thumbnail || item.image,
          sellerId,
          sellerLogin: sellerLogin || 'BrickOwl Seller',
          sellerFeedbackPercent,
          sellerFeedbackScore,
          sellerReviewsCount: sellerFeedbackScore,
          sellerCountry,
          sellerCountryCode,
          sellerCountryFlagUrl,
          deliveryLowestPrice: delivery.toFixed(2),
          deliveryCurrency: currency,
          shippingMissingPrice,
          offerUnitQuantity: unitQuantity,
          offerUnitQuantitySource: unitQuantity > 1 ? 'brickowl-title' : 'default',
          availableOfferUnits,
          availablePieceQuantity:
            availableOfferUnits !== null ? availableOfferUnits * unitQuantity : null,
          requestedColorName: colorName || null,
          color: selectedColorFilter?.name || (matchedRequestedColor ? colorName || null : null),
          matchedRequestedColor,
          matchedByColorParameter: Boolean(selectedColorFilter),
          colorFilterName: selectedColorFilter?.name || null,
          colorConflict: false,
          colorMatchScore: matchedRequestedColor ? 4 : 0,
          precisionRank:
            1500 +
            rankBonus +
            idMatchScore +
            dimensionScore +
            (matchedRequestedColor ? 600 : 0) +
            (availableQty > 0 ? 5 : 0),
          matchSource: selectedColorFilter
            ? 'brickowl-dt_buy-color'
            : 'brickowl-dt_buy',
          queryContainsColor: queryContainsColor || Boolean(colorName),
          queryContainsPartName: queryContainsPartName,
          provider: 'brickowl',
          providerLabel: 'BrickOwl',
          isEstimated: false,
        });
      })
      .filter((entry): entry is any => Boolean(entry));

    return offers;
  }

  async findOffersByExternalIds(
    ids: string[],
    colorName?: string,
    designId?: string,
    partName?: string,
  ) {
    if (!this.isEnabled()) {
      return [];
    }

    if (!this.isConfigured()) {
      if (!this.complianceWarningLogged) {
        this.complianceWarningLogged = true;
        this.logger.warn(
          'BrickOwl provider jest wyłączony przez konfigurację. Ustaw BRICKOWL_ALLOW_UNOFFICIAL_SCRAPING=true, aby włączyć pobieranie ofert.',
        );
      }
      return [];
    }

    const blockRemainingMs = this.getBlockRemainingMs();
    if (blockRemainingMs > 0) {
      return [];
    }
    if ((await this.trafficGuard.getCooldownRemainingMs('brickowl')) > 0) {
      return [];
    }

    const requestedIds = this.buildRequestedIds(ids, designId);
    if (requestedIds.length === 0) {
      return [];
    }

    const strictColorLabels = this.buildStrictColorLabels(colorName);
    const hasColor = strictColorLabels.size > 0;
    const dimensions = this.extractPartDimensions(partName);
    const searchQueries = this.buildSearchQueries(
      requestedIds,
      designId,
      partName,
      colorName,
    );
    if (searchQueries.length === 0) {
      return [];
    }

    try {
      const candidateByKey = new Map<
        string,
        { item: BrickowlCatalogItem; score: number; query: BrickowlSearchQuery }
      >();

      for (let queryIndex = 0; queryIndex < searchQueries.length; queryIndex += 1) {
        const query = searchQueries[queryIndex];
        const catalogItems = await this.fetchCatalogItemsForPhrase(query.phrase);

        catalogItems.forEach((item) => {
          const scoring = this.scoreCatalogCandidate(
            item,
            requestedIds,
            dimensions,
            strictColorLabels,
            hasColor,
          );
          if (scoring.score <= 0) return;

          const weightedScore =
            scoring.score + query.sourceTier * 180 - queryIndex * 35;
          const key = `${this.normalizeRequestedId(item.boid)}|${String(item.href || '').trim()}`;
          const existing = candidateByKey.get(key);
          if (!existing || weightedScore > existing.score) {
            candidateByKey.set(key, {
              item,
              score: weightedScore,
              query,
            });
          }
        });
      }

      const scoredCandidates = Array.from(candidateByKey.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, this.getMaxCatalogCandidates());

      if (scoredCandidates.length === 0) {
        return [];
      }

      const detailCandidates = scoredCandidates.slice(0, this.getMaxDetailRequests());
      const offersByCandidate: any[][] = [];
      for (const [index, entry] of detailCandidates.entries()) {
        const offers = await this.fetchMarketOffersForCatalogItem(
          entry.item,
          requestedIds,
          colorName,
          strictColorLabels,
          hasColor,
          dimensions,
          entry.score + (detailCandidates.length - index) * 90,
          designId,
          entry.query.queryContainsPartName,
          entry.query.queryContainsColor,
        );
        offersByCandidate.push(offers);
      }

      const dedup = new Map<string, any>();
      offersByCandidate.flat().forEach((offer) => {
        const key = `${String(offer.id || '')}:${String(offer.url || '')}`;
        if (!key || key === ':') return;

        const existing = dedup.get(key);
        if (!existing) {
          dedup.set(key, offer);
          return;
        }

        if (this.compareOffers(offer, existing) < 0) {
          dedup.set(key, offer);
        }
      });

      return Array.from(dedup.values())
        .map((offer) => this.withHybridScore(offer))
        .sort((a, b) => this.compareOffers(a, b))
        .slice(0, this.getFinalOfferLimit());
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      this.noteProviderBlockFromError(error);
      this.logger.warn(
        `BrickOwl fetch failed [HTTP ${status || 'n/a'}]: ${String(
          error?.message || 'Unknown error',
        )}`,
      );
      throw error;
    }
  }
}
