import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { OfferSourceDescriptor } from './offer-sources.types';
import {
  extractPackQuantityFromParameters,
  extractPackQuantityFromText,
  parsePositiveInteger,
} from './offer-quantity.utils';
import { ProviderTrafficGuardService } from './provider-traffic-guard.service';

interface ColorValueMatch {
  valueId: string;
  valueName: string;
  valueScore: number;
  count: number;
}

interface ColorFilterCandidate {
  filterId: string;
  filterName: string;
  filterPriority: number;
  valueMatches: ColorValueMatch[];
}

interface SearchQueryDescriptor {
  phrase: string;
  sourceTier: number;
  queryContainsColor: boolean;
  queryContainsPartName: boolean;
}

interface OfferColorAnalysis {
  colorMatchScore: number;
  colorScore: number;
  colorConflict: boolean;
  matchedRequestedColor: boolean;
  detectedColorGroups: number[];
}

interface AllegroApiErrorDetails {
  status: number | null;
  code: string | null;
  message: string;
  userMessage: string | null;
}

interface ProductColorContext {
  manufacturerColorLabels: Set<string>;
  categoryIds: Set<string>;
}

interface AllegroTokenCacheEntry {
  token: string;
  expiresAt: number;
}

interface AllegroListingCacheEntry {
  value: any;
  expiresAt: number;
}

interface AllegroSaleProductsCacheEntry {
  value: any[];
  expiresAt: number;
}

@Injectable()
export class AllegroService {
  private readonly logger = new Logger(AllegroService.name);
  private readonly defaultMarketplaceId = 'allegro-pl';
  private tokenCache: AllegroTokenCacheEntry | null = null;
  private tokenInFlight: Promise<string> | null = null;
  private readonly listingCache = new Map<string, AllegroListingCacheEntry>();
  private readonly listingInFlight = new Map<string, Promise<any>>();
  private readonly saleProductsCache = new Map<string, AllegroSaleProductsCacheEntry>();
  private readonly saleProductsInFlight = new Map<string, Promise<any[]>>();
  private listingRequestChain: Promise<void> = Promise.resolve();
  private lastListingRequestAt = 0;
  private blockedUntilMs = 0;

  private readonly COLOR_KEYWORDS = [
    'bialy',
    'biały',
    'black',
    'blue',
    'brown',
    'czarny',
    'czarna',
    'czarne',
    'czarnych',
    'czarnej',
    'czarnym',
    'czarną',
    'czarni',
    'czerwony',
    'dark bluish gray',
    'dark gray',
    'green',
    'grey',
    'jasnoszary',
    'light bluish gray',
    'light gray',
    'niebieski',
    'orange',
    'pomaranczowy',
    'pomarańczowy',
    'red',
    'szary',
    'tan',
    'white',
    'yellow',
    'zielony',
    'zolty',
    'żółty',
  ];

  private readonly COLOR_ALIASES: Record<string, string[]> = {
    black: [
      'czarny',
      'czarna',
      'czarne',
      'czarni',
      'czarnych',
      'czarnej',
      'czarnym',
      'czarną',
    ],
    white: ['bialy', 'biały'],
    red: ['czerwony'],
    blue: ['niebieski'],
    green: ['zielony'],
    yellow: ['zolty', 'żółty'],
    orange: ['pomaranczowy', 'pomarańczowy'],
    brown: ['brazowy', 'brązowy'],
    grey: ['gray', 'szary'],
    gray: ['grey', 'szary'],
    'dark bluish gray': ['ciemnoszary', 'dark gray', 'ciemny szary'],
    'light bluish gray': ['jasnoszary', 'light gray', 'jasny szary'],
    tan: ['bezowy', 'beżowy', 'piaskowy'],
    dark: ['ciemny'],
    light: ['jasny'],
    trans: ['transparentny', 'przezroczysty'],
    transparent: ['przezroczysty', 'transparentny'],
  };

  private readonly STRICT_COLOR_EQUIVALENTS: Record<string, string[]> = {
    black: [
      'czarny',
      'czarna',
      'czarne',
      'czarni',
      'czarnych',
      'czarnej',
      'czarnym',
      'czarną',
    ],
    white: ['bialy'],
    red: ['czerwony'],
    blue: ['niebieski'],
    green: ['zielony'],
    yellow: ['zolty'],
    orange: ['pomaranczowy'],
    brown: ['brazowy'],
    pink: ['rozowy'],
    purple: ['fioletowy'],
    gray: ['grey', 'szary'],
    grey: ['gray', 'szary'],
    tan: ['bezowy', 'piaskowy'],
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
  };

  private readonly COLOR_GROUPS: string[][] = [
    [
      'black',
      'czarny',
      'czarna',
      'czarne',
      'czarni',
      'czarnych',
      'czarnej',
      'czarnym',
      'czarną',
    ],
    ['white', 'bialy', 'biały'],
    ['red', 'czerwony'],
    ['blue', 'niebieski'],
    ['green', 'zielony'],
    ['yellow', 'zolty', 'żółty'],
    ['orange', 'pomaranczowy', 'pomarańczowy'],
    ['brown', 'brazowy', 'brązowy'],
    ['grey', 'gray', 'szary'],
    [
      'dark bluish gray',
      'dark bluish grey',
      'dark gray',
      'dark grey',
      'ciemnoszary',
      'ciemny szary',
      'dark stone grey',
      'dark stone gray',
    ],
    [
      'light bluish gray',
      'light bluish grey',
      'light gray',
      'light grey',
      'jasnoszary',
      'jasny szary',
      'light stone grey',
      'light stone gray',
    ],
    ['tan', 'bezowy', 'beżowy', 'piaskowy'],
    ['trans', 'transparent', 'transparentny', 'przezroczysty'],
  ];

  private readonly PART_NAME_STOP_WORDS = new Set([
    'lego',
    'part',
    'element',
    'klocek',
    'cegla',
    'cegielka',
    'and',
    'with',
    'without',
    'for',
    'the',
    'a',
    'an',
  ]);

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
    private readonly trafficGuard: ProviderTrafficGuardService,
  ) {}

  private async ensureExternalCallPermit(callType: string, minIntervalMs = 0) {
    const permit = await this.trafficGuard.beforeExternalCall('allegro', callType, {
      minIntervalMs,
    });
    if (permit.allowed) return;

    const reason = permit.reason || 'unknown';
    const waitMs = Math.max(0, Math.floor(permit.waitMs || 0));
    const error = new Error(
      `Allegro provider guard blocked (${reason}${waitMs > 0 ? `/${waitMs}ms` : ''})`,
    );
    (error as any).isProviderGuardBlocked = true;
    (error as any).providerGuardReason = reason;
    throw error;
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
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
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

  private getListingCacheTtlMs() {
    const seconds = this.parseIntegerConfig(
      'ALLEGRO_LISTING_CACHE_TTL_SECONDS',
      45,
      0,
      600,
    );
    return seconds * 1000;
  }

  private getListingCacheMaxEntries() {
    return this.parseIntegerConfig(
      'ALLEGRO_LISTING_CACHE_MAX_ENTRIES',
      800,
      50,
      10000,
    );
  }

  private getListingMinIntervalMs() {
    const base = this.parseIntegerConfig(
      'ALLEGRO_LISTING_MIN_INTERVAL_MS',
      120,
      0,
      5000,
    );
    return this.applyThrottleReduction(base);
  }

  private getCooldownMs() {
    return this.parseIntegerConfig(
      'ALLEGRO_COOLDOWN_MS',
      60_000,
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
    const details = this.extractAllegroErrorDetails(error);
    const status = Number(details.status || 0);
    const retryAfterMs = this.parseRetryAfterMs(error);
    if (status !== 429 && status !== 403 && status !== 503 && retryAfterMs === null) {
      return;
    }
    const cooldownMs = retryAfterMs !== null
      ? Math.max(this.getCooldownMs(), retryAfterMs)
      : this.getCooldownMs();
    this.blockedUntilMs = Date.now() + cooldownMs;
    void this.trafficGuard.noteProviderBlock('allegro', cooldownMs);
  }

  private getListingMaxRetries() {
    return this.parseIntegerConfig(
      'ALLEGRO_LISTING_MAX_RETRIES',
      2,
      0,
      6,
    );
  }

  private getMaxIdProbes(hasPreferredColor: boolean) {
    const fallback = hasPreferredColor ? 2 : 3;
    return this.parseIntegerConfig('ALLEGRO_MAX_ID_PROBES', fallback, 1, 6);
  }

  private getMaxQueryProbes(hasPreferredColor: boolean) {
    const fallback = hasPreferredColor ? 3 : 4;
    return this.parseIntegerConfig('ALLEGRO_MAX_QUERY_PROBES', fallback, 1, 6);
  }

  private getInitialResultsLimit() {
    return this.parseIntegerConfig(
      'ALLEGRO_INITIAL_RESULTS_LIMIT',
      20,
      5,
      40,
    );
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getSaleProductsCacheTtlMs() {
    const seconds = this.parseIntegerConfig(
      'ALLEGRO_SALE_PRODUCTS_CACHE_TTL_SECONDS',
      300,
      0,
      3600,
    );
    return seconds * 1000;
  }

  private getSaleProductsCacheMaxEntries() {
    return this.parseIntegerConfig(
      'ALLEGRO_SALE_PRODUCTS_CACHE_MAX_ENTRIES',
      400,
      50,
      5000,
    );
  }

  private isSandboxColorInferenceEnabled() {
    const raw = this.normalize(
      this.config.get<string>('ALLEGRO_SANDBOX_COLOR_INFERENCE') || '',
    );
    return raw !== 'false' && raw !== '0' && raw !== 'off';
  }

  private isSandboxLooseColorInferenceEnabled() {
    const raw = this.normalize(
      this.config.get<string>('ALLEGRO_SANDBOX_ALLOW_LOOSE_COLOR_INFERENCE') ||
        '',
    );
    return raw === 'true' || raw === '1' || raw === 'on';
  }

  private getEnvironment(): 'sandbox' | 'production' {
    const raw = this.normalize(this.config.get<string>('ALLEGRO_ENV') || '');
    return raw === 'production' || raw === 'prod' ? 'production' : 'sandbox';
  }

  private getApiBaseUrl() {
    return this.getEnvironment() === 'production'
      ? 'https://api.allegro.pl'
      : 'https://api.allegro.pl.allegrosandbox.pl';
  }

  private getAuthBaseUrl() {
    return this.getEnvironment() === 'production'
      ? 'https://allegro.pl'
      : 'https://allegro.pl.allegrosandbox.pl';
  }

  private getOfferBaseUrl() {
    return this.getEnvironment() === 'production'
      ? 'https://allegro.pl/oferta'
      : 'https://allegro.pl.allegrosandbox.pl/oferta';
  }

  private isEnabled() {
    const raw = this.normalize(this.config.get<string>('ALLEGRO_ENABLED') || '');
    return raw !== 'false' && raw !== '0' && raw !== 'off';
  }

  private isConfigured() {
    const clientId = this.config.get<string>('ALLEGRO_CLIENT_ID');
    const clientSecret = this.config.get<string>('ALLEGRO_CLIENT_SECRET');
    return Boolean(clientId && clientSecret);
  }

  getSourceDescriptor(): OfferSourceDescriptor {
    return {
      id: 'allegro',
      label: 'Allegro',
      enabled: this.isEnabled(),
      configured: this.isConfigured(),
      optimizable: true,
      description:
        'Oferty z Allegro z danymi sprzedawcy i kosztami dostawy (najlepsze do optymalizacji koszyka).',
      requiresEnv: ['ALLEGRO_CLIENT_ID', 'ALLEGRO_CLIENT_SECRET'],
      supportsSellerRatingPercentFilter: false,
    };
  }

  private extractAllegroErrorDetails(error: any): AllegroApiErrorDetails {
    const status = Number.isFinite(error?.response?.status)
      ? Number(error.response.status)
      : null;
    const first = Array.isArray(error?.response?.data?.errors)
      ? error.response.data.errors[0]
      : null;

    return {
      status,
      code: first?.code ? String(first.code) : null,
      message: first?.message
        ? String(first.message)
        : String(error?.message || 'Unknown Allegro API error'),
      userMessage: first?.userMessage ? String(first.userMessage) : null,
    };
  }

  private isVerificationRequiredError(error: any) {
    const details = this.extractAllegroErrorDetails(error);
    return details.status === 403 && details.code === 'VerificationRequired';
  }

  private isAccessDeniedListingError(error: any) {
    const details = this.extractAllegroErrorDetails(error);
    if (details.status !== 403) return false;
    if (details.code === 'AccessDenied' || details.code === 'VerificationRequired') {
      return true;
    }
    const normalizedMessage = this.normalize(
      `${details.message || ''} ${details.userMessage || ''}`,
    );
    return (
      normalizedMessage.includes('access is denied') ||
      normalizedMessage.includes('brak dostepu') ||
      normalizedMessage.includes('brak dostępu')
    );
  }

  private normalize(text?: string) {
    return (text || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  private asTokens(text: string) {
    return text
      .split(/[\s/-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3);
  }

  private normalizeColorLabel(value?: string) {
    return this.normalize(value || '')
      .replace(/\blego\b/g, ' ')
      .replace(/[^a-z0-9\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private hasStrictColorLabelMatchInText(
    text: string | undefined | null,
    strictColorLabels: Set<string>,
  ) {
    if (!text || strictColorLabels.size === 0) return false;
    const normalizedText = this.normalizeColorLabel(text);
    return Array.from(strictColorLabels.values()).some((label) =>
      this.containsColorAlias(normalizedText, label),
    );
  }

  private decodeUrlComponentSafe(value: string) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  private normalizeImageUrlForColorMatch(url?: string | null) {
    const decoded = this.decodeUrlComponentSafe(String(url || ''));
    return this.normalizeColorLabel(
      decoded
        .replace(/https?:\/\//gi, ' ')
        .replace(/[_\-./?=&]+/g, ' ')
        .replace(/\d+x\d+/gi, ' ')
        .trim(),
    );
  }

  private hasStrictColorLabelMatchInImageUrls(
    images: unknown,
    strictColorLabels: Set<string>,
  ) {
    if (!Array.isArray(images) || strictColorLabels.size === 0) return false;

    return images.some((entry: any) => {
      const url =
        typeof entry === 'string'
          ? entry
          : typeof entry?.url === 'string'
            ? entry.url
            : '';
      if (!url) return false;

      const normalizedUrl = this.normalizeImageUrlForColorMatch(url);
      if (!normalizedUrl) return false;

      return Array.from(strictColorLabels.values()).some((label) =>
        this.containsColorAlias(normalizedUrl, label),
      );
    });
  }

  private buildStrictColorLabels(colorName?: string) {
    const strictLabels = new Set<string>();
    const base = this.normalizeColorLabel(colorName);
    if (!base) return strictLabels;

    strictLabels.add(base);

    const knownEquivalents = this.STRICT_COLOR_EQUIVALENTS[base] || [];
    knownEquivalents
      .map((entry) => this.normalizeColorLabel(entry))
      .filter((entry) => entry.length > 0)
      .forEach((entry) => strictLabels.add(entry));

    if (base.includes(' gray')) {
      strictLabels.add(
        this.normalizeColorLabel(base.replace(/ gray/g, ' grey')),
      );
    }
    if (base.includes(' grey')) {
      strictLabels.add(
        this.normalizeColorLabel(base.replace(/ grey/g, ' gray')),
      );
    }

    return strictLabels;
  }

  private buildColorTerms(colorName?: string) {
    if (!colorName) return [];

    const normalizedColor = this.normalize(colorName);
    const terms = new Set<string>([colorName, normalizedColor]);

    this.asTokens(normalizedColor).forEach((token) => terms.add(token));

    Object.entries(this.COLOR_ALIASES).forEach(([aliasKey, aliasValues]) => {
      if (
        normalizedColor.includes(aliasKey) ||
        aliasKey.includes(normalizedColor)
      ) {
        terms.add(aliasKey);
        aliasValues.forEach((alias) => terms.add(alias));
      }
    });

    for (const keyword of this.COLOR_KEYWORDS) {
      if (normalizedColor.includes(keyword)) {
        terms.add(keyword);
      }
    }

    this.COLOR_GROUPS.forEach((group) => {
      const hasMatch = group.some(
        (alias) =>
          normalizedColor.includes(alias) || alias.includes(normalizedColor),
      );

      if (hasMatch) {
        group.forEach((alias) => terms.add(alias));
      }
    });

    return Array.from(terms).filter((term) => term.length > 0);
  }

  private escapeRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private hasWholeToken(text: string, token: string) {
    const normalizedText = this.normalize(text);
    const normalizedToken = this.normalize(token);
    if (!normalizedText || !normalizedToken) return false;

    const regex = new RegExp(
      `(^|[^a-z0-9])${this.escapeRegex(normalizedToken)}([^a-z0-9]|$)`,
      'i',
    );
    return regex.test(normalizedText);
  }

  private containsColorAlias(normalizedText: string, alias: string) {
    const normalizedAlias = this.normalize(alias);
    if (!normalizedText || !normalizedAlias) return false;

    if (normalizedAlias.includes(' ')) {
      return normalizedText.includes(normalizedAlias);
    }

    const regex = new RegExp(
      `(^|[^a-z0-9])${this.escapeRegex(normalizedAlias)}([^a-z0-9]|$)`,
      'i',
    );
    return regex.test(normalizedText);
  }

  private detectColorGroupIndexes(text?: string) {
    const normalizedText = this.normalize(text);
    if (!normalizedText) return new Set<number>();

    const groups = new Set<number>();
    this.COLOR_GROUPS.forEach((aliases, index) => {
      if (
        aliases.some((alias) => this.containsColorAlias(normalizedText, alias))
      ) {
        groups.add(index);
      }
    });

    return groups;
  }

  private resolveRequestedColorGroups(
    colorName: string | undefined,
    colorTerms: string[],
  ) {
    const groups = new Set<number>();
    const normalizedColorName = this.normalize(colorName || '');
    const normalizedTerms = colorTerms.map((term) => this.normalize(term));

    this.COLOR_GROUPS.forEach((aliases, index) => {
      const hasMatch = aliases.some((alias) => {
        const normalizedAlias = this.normalize(alias);
        return (
          normalizedTerms.some(
            (term) =>
              term === normalizedAlias ||
              term.includes(normalizedAlias) ||
              normalizedAlias.includes(term),
          ) ||
          normalizedColorName.includes(normalizedAlias) ||
          normalizedAlias.includes(normalizedColorName)
        );
      });

      if (hasMatch) {
        groups.add(index);
      }
    });

    // If the user asks for a specific gray variant (e.g. Dark/Light Bluish Gray),
    // avoid treating generic gray as an exact equivalent.
    const asksSpecificGrayVariant =
      normalizedColorName.includes('dark') ||
      normalizedColorName.includes('light') ||
      normalizedColorName.includes('bluish');

    if (asksSpecificGrayVariant && (groups.has(9) || groups.has(10))) {
      groups.delete(8);
    }

    return groups;
  }

  private buildPartNameTokens(partName?: string) {
    if (!partName) return [];

    const normalized = this.normalize(partName)
      .replace(/(\d)\s*x\s*(\d)/g, '$1x$2')
      .replace(/[^a-z0-9x\s]+/g, ' ');

    return normalized
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(
        (token) => token.length >= 2 && !this.PART_NAME_STOP_WORDS.has(token),
      );
  }

  private extractPartDimensions(partName?: string) {
    const normalized = this.normalize(partName || '');
    const matches = normalized.match(/\d+\s*x\s*\d+/g) || [];
    return Array.from(
      new Set(
        matches
          .map((value) => value.replace(/\s+/g, ''))
          .filter((value) => value.length > 0),
      ),
    );
  }

  private evaluateOfferColor(
    offerName: string,
    detectedOfferColor: string | null,
    requestedColorGroups: Set<number>,
    requestedColorName?: string | null,
    strictColorLabels: Set<string> = new Set<string>(),
    strictColorMode = false,
    strictImageUrlMatch = false,
  ): OfferColorAnalysis {
    const normalizedRequestedColor = this.normalizeColorLabel(
      requestedColorName || '',
    );
    const hasRequestedColorSignal =
      requestedColorGroups.size > 0 || normalizedRequestedColor.length > 0;

    if (!hasRequestedColorSignal) {
      return {
        colorMatchScore: 0,
        colorScore: 0,
        colorConflict: false,
        matchedRequestedColor: false,
        detectedColorGroups: [],
      };
    }

    const titleGroups = this.detectColorGroupIndexes(offerName);
    const detectedGroups = this.detectColorGroupIndexes(
      detectedOfferColor || '',
    );
    const allGroups = new Set<number>([...titleGroups, ...detectedGroups]);
    const detectedColorGroups = Array.from(allGroups.values());
    const exactRequestedColorTextMatch =
      normalizedRequestedColor.length > 0 &&
      (this.containsColorAlias(
        this.normalizeColorLabel(offerName),
        normalizedRequestedColor,
      ) ||
        this.containsColorAlias(
          this.normalizeColorLabel(detectedOfferColor || ''),
          normalizedRequestedColor,
        ));
    const strictParameterMatch = this.hasStrictColorLabelMatchInText(
      detectedOfferColor || '',
      strictColorLabels,
    );
    const strictTitleMatch = this.hasStrictColorLabelMatchInText(
      offerName,
      strictColorLabels,
    );
    const strictLabelMatch =
      strictImageUrlMatch || strictParameterMatch || strictTitleMatch;

    const matchedByColorGroup = detectedColorGroups.some((group) =>
      requestedColorGroups.has(group),
    );
    const hasConflictingColor =
      requestedColorGroups.size > 0
        ? detectedColorGroups.some((group) => !requestedColorGroups.has(group))
        : detectedColorGroups.length > 0 && !exactRequestedColorTextMatch;

    if (strictColorMode && strictColorLabels.size > 0) {
      if (strictLabelMatch && !hasConflictingColor) {
        return {
          colorMatchScore: 5,
          colorScore: 1400,
          colorConflict: false,
          matchedRequestedColor: true,
          detectedColorGroups,
        };
      }

      if (strictLabelMatch && hasConflictingColor) {
        return {
          colorMatchScore: 0,
          colorScore: -1800,
          colorConflict: true,
          matchedRequestedColor: false,
          detectedColorGroups,
        };
      }

      if (detectedColorGroups.length > 0) {
        return {
          colorMatchScore: 0,
          colorScore: -1500,
          colorConflict: true,
          matchedRequestedColor: false,
          detectedColorGroups,
        };
      }

      return {
        colorMatchScore: 0,
        colorScore: -300,
        colorConflict: false,
        matchedRequestedColor: false,
        detectedColorGroups,
      };
    }

    const matchedRequestedColor =
      exactRequestedColorTextMatch || matchedByColorGroup;

    if (exactRequestedColorTextMatch && !hasConflictingColor) {
      return {
        colorMatchScore: 5,
        colorScore: 1300,
        colorConflict: false,
        matchedRequestedColor: true,
        detectedColorGroups,
      };
    }

    if (matchedRequestedColor && !hasConflictingColor) {
      return {
        colorMatchScore: 4,
        colorScore: 900,
        colorConflict: false,
        matchedRequestedColor: true,
        detectedColorGroups,
      };
    }

    if (matchedRequestedColor && hasConflictingColor) {
      return {
        colorMatchScore: 1,
        colorScore: -850,
        colorConflict: true,
        matchedRequestedColor: true,
        detectedColorGroups,
      };
    }

    if (!matchedRequestedColor && detectedColorGroups.length > 0) {
      return {
        colorMatchScore: 0,
        colorScore: -1300,
        colorConflict: true,
        matchedRequestedColor: false,
        detectedColorGroups,
      };
    }

    return {
      colorMatchScore: 1,
      colorScore: -150,
      colorConflict: false,
      matchedRequestedColor: false,
      detectedColorGroups,
    };
  }

  private getPartRelevanceScore(
    offerName: string,
    requestedIds: string[],
    designId?: string,
    partNameTokens: string[] = [],
    partDimensions: string[] = [],
  ) {
    const normalizedOfferName = this.normalize(offerName);

    let score = 0;
    let exactIdMatch = false;
    let partialIdMatch = false;

    requestedIds.forEach((requestedId) => {
      const normalizedId = this.normalize(requestedId);
      if (!normalizedId) return;

      if (this.hasWholeToken(normalizedOfferName, normalizedId)) {
        exactIdMatch = true;
        score = Math.max(score, 1400);
        return;
      }

      if (normalizedOfferName.includes(normalizedId)) {
        partialIdMatch = true;
        score = Math.max(score, 900);
      }
    });

    const hasDimensions = partDimensions.length > 0;
    if (hasDimensions) {
      const dimensionHits = partDimensions.filter((dimension) =>
        normalizedOfferName.includes(dimension),
      ).length;
      if (dimensionHits > 0) {
        score += 320 * dimensionHits;
      } else {
        score -= 380;
      }
    }

    if (partNameTokens.length > 0) {
      const tokenHits = partNameTokens.filter(
        (token) =>
          this.hasWholeToken(normalizedOfferName, token) ||
          normalizedOfferName.includes(token),
      ).length;
      const coverage = tokenHits / partNameTokens.length;
      score += Math.round(coverage * 380);
      if (coverage < 0.3) {
        score -= 250;
      }
    }

    const normalizedDesignId = this.normalize(designId || '');
    if (
      normalizedDesignId &&
      !normalizedDesignId.includes('pb') &&
      new RegExp(`${this.escapeRegex(normalizedDesignId)}\\s*pb\\d+`, 'i').test(
        normalizedOfferName,
      )
    ) {
      score -= 1200;
    }

    if (!exactIdMatch && partialIdMatch) {
      score -= 350;
    }

    return {
      score,
      exactIdMatch,
      partialIdMatch,
    };
  }

  private isPrintedVariantMismatch(offerName: string, designId?: string) {
    const normalizedDesignId = this.normalize(designId || '');
    if (!normalizedDesignId || normalizedDesignId.includes('pb')) {
      return false;
    }

    const normalizedOfferName = this.normalize(offerName);
    const printedVariantRegex = new RegExp(
      `(^|[^a-z0-9])${this.escapeRegex(normalizedDesignId)}\\s*pb\\d+([^a-z0-9]|$)`,
      'i',
    );

    return printedVariantRegex.test(normalizedOfferName);
  }

  private getTokenOverlapScore(a: string, b: string) {
    const aTokens = new Set(this.asTokens(a));
    const bTokens = new Set(this.asTokens(b));

    if (aTokens.size === 0 || bTokens.size === 0) return 0;

    let overlap = 0;
    aTokens.forEach((token) => {
      if (bTokens.has(token)) overlap += 1;
    });

    if (overlap >= 2) return 70;
    if (overlap === 1) return 50;
    return 0;
  }

  private scoreColorValue(valueName: string, colorTerms: string[]) {
    if (colorTerms.length === 0) return 0;

    const normalizedValue = this.normalize(valueName);
    let best = 0;

    colorTerms.forEach((term) => {
      const normalizedTerm = this.normalize(term);
      if (!normalizedTerm) return;

      if (normalizedValue === normalizedTerm) {
        best = Math.max(best, 100);
        return;
      }

      if (
        normalizedValue.includes(normalizedTerm) ||
        normalizedTerm.includes(normalizedValue)
      ) {
        best = Math.max(best, 85);
        return;
      }

      best = Math.max(
        best,
        this.getTokenOverlapScore(normalizedValue, normalizedTerm),
      );
    });

    return best;
  }

  private getColorFilterPriority(filterName: string) {
    const normalizedName = this.normalize(filterName);

    if (normalizedName.includes('kolor producenta')) return 1200;
    if (normalizedName.includes('kolor') && normalizedName.includes('wzor')) {
      return 650;
    }
    if (normalizedName === 'kolor') return 620;
    if (normalizedName.includes('kolor')) return 560;
    if (normalizedName.includes('color')) return 520;
    if (normalizedName.includes('colour')) return 500;

    return 0;
  }

  private pickColorFilters(filters: any[]) {
    return filters
      .filter((filter) => filter && typeof filter === 'object')
      .map((filter) => {
        const filterId = String(filter.id || '');
        const filterName = String(filter.name || '');
        const filterPriority = this.getColorFilterPriority(filterName);

        if (
          filterPriority === 0 ||
          !filterId.startsWith('parameter.') ||
          !Array.isArray(filter.values) ||
          filter.values.length === 0
        ) {
          return null;
        }

        return {
          filterId,
          filterName,
          filterPriority,
          rawFilter: filter,
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          filterId: string;
          filterName: string;
          filterPriority: number;
          rawFilter: any;
        } => Boolean(entry),
      )
      .sort((a, b) => b.filterPriority - a.filterPriority);
  }

  private extractFilterValueRecords(rawFilter: any): Array<{
    valueId: string;
    valueName: string;
    count: number;
  }> {
    if (!Array.isArray(rawFilter?.values)) return [];

    return rawFilter.values
      .map((entry: any) => {
        const valueId = String(entry?.value || '');
        const valueName = String(entry?.name || entry?.label || '');
        const count = Number.isFinite(entry?.count) ? Number(entry.count) : 0;
        return { valueId, valueName, count };
      })
      .filter(
        (entry) => entry.valueId.length > 0 && entry.valueName.length > 0,
      );
  }

  private pickBestColorFilterValues(
    rawFilter: any,
    colorTerms: string[],
    strictColorLabels: Set<string>,
  ) {
    const hasStrictValueMatch = (valueName: string) => {
      const normalizedValueName = this.normalizeColorLabel(valueName);
      if (!normalizedValueName) return false;
      if (strictColorLabels.has(normalizedValueName)) return true;

      const fragments = normalizedValueName
        .split(/[|/,;+]+/g)
        .map((entry) => this.normalizeColorLabel(entry))
        .filter((entry) => entry.length > 0);

      if (fragments.some((fragment) => strictColorLabels.has(fragment))) {
        return true;
      }

      return Array.from(strictColorLabels.values()).some((label) =>
        this.containsColorAlias(normalizedValueName, label),
      );
    };

    if (strictColorLabels.size > 0) {
      const strictMatches = this.extractFilterValueRecords(rawFilter)
        .map((entry) => ({
          ...entry,
        }))
        .filter((entry) => hasStrictValueMatch(entry.valueName))
        .sort((a, b) => b.count - a.count)
        .map((entry) => ({
          valueId: entry.valueId,
          valueName: entry.valueName,
          count: entry.count,
          valueScore: 100,
        }));

      return strictMatches.slice(0, 4);
    }

    const scoredValues = this.extractFilterValueRecords(rawFilter)
      .map((entry) => ({
        ...entry,
        valueScore: this.scoreColorValue(entry.valueName, colorTerms),
      }))
      .filter((entry) => entry.valueScore >= 70)
      .sort((a, b) => {
        if (b.valueScore !== a.valueScore) return b.valueScore - a.valueScore;
        return b.count - a.count;
      });

    if (scoredValues.length === 0) return [];

    const topScore = scoredValues[0].valueScore;
    return scoredValues
      .filter((entry) => entry.valueScore >= Math.max(85, topScore - 10))
      .slice(0, 4);
  }

  private extractParameterValues(rawValues: unknown): string[] {
    if (!Array.isArray(rawValues)) return [];

    return rawValues
      .map((value) => {
        if (typeof value === 'string') return value;
        if (value && typeof value === 'object') {
          if (typeof (value as any).name === 'string')
            return (value as any).name;
          if (typeof (value as any).label === 'string')
            return (value as any).label;
          if (typeof (value as any).value === 'string')
            return (value as any).value;
        }
        return '';
      })
      .filter((value) => value.length > 0);
  }

  private async getAccessToken(): Promise<string> {
    if (!this.isEnabled() || !this.isConfigured()) {
      throw new InternalServerErrorException(
        'Allegro integration is disabled or not configured',
      );
    }

    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 30_000) {
      return this.tokenCache.token;
    }

    if (this.tokenInFlight) {
      return this.tokenInFlight;
    }

    this.tokenInFlight = (async () => {
      const clientId = this.config.get('ALLEGRO_CLIENT_ID');
      const clientSecret = this.config.get('ALLEGRO_CLIENT_SECRET');
      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

      try {
        await this.ensureExternalCallPermit('oauth-token', 0);
        const { data } = await firstValueFrom(
          this.httpService.post(
            `${this.getAuthBaseUrl()}/auth/oauth/token?grant_type=client_credentials`,
            {},
            {
              headers: {
                Authorization: `Basic ${auth}`,
                Accept: 'application/vnd.allegro.public.v1+json',
              },
            },
          ),
        );

        const token = String(data?.access_token || '');
        const expiresIn = Number.parseInt(String(data?.expires_in || '3600'), 10);
        const safeExpiresIn = Number.isFinite(expiresIn) ? expiresIn : 3600;
        this.tokenCache = {
          token,
          expiresAt: Date.now() + Math.max(60, safeExpiresIn - 60) * 1000,
        };
        return token;
      } catch (error) {
        const details = this.extractAllegroErrorDetails(error);
        this.logger.error(
          `Allegro Auth Error [HTTP ${details.status || 'n/a'}${
            details.code ? `/${details.code}` : ''
          }]: ${details.message}`,
        );
        throw new InternalServerErrorException('Allegro Auth Failed');
      } finally {
        this.tokenInFlight = null;
      }
    })();

    return this.tokenInFlight;
  }

  private extractColorFromTitle(title: string): string | null {
    if (!title) return null;
    const normalizedTitle = this.normalize(title);
    const colorCandidates = [...this.COLOR_KEYWORDS].sort(
      (a, b) => b.length - a.length,
    );

    for (const color of colorCandidates) {
      if (this.containsColorAlias(normalizedTitle, color)) {
        return color;
      }
    }
    return null;
  }

  private extractColorFromOffer(item: any): string | null {
    const colorParam = item.parameters?.find((param: any) => {
      const normalizedName = this.normalize(param.name);
      return (
        normalizedName.includes('kolor') ||
        normalizedName.includes('color') ||
        normalizedName.includes('colour')
      );
    });

    const parameterValues = this.extractParameterValues(colorParam?.values);
    if (parameterValues.length > 0) {
      return parameterValues.join(' | ');
    }

    return this.extractColorFromTitle(item.name);
  }

  private extractColorFromOfferParameter(item: any): string | null {
    const colorParam = item.parameters?.find((param: any) => {
      const normalizedName = this.normalize(param.name);
      return (
        normalizedName.includes('kolor') ||
        normalizedName.includes('color') ||
        normalizedName.includes('colour')
      );
    });

    const parameterValues = this.extractParameterValues(colorParam?.values);
    return parameterValues.length > 0 ? parameterValues.join(' | ') : null;
  }

  private resolveOfferUnitQuantity(item: any) {
    const fromParameters = extractPackQuantityFromParameters(item?.parameters);
    if (fromParameters) {
      return {
        value: fromParameters,
        source: 'allegro-parameter',
      };
    }

    const fromTitle = extractPackQuantityFromText(item?.name);
    if (fromTitle) {
      return {
        value: fromTitle,
        source: 'allegro-title',
      };
    }

    return {
      value: 1,
      source: 'default',
    };
  }

  private resolveAvailableOfferUnits(item: any): number | null {
    return (
      parsePositiveInteger(item?.stock?.available, 1, 1_000_000) ||
      parsePositiveInteger(item?.sellingMode?.stock?.available, 1, 1_000_000) ||
      parsePositiveInteger(item?.sellingMode?.quantity, 1, 1_000_000)
    );
  }

  private buildListingCacheKey(params: URLSearchParams) {
    return params.toString();
  }

  private buildSaleProductsCacheKey(phrase: string, categoryId?: string | null) {
    return `${this.normalize(phrase)}|${String(categoryId || '').trim()}`;
  }

  private pruneListingCache() {
    const now = Date.now();
    for (const [key, entry] of this.listingCache.entries()) {
      if (!entry || entry.expiresAt <= now) {
        this.listingCache.delete(key);
      }
    }

    const maxEntries = this.getListingCacheMaxEntries();
    if (this.listingCache.size <= maxEntries) return;

    const overflow = this.listingCache.size - maxEntries;
    const keysToDrop = Array.from(this.listingCache.keys()).slice(0, overflow);
    keysToDrop.forEach((key) => this.listingCache.delete(key));
  }

  private pruneSaleProductsCache() {
    const now = Date.now();
    for (const [key, entry] of this.saleProductsCache.entries()) {
      if (!entry || entry.expiresAt <= now) {
        this.saleProductsCache.delete(key);
      }
    }

    const maxEntries = this.getSaleProductsCacheMaxEntries();
    if (this.saleProductsCache.size <= maxEntries) return;

    const overflow = this.saleProductsCache.size - maxEntries;
    const keysToDrop = Array.from(this.saleProductsCache.keys()).slice(0, overflow);
    keysToDrop.forEach((key) => this.saleProductsCache.delete(key));
  }

  private async runListingRequestWithThrottle<T>(
    request: () => Promise<T>,
    callType = 'listing',
  ) {
    let releaseQueue: () => void = () => {};
    const previous = this.listingRequestChain;
    this.listingRequestChain = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await previous;
    try {
      const minInterval = this.getListingMinIntervalMs();
      const waitMs = this.lastListingRequestAt + minInterval - Date.now();
      if (waitMs > 0) {
        await this.sleep(waitMs);
      }

      await this.ensureExternalCallPermit(callType, minInterval);
      const result = await request();
      this.lastListingRequestAt = Date.now();
      return result;
    } finally {
      releaseQueue();
    }
  }

  private isRetryableListingStatus(status: number | null) {
    return status === 429 || (status !== null && status >= 500);
  }

  private isInvalidSortError(error: any) {
    const details = this.extractAllegroErrorDetails(error);
    if (details.status !== 400 && details.status !== 422) {
      return false;
    }
    const signal = this.normalize(
      `${details.code || ''} ${details.message || ''} ${details.userMessage || ''}`,
    );
    return signal.includes('sort');
  }

  private async fetchListing(token: string, params: URLSearchParams) {
    const cacheTtlMs = this.getListingCacheTtlMs();
    const cacheKey = this.buildListingCacheKey(params);
    if (cacheTtlMs > 0) {
      const cached = this.listingCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
      }
    }

    const inFlight = this.listingInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async () => {
      const maxRetries = this.getListingMaxRetries();

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          const data = await this.runListingRequestWithThrottle(async () => {
            const url = `${this.getApiBaseUrl()}/offers/listing?${params.toString()}`;
            const response = await firstValueFrom(
              this.httpService.get(url, {
                headers: {
                  Authorization: `Bearer ${token}`,
                  Accept: 'application/vnd.allegro.public.v1+json',
                  'Accept-Language': 'pl-PL',
                },
              }),
            );
            return response.data;
          }, 'listing');

          if (cacheTtlMs > 0) {
            this.listingCache.set(cacheKey, {
              value: data,
              expiresAt: Date.now() + cacheTtlMs,
            });
            this.pruneListingCache();
          }
          return data;
        } catch (error) {
          const details = this.extractAllegroErrorDetails(error);
          const shouldRetry =
            attempt < maxRetries && this.isRetryableListingStatus(details.status);
          if (!shouldRetry) {
            throw error;
          }

          const backoffMs = Math.min(2_000, 220 * 2 ** attempt) + Math.floor(Math.random() * 180);
          await this.sleep(backoffMs);
        }
      }

      throw new InternalServerErrorException(
        'Allegro listing request failed unexpectedly',
      );
    })();

    this.listingInFlight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.listingInFlight.delete(cacheKey);
    }
  }

  private extractItemsFromListingResponse(data: any) {
    return [...(data.items?.promoted || []), ...(data.items?.regular || [])];
  }

  private async fetchOffersForPhrase(
    token: string,
    phrase: string,
    options?: { fallback?: boolean; limit?: number; sort?: string },
  ) {
    const requestedSort = options?.sort || '+price';
    const params = new URLSearchParams();
    params.set('phrase', phrase);
    params.set('fallback', options?.fallback ? 'true' : 'false');
    params.set('limit', String(options?.limit ?? this.getInitialResultsLimit()));
    params.set('marketplaceId', this.defaultMarketplaceId);
    params.set('sort', requestedSort);
    params.set('searchMode', 'REGULAR');
    params.append('sellingMode.format', 'BUY_NOW');

    try {
      const data = await this.fetchListing(token, params);
      return this.extractItemsFromListingResponse(data);
    } catch (error) {
      if (!this.isInvalidSortError(error) || requestedSort === 'relevance') {
        throw error;
      }

      params.set('sort', 'relevance');
      const data = await this.fetchListing(token, params);
      return this.extractItemsFromListingResponse(data);
    }
  }

  private async fetchSaleProducts(
    token: string,
    phrase: string,
    categoryId?: string | null,
  ) {
    const cacheTtlMs = this.getSaleProductsCacheTtlMs();
    const cacheKey = this.buildSaleProductsCacheKey(phrase, categoryId);
    if (cacheTtlMs > 0) {
      const cached = this.saleProductsCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
      }
    }

    const inFlight = this.saleProductsInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const params = new URLSearchParams();
    params.set('phrase', phrase);
    params.set('language', 'pl-PL');
    if (categoryId) {
      params.set('category.id', categoryId);
    }

    const promise = (async () => {
      const maxRetries = this.getListingMaxRetries();
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          const products = await this.runListingRequestWithThrottle(async () => {
            const url = `${this.getApiBaseUrl()}/sale/products?${params.toString()}`;
            const { data } = await firstValueFrom(
              this.httpService.get(url, {
                headers: {
                  Authorization: `Bearer ${token}`,
                  Accept: 'application/vnd.allegro.public.v1+json',
                  'Accept-Language': 'pl-PL',
                },
              }),
            );
            return Array.isArray(data?.products) ? data.products : [];
          }, 'sale-products');

          if (cacheTtlMs > 0) {
            this.saleProductsCache.set(cacheKey, {
              value: products,
              expiresAt: Date.now() + cacheTtlMs,
            });
            this.pruneSaleProductsCache();
          }

          return products;
        } catch (error) {
          const details = this.extractAllegroErrorDetails(error);
          const shouldRetry =
            attempt < maxRetries && this.isRetryableListingStatus(details.status);
          if (!shouldRetry) {
            throw error;
          }

          const backoffMs = Math.min(2_000, 220 * 2 ** attempt) + Math.floor(Math.random() * 180);
          await this.sleep(backoffMs);
        }
      }

      return [];
    })();

    this.saleProductsInFlight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.saleProductsInFlight.delete(cacheKey);
    }
  }

  private extractParameterLabelsByName(product: any, expectedName: string) {
    const parameters = Array.isArray(product?.parameters) ? product.parameters : [];
    const normalizedExpectedName = this.normalize(expectedName);

    return parameters
      .filter((param) => this.normalize(param?.name).includes(normalizedExpectedName))
      .flatMap((param) => {
        const labels = Array.isArray(param?.valuesLabels) ? param.valuesLabels : [];
        const scalarValues = Array.isArray(param?.values) ? param.values : [];
        return [...labels, ...scalarValues]
          .map((value) => String(value || '').trim())
          .filter((value) => value.length > 0);
      });
  }

  private productMatchesRequestedId(product: any, requestedIds: string[]) {
    const normalizedProductName = this.normalize(String(product?.name || ''));
    const productNumberLabels = this.extractParameterLabelsByName(
      product,
      'numer produktu',
    ).map((value) => this.normalize(value));

    return requestedIds.some((requestedId) => {
      const normalizedRequestedId = this.normalize(requestedId);
      if (!normalizedRequestedId) return false;
      return (
        productNumberLabels.some((value) => value === normalizedRequestedId) ||
        this.hasWholeToken(normalizedProductName, normalizedRequestedId)
      );
    });
  }

  private async resolveProductColorContext(
    token: string,
    requestedIds: string[],
    designId: string | undefined,
    partName: string | undefined,
    strictColorLabels: Set<string>,
  ): Promise<ProductColorContext> {
    const manufacturerColorLabels = new Set<string>();
    const categoryIds = new Set<string>();

    if (requestedIds.length === 0 || strictColorLabels.size === 0) {
      return { manufacturerColorLabels, categoryIds };
    }

    const bestId = String(designId || requestedIds[0] || '').trim();
    const normalizedPartName = this.normalize(partName || '');
    const phrases = Array.from(
      new Set(
        [
          `lego ${bestId} ${normalizedPartName}`.trim(),
          `lego ${bestId}`.trim(),
        ].filter((value) => value.length > 0),
      ),
    );

    for (const phrase of phrases) {
      try {
        const products = await this.fetchSaleProducts(token, phrase);

        products.forEach((product) => {
          if (!this.productMatchesRequestedId(product, requestedIds)) {
            return;
          }

          const categoryId = String(product?.category?.id || '').trim();
          if (/^\d+$/.test(categoryId)) {
            categoryIds.add(categoryId);
          }

          this.extractParameterLabelsByName(product, 'kolor producenta').forEach(
            (label) => {
              const normalizedLabel = this.normalizeColorLabel(label);
              if (strictColorLabels.has(normalizedLabel)) {
                manufacturerColorLabels.add(normalizedLabel);
              }
            },
          );
        });

        if (manufacturerColorLabels.size > 0) {
          break;
        }
      } catch (error) {
        const details = this.extractAllegroErrorDetails(error);
        this.logger.warn(
          `Błąd API Allegro /sale/products dla frazy "${phrase}" [HTTP ${details.status || 'n/a'}${details.code ? `/${details.code}` : ''}]: ${details.message}`,
        );
      }
    }

    return { manufacturerColorLabels, categoryIds };
  }

  private async findColorFilterCandidatesForPhrase(
    token: string,
    phrase: string,
    colorTerms: string[],
    strictColorLabels: Set<string>,
    preferredCategoryIds: string[],
    manufacturerOnly = false,
  ): Promise<ColorFilterCandidate[]> {
    const collectCandidatesFromFilters = (filters: any[], priorityBoost = 0) =>
      this.pickColorFilters(filters)
        .map((entry) => {
          const valueMatches = this.pickBestColorFilterValues(
            entry.rawFilter,
            colorTerms,
            strictColorLabels,
          );

          if (valueMatches.length === 0) {
            return null;
          }

          return {
            filterId: entry.filterId,
            filterName: entry.filterName,
            filterPriority: entry.filterPriority + priorityBoost,
            valueMatches,
          };
        })
        .filter((entry): entry is ColorFilterCandidate => Boolean(entry));

    const extractCategoryHints = (data: any): string[] => {
      const ids = new Set<string>();
      const addId = (rawId: unknown) => {
        const normalizedId = String(rawId || '').trim();
        if (/^\d+$/.test(normalizedId)) {
          ids.add(normalizedId);
        }
      };

      this.extractItemsFromListingResponse(data).forEach((item) =>
        addId(item?.category?.id),
      );

      const pathCategories = Array.isArray(data?.categories?.path)
        ? data.categories.path
        : [];
      pathCategories.forEach((category) => addId(category?.id));

      const subcategories = Array.isArray(data?.categories?.subcategories)
        ? [...data.categories.subcategories]
            .filter((category) => category?.id)
            .sort((a, b) => Number(b?.count || 0) - Number(a?.count || 0))
            .slice(0, 6)
        : [];
      subcategories.forEach((category) => addId(category?.id));

      return Array.from(ids).slice(0, 8);
    };

    const params = new URLSearchParams();
    params.set('phrase', phrase);
    params.set('fallback', 'true');
    params.set('limit', '20');
    params.set('marketplaceId', this.defaultMarketplaceId);
    params.append('include', '-all');
    params.append('include', 'filters');
    params.append('include', 'categories');
    params.append('include', 'items');

    const primaryData = await this.fetchListing(token, params);
    const primaryFilters = Array.isArray(primaryData.filters)
      ? primaryData.filters
      : [];
    const primaryCandidates = collectCandidatesFromFilters(primaryFilters, 0);

    const discoveredCandidates = [...primaryCandidates];
    const categoryHints = Array.from(
      new Set([...preferredCategoryIds, ...extractCategoryHints(primaryData)]),
    );
    const hasManufacturerFilter = primaryCandidates.some((candidate) =>
      this.normalize(candidate.filterName).includes('kolor producenta'),
    );

    if (!hasManufacturerFilter || discoveredCandidates.length === 0) {
      for (const [index, categoryId] of categoryHints.entries()) {
        const categoryParams = new URLSearchParams();
        categoryParams.set('phrase', phrase);
        categoryParams.set('fallback', 'true');
        categoryParams.set('limit', '1');
        categoryParams.set('marketplaceId', this.defaultMarketplaceId);
        categoryParams.set('category.id', String(categoryId));
        categoryParams.append('include', '-all');
        categoryParams.append('include', 'filters');

        const categoryData = await this.fetchListing(token, categoryParams);
        const categoryFilters = Array.isArray(categoryData.filters)
          ? categoryData.filters
          : [];

        discoveredCandidates.push(
          ...collectCandidatesFromFilters(categoryFilters, 140 - index * 10),
        );
      }
    }

    const deduped = new Map<string, ColorFilterCandidate>();
    discoveredCandidates.forEach((candidate) => {
      const key = `${candidate.filterId}::${candidate.valueMatches
        .map((value) => value.valueId)
        .join(',')}`;
      const existing = deduped.get(key);
      if (!existing || candidate.filterPriority > existing.filterPriority) {
        deduped.set(key, candidate);
      }
    });

    const sorted = Array.from(deduped.values()).sort((a, b) => {
      if (b.filterPriority !== a.filterPriority) {
        return b.filterPriority - a.filterPriority;
      }
      return b.valueMatches[0].valueScore - a.valueMatches[0].valueScore;
    });

    const manufacturerFirst = sorted.filter((candidate) =>
      this.normalize(candidate.filterName).includes('kolor producenta'),
    );

    if (manufacturerOnly) {
      return manufacturerFirst.slice(0, 2);
    }

    if (manufacturerFirst.length > 0) {
      return manufacturerFirst.slice(0, 2);
    }

    return sorted.slice(0, 2);
  }

  private async fetchOffersForPhraseWithColorFilter(
    token: string,
    phrase: string,
    filterId: string,
    valueIds: string[],
  ) {
    const requestedSort = '+price';
    const params = new URLSearchParams();
    params.set('phrase', phrase);
    params.set('fallback', 'false');
    params.set('limit', String(this.getInitialResultsLimit()));
    params.set('marketplaceId', this.defaultMarketplaceId);
    params.set('sort', requestedSort);
    params.set('searchMode', 'REGULAR');
    params.append('sellingMode.format', 'BUY_NOW');

    valueIds.forEach((valueId) => params.append(filterId, valueId));

    try {
      const data = await this.fetchListing(token, params);
      return this.extractItemsFromListingResponse(data);
    } catch (error) {
      if (!this.isInvalidSortError(error)) {
        throw error;
      }
      params.set('sort', 'relevance');
      const data = await this.fetchListing(token, params);
      return this.extractItemsFromListingResponse(data);
    }
  }

  private buildSearchQueries(
    id: string,
    hasPreferredColor: boolean,
    colorName: string | undefined,
    partName?: string,
  ): SearchQueryDescriptor[] {
    const normalizedPartName = this.normalize(partName || '')
      .replace(/(\d)\s*x\s*(\d)/g, '$1 x $2')
      .replace(/\s+/g, ' ')
      .trim();

    const normalizedColor = this.normalize(colorName || '').trim();
    const base = `lego ${id}`.trim();

    const descriptors: SearchQueryDescriptor[] = [];
    const addQuery = (
      phrase: string,
      sourceTier: number,
      queryContainsColor: boolean,
      queryContainsPartName: boolean,
    ) => {
      const normalizedPhrase = phrase.replace(/\s+/g, ' ').trim();
      if (!normalizedPhrase) return;
      if (descriptors.some((entry) => entry.phrase === normalizedPhrase))
        return;
      descriptors.push({
        phrase: normalizedPhrase,
        sourceTier,
        queryContainsColor,
        queryContainsPartName,
      });
    };

    if (hasPreferredColor && normalizedPartName && normalizedColor) {
      addQuery(
        `${base} ${normalizedPartName} ${normalizedColor}`,
        6,
        true,
        true,
      );
    }
    if (normalizedPartName) {
      addQuery(`${base} ${normalizedPartName}`, 5, false, true);
    }
    if (hasPreferredColor && normalizedColor) {
      addQuery(`${base} ${normalizedColor}`, 4, true, false);
    }
    addQuery(base, 3, false, false);

    return descriptors;
  }

  private getSourcePriority(
    sourceTier: number,
    queryContainsColor: boolean,
    queryContainsPartName: boolean,
    matchedByColorParameter: boolean,
    colorFilterName: string | null,
  ) {
    let priority = 1400 + sourceTier * 260;

    if (queryContainsPartName) {
      priority += 280;
    }

    if (queryContainsColor) {
      priority += 220;
    }

    if (matchedByColorParameter) {
      priority += 3200;
      const normalizedFilterName = this.normalize(colorFilterName || '');
      if (normalizedFilterName.includes('kolor producenta')) {
        priority += 1100;
      } else if (normalizedFilterName.includes('kolor')) {
        priority += 700;
      }
    }

    return priority;
  }

  private upsertOffer(
    uniqueOffers: Map<string, any>,
    item: any,
    metadata: {
      sourcePriority: number;
      matchedByColorParameter: boolean;
      colorFilterName: string | null;
      matchSource: string;
      requestedColorName?: string | null;
      requestedColorGroups: Set<number>;
      requestedIds: string[];
      designId?: string;
      partNameTokens: string[];
      partDimensions: string[];
      queryContainsColor: boolean;
      queryContainsPartName: boolean;
      strictColorMode: boolean;
      strictColorLabels: Set<string>;
      matchedColorValueName?: string | null;
    },
  ) {
    if (this.isPrintedVariantMismatch(item?.name || '', metadata.designId)) {
      return false;
    }

    const price = Number.parseFloat(item.sellingMode?.price?.amount || '0');
    const detectedOfferColor = metadata.strictColorMode
      ? this.extractColorFromOfferParameter(item)
      : this.extractColorFromOffer(item);
    const requestedColorName = metadata.requestedColorName || null;
    const strictImageUrlMatch = this.hasStrictColorLabelMatchInImageUrls(
      item?.images,
      metadata.strictColorLabels,
    );
    const colorAnalysis = this.evaluateOfferColor(
      item.name,
      detectedOfferColor,
      metadata.requestedColorGroups,
      requestedColorName,
      metadata.strictColorLabels,
      metadata.strictColorMode,
      strictImageUrlMatch,
    );
    const unitQuantity = this.resolveOfferUnitQuantity(item);
    const availableOfferUnits = this.resolveAvailableOfferUnits(item);

    if (metadata.strictColorMode && colorAnalysis.colorConflict) {
      return false;
    }

    if (
      metadata.requestedColorGroups.size > 0 &&
      colorAnalysis.colorConflict &&
      !metadata.matchedByColorParameter
    ) {
      return false;
    }

    const partRelevance = this.getPartRelevanceScore(
      item.name,
      metadata.requestedIds,
      metadata.designId,
      metadata.partNameTokens,
      metadata.partDimensions,
    );

    let precisionRank =
      metadata.sourcePriority + partRelevance.score + colorAnalysis.colorScore;

    if (!partRelevance.exactIdMatch && !partRelevance.partialIdMatch) {
      precisionRank -= 1200;
    }

    if (metadata.queryContainsPartName) {
      precisionRank += 80;
    }

    if (metadata.queryContainsColor) {
      precisionRank += 60;
    }

    if (metadata.matchedByColorParameter) {
      precisionRank += 220;
    }

    const colorMatchScore = metadata.matchedByColorParameter
      ? 5
      : colorAnalysis.colorMatchScore;
    const shouldUseRequestedColorLabel =
      metadata.matchSource === 'strict-image-color' &&
      colorAnalysis.matchedRequestedColor &&
      !colorAnalysis.colorConflict &&
      requestedColorName;

    const preparedOffer = {
      id: item.id,
      name: item.name,
      price: item.sellingMode?.price?.amount,
      currency: item.sellingMode?.price?.currency,
      url: `${this.getOfferBaseUrl()}/${item.id}`,
      thumbnail: item.images?.[0]?.url,
      sellerId: item.seller?.id || null,
      sellerLogin: item.seller?.login || null,
      sellerIsCompany: Boolean(item.seller?.company),
      sellerIsSuperSeller: Boolean(item.seller?.superSeller),
      deliveryLowestPrice: item.delivery?.lowestPrice?.amount || null,
      deliveryCurrency: item.delivery?.lowestPrice?.currency || null,
      offerUnitQuantity: unitQuantity.value,
      offerUnitQuantitySource: unitQuantity.source,
      availableOfferUnits,
      availablePieceQuantity:
        availableOfferUnits !== null
          ? availableOfferUnits * unitQuantity.value
          : null,
      stockUnit: item?.stock?.unit ? String(item.stock.unit) : null,
      color: shouldUseRequestedColorLabel
        ? requestedColorName
        : detectedOfferColor || metadata.matchedColorValueName || null,
      colorDetectedFromOffer: Boolean(detectedOfferColor),
      requestedColorName,
      colorMatchScore,
      precisionRank,
      matchedByColorParameter: metadata.matchedByColorParameter,
      colorFilterName: metadata.colorFilterName,
      matchSource: metadata.matchSource,
      colorConflict: colorAnalysis.colorConflict,
      matchedRequestedColor: colorAnalysis.matchedRequestedColor,
      detectedColorGroups: colorAnalysis.detectedColorGroups,
      idMatchScore: partRelevance.score,
      queryContainsColor: metadata.queryContainsColor,
      queryContainsPartName: metadata.queryContainsPartName,
      provider: 'allegro',
      providerLabel: 'Allegro',
      isEstimated: false,
    };

    const existing = uniqueOffers.get(item.id);
    if (!existing) {
      uniqueOffers.set(item.id, preparedOffer);
      return true;
    }

    const existingPrice = Number.parseFloat(existing.price || '0');
    const shouldReplace =
      preparedOffer.precisionRank > existing.precisionRank ||
      (preparedOffer.precisionRank === existing.precisionRank &&
        preparedOffer.colorMatchScore > existing.colorMatchScore) ||
      (preparedOffer.precisionRank === existing.precisionRank &&
        preparedOffer.colorMatchScore === existing.colorMatchScore &&
        price < existingPrice);

    if (shouldReplace) {
      uniqueOffers.set(item.id, preparedOffer);
      return true;
    }

    return false;
  }

  /**
   * Szuka ofert Allegro dla podanych external IDs i opcjonalnie preferowanego koloru.
   */
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
    if ((await this.trafficGuard.getCooldownRemainingMs('allegro')) > 0) {
      return [];
    }

    const token = await this.getAccessToken();
    const uniqueOffers = new Map<string, any>();
    const strictColorLabels = this.buildStrictColorLabels(colorName);
    const preferredColorTerms = this.buildColorTerms(colorName);
    const requestedColorGroups = this.resolveRequestedColorGroups(
      colorName,
      preferredColorTerms,
    );
    const hasPreferredColor = strictColorLabels.size > 0;

    const requestedIds = Array.from(
      new Set(
        [...ids.slice(0, 5), designId || '']
          .map((value) => String(value || '').trim())
          .filter((value) => value.length > 0),
      ),
    );
    const preferredCategoryIds = new Set<string>();

    if (hasPreferredColor) {
      const productColorContext = await this.resolveProductColorContext(
        token,
        requestedIds,
        designId,
        partName,
        strictColorLabels,
      );

      productColorContext.manufacturerColorLabels.forEach((label) =>
        strictColorLabels.add(label),
      );
      productColorContext.categoryIds.forEach((categoryId) =>
        preferredCategoryIds.add(categoryId),
      );
    }

    const partNameTokens = this.buildPartNameTokens(partName);
    const partDimensions = this.extractPartDimensions(partName);

    const filterCandidateCache = new Map<string, ColorFilterCandidate[]>();
    const listingItemsCache = new Map<string, any[]>();

    const getColorCandidates = async (phrase: string) => {
      const cacheKey = `${phrase}::${Array.from(strictColorLabels.values()).sort().join('|')}`;
      if (filterCandidateCache.has(cacheKey)) {
        return filterCandidateCache.get(cacheKey)!;
      }
      const candidates = await this.findColorFilterCandidatesForPhrase(
        token,
        phrase,
        preferredColorTerms,
        strictColorLabels,
        Array.from(preferredCategoryIds.values()),
        hasPreferredColor,
      );
      filterCandidateCache.set(cacheKey, candidates);
      return candidates;
    };

    const getListingItems = async (
      phrase: string,
      options: { fallback?: boolean; limit?: number; sort?: string },
    ) => {
      const cacheKey = `${phrase}|${options.fallback ? '1' : '0'}|${options.limit || 40}|${options.sort || 'relevance'}`;
      if (listingItemsCache.has(cacheKey)) {
        return listingItemsCache.get(cacheKey)!;
      }
      const items = await this.fetchOffersForPhrase(token, phrase, options);
      listingItemsCache.set(cacheKey, items);
      return items;
    };

    let manufacturerFilterFound = false;
    let providerBlocked = false;

    for (const id of requestedIds.slice(0, this.getMaxIdProbes(hasPreferredColor))) {
      if (providerBlocked || this.getBlockRemainingMs() > 0) {
        break;
      }
      const queries = this
        .buildSearchQueries(
          id,
          hasPreferredColor,
          colorName,
          partName,
        )
        .slice(0, this.getMaxQueryProbes(hasPreferredColor));

      for (const query of queries) {
        if (providerBlocked || this.getBlockRemainingMs() > 0) {
          break;
        }
        try {
          if (hasPreferredColor) {
            const colorFilterCandidates = await getColorCandidates(
              query.phrase,
            );

            if (colorFilterCandidates.length > 0) {
              let manufacturerQueryHasAcceptedOffers = false;
              for (const candidate of colorFilterCandidates) {
                const valueIds = candidate.valueMatches.map(
                  (value) => value.valueId,
                );
                const items = await this.fetchOffersForPhraseWithColorFilter(
                  token,
                  query.phrase,
                  candidate.filterId,
                  valueIds,
                );

                let acceptedItemsForCandidate = 0;
                items.forEach((item) => {
                  const accepted = this.upsertOffer(uniqueOffers, item, {
                    sourcePriority: this.getSourcePriority(
                      query.sourceTier + 2,
                      query.queryContainsColor,
                      query.queryContainsPartName,
                      true,
                      candidate.filterName,
                    ),
                    matchedByColorParameter: true,
                    colorFilterName: candidate.filterName,
                    matchSource: `${candidate.filterName}:parameter`,
                    requestedColorName: colorName || null,
                    requestedColorGroups,
                    requestedIds,
                    designId,
                    partNameTokens,
                    partDimensions,
                    queryContainsColor: query.queryContainsColor,
                    queryContainsPartName: query.queryContainsPartName,
                    strictColorMode: hasPreferredColor,
                    strictColorLabels,
                    matchedColorValueName:
                      candidate.valueMatches[0]?.valueName || null,
                  });
                  if (accepted) {
                    acceptedItemsForCandidate += 1;
                  }
                });

                if (acceptedItemsForCandidate > 0) {
                  manufacturerQueryHasAcceptedOffers = true;
                }
              }

              if (manufacturerQueryHasAcceptedOffers) {
                manufacturerFilterFound = true;
              }
            }
          }

          const shouldCollectFallback =
            !hasPreferredColor || (hasPreferredColor && !manufacturerFilterFound);

          if (!shouldCollectFallback) {
            continue;
          }

          const items = await getListingItems(query.phrase, {
            fallback: true,
            limit: this.getInitialResultsLimit(),
            sort: '+price',
          });

          const isStrictMatchEligibleForItem = (
            item: any,
            strictImageUrlMatch: boolean,
            strictParameterMatch: boolean,
          ) => {
            if (!strictImageUrlMatch && !strictParameterMatch) {
              return false;
            }

            if (this.isPrintedVariantMismatch(item?.name || '', designId)) {
              return false;
            }

            const relevance = this.getPartRelevanceScore(
              item?.name || '',
              requestedIds,
              designId,
              partNameTokens,
              partDimensions,
            );
            return relevance.exactIdMatch || relevance.partialIdMatch;
          };

          const strictMatchPresence = items.reduce(
            (acc, item) => {
              const strictImageUrlMatch = this.hasStrictColorLabelMatchInImageUrls(
                item?.images,
                strictColorLabels,
              );
              const strictParameterMatch = this.hasStrictColorLabelMatchInText(
                this.extractColorFromOfferParameter(item),
                strictColorLabels,
              );

              if (
                strictImageUrlMatch &&
                isStrictMatchEligibleForItem(item, strictImageUrlMatch, false)
              ) {
                acc.image += 1;
              }
              if (
                strictParameterMatch &&
                isStrictMatchEligibleForItem(item, false, strictParameterMatch)
              ) {
                acc.parameter += 1;
              }
              return acc;
            },
            { image: 0, parameter: 0 },
          );
          const enforceStrictVisualOrParameterMatch =
            hasPreferredColor &&
            strictMatchPresence.image + strictMatchPresence.parameter > 0;

          items.forEach((item) => {
            const strictImageUrlMatch = this.hasStrictColorLabelMatchInImageUrls(
              item?.images,
              strictColorLabels,
            );
            const strictParameterMatch = this.hasStrictColorLabelMatchInText(
              this.extractColorFromOfferParameter(item),
              strictColorLabels,
            );
            const strictMatchEligible = isStrictMatchEligibleForItem(
              item,
              strictImageUrlMatch,
              strictParameterMatch,
            );

            if (
              enforceStrictVisualOrParameterMatch &&
              !strictMatchEligible
            ) {
              return;
            }

            this.upsertOffer(uniqueOffers, item, {
              sourcePriority: this.getSourcePriority(
                query.sourceTier,
                query.queryContainsColor,
                query.queryContainsPartName,
                false,
                null,
              ),
              matchedByColorParameter: false,
              colorFilterName: null,
              matchSource: hasPreferredColor
                ? strictMatchEligible
                  ? 'strict-image-color'
                  : 'fallback-color-unknown'
                : query.queryContainsColor
                  ? 'color-query'
                  : 'base-query',
              requestedColorName: colorName || null,
              requestedColorGroups,
              requestedIds,
              designId,
              partNameTokens,
              partDimensions,
              queryContainsColor: query.queryContainsColor,
              queryContainsPartName: query.queryContainsPartName,
              strictColorMode: hasPreferredColor,
              strictColorLabels,
            });
          });
        } catch (error) {
          this.noteProviderBlockFromError(error);
          if (this.isAccessDeniedListingError(error)) {
            const details = this.extractAllegroErrorDetails(error);
            const environment = this.getEnvironment();
            this.logger.error(
              `Allegro /offers/listing access denied (${environment}) [HTTP ${details.status || 'n/a'}${details.code ? `/${details.code}` : ''}]: ${details.userMessage || details.message}`,
            );
            throw new InternalServerErrorException(
              'Allegro API: brak dostępu do /offers/listing (HTTP 403 AccessDenied). Sprawdź uprawnienia aplikacji produkcyjnej lub wróć do sandboxa.',
            );
          }
          if (this.isVerificationRequiredError(error)) {
            const details = this.extractAllegroErrorDetails(error);
            this.logger.error(
              `Allegro /offers/listing wymaga zweryfikowanej aplikacji (HTTP ${details.status}/${details.code}). ${details.userMessage || details.message}`,
            );
            throw new InternalServerErrorException(
              'Allegro API: endpoint /offers/listing wymaga zweryfikowanej aplikacji na produkcji.',
            );
          }

          const details = this.extractAllegroErrorDetails(error);
          this.logger.warn(
            `Błąd API Allegro dla zapytania "${query.phrase}" [HTTP ${details.status || 'n/a'}${details.code ? `/${details.code}` : ''}]: ${details.message}`,
          );
          if (this.getBlockRemainingMs() > 0) {
            providerBlocked = true;
            break;
          }
        }
      }
    }

    const sortedOffers = Array.from(uniqueOffers.values()).sort((a, b) => {
      if (b.precisionRank !== a.precisionRank) {
        return b.precisionRank - a.precisionRank;
      }

      if ((b.colorMatchScore || 0) !== (a.colorMatchScore || 0)) {
        return (b.colorMatchScore || 0) - (a.colorMatchScore || 0);
      }

      return (
        Number.parseFloat(a.price || '0') - Number.parseFloat(b.price || '0')
      );
    });

    if (!hasPreferredColor) {
      return sortedOffers.slice(0, 40);
    }

    const strictColorOffers = sortedOffers.filter(
      (offer) =>
        offer.matchedRequestedColor &&
        !offer.colorConflict,
    );
    if (strictColorOffers.length > 0) {
      return strictColorOffers.slice(0, 40);
    }

    // Sandbox often misses color metadata in listing payloads (parameters/product are empty),
    // so we allow a controlled fallback inferred from query context + strong part match.
    if (
      this.getEnvironment() === 'sandbox' &&
      this.isSandboxColorInferenceEnabled()
    ) {
      const inferredOffers = sortedOffers
        .filter((offer) => {
          const detectedGroups = Array.isArray(offer?.detectedColorGroups)
            ? offer.detectedColorGroups.map((value: any) => Number(value))
            : [];
          const hasColorQueryContext = Boolean(offer?.queryContainsColor);
          const hasConflict = Boolean(offer?.colorConflict);
          const hasDetectedColorGroups = detectedGroups.length > 0;
          const hasOnlyRequestedGroups =
            hasDetectedColorGroups &&
            requestedColorGroups.size > 0 &&
            detectedGroups.every((group) => requestedColorGroups.has(group));
          const hasUnknownColorSignal = !hasDetectedColorGroups;
          const hasStrictRequestedMatch = Boolean(offer?.matchedRequestedColor);
          const hasColorContextSignal =
            hasColorQueryContext || hasStrictRequestedMatch || hasUnknownColorSignal;
          const hasStrongPartMatch = Number(offer?.idMatchScore || 0) >= 900;
          return (
            !hasConflict &&
            (hasUnknownColorSignal || hasOnlyRequestedGroups) &&
            hasColorContextSignal &&
            hasStrongPartMatch
          );
        })
        .map((offer) => ({
          ...offer,
          color: offer.color || colorName || null,
          matchedRequestedColor: Boolean(offer?.matchedRequestedColor),
          colorMatchScore: Math.max(
            offer.colorMatchScore || 0,
            offer?.queryContainsColor ? 2 : 1,
          ),
          matchSource: 'sandbox-query-color-inference',
          inferredColorFromQuery: true,
        }));

      const highConfidenceInferredOffers = inferredOffers.filter(
        (offer) =>
          Boolean(offer?.queryContainsColor) ||
          Boolean(offer?.matchedRequestedColor),
      );

      if (highConfidenceInferredOffers.length > 0) {
        return highConfidenceInferredOffers.slice(0, 40);
      }

      if (!this.isSandboxLooseColorInferenceEnabled()) {
        return [];
      }

      return inferredOffers.slice(0, 40);
    }

    return [];
  }
}
