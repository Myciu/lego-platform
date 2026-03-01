import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { Script } from 'node:vm';
import { OfferSourceDescriptor } from './offer-sources.types';
import {
  extractAvailableUnitsFromObject,
  extractPackQuantityFromParameter,
  extractPackQuantityFromText,
} from './offer-quantity.utils';

interface ErliListingCacheEntry {
  products: any[];
  expiresAt: number;
}

interface ErliDetailColorInfo {
  manufacturerColors: string[];
  colors: string[];
  packQuantity: number | null;
}

interface ErliDetailCacheEntry {
  value: ErliDetailColorInfo;
  expiresAt: number;
}

@Injectable()
export class ErliService {
  private readonly logger = new Logger(ErliService.name);
  private readonly defaultMarketplaceBaseUrl = 'https://erli.pl';
  private readonly defaultListingPath = '/klocki-pojedyncze-elementy,15817';

  private readonly listingCache = new Map<string, ErliListingCacheEntry>();
  private readonly detailCache = new Map<number, ErliDetailCacheEntry>();
  private readonly listingInFlight = new Map<string, Promise<any[]>>();
  private readonly detailInFlight = new Map<number, Promise<ErliDetailColorInfo>>();

  private readonly PART_NAME_STOP_WORDS = new Set([
    'lego',
    'brick',
    'bricks',
    'plate',
    'plates',
    'tile',
    'tiles',
    'part',
    'parts',
    'piece',
    'pieces',
    'with',
    'without',
    'and',
    'x',
    'cegielka',
    'cegla',
    'klocek',
    'klocki',
  ]);

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
    tan: ['bezowy', 'beżowy'],
    pink: ['rozowy', 'różowy'],
    purple: ['fioletowy'],
    'dark bluish gray': [
      'dark bluish grey',
      'dark stone gray',
      'dark stone grey',
      'dbg',
    ],
    'light bluish gray': [
      'light bluish grey',
      'light stone gray',
      'light stone grey',
      'lbg',
    ],
    'dark turquoise': ['teal'],
    'bright light orange': ['light orange'],
    'bright light blue': ['light blue'],
  };

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {}

  private normalize(value?: string | number | null) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  private parseInteger(
    raw: unknown,
    fallback: number,
    minValue: number,
    maxValue: number,
  ) {
    const parsed = Number.parseInt(String(raw ?? fallback), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maxValue, Math.max(minValue, parsed));
  }

  private isEnabled() {
    const raw = this.normalize(this.config.get<string>('ERLI_ENABLED') || '');
    return raw !== 'false' && raw !== '0' && raw !== 'off';
  }

  private getMarketplaceBaseUrl() {
    const fromEnv = this.config.get<string>('ERLI_MARKETPLACE_BASE_URL')?.trim();
    return fromEnv && fromEnv.length > 0
      ? fromEnv.replace(/\/+$/, '')
      : this.defaultMarketplaceBaseUrl;
  }

  private getListingPath() {
    const fromEnv = this.config.get<string>('ERLI_LISTING_PATH')?.trim();
    if (!fromEnv) return this.defaultListingPath;
    return fromEnv.startsWith('/') ? fromEnv : `/${fromEnv}`;
  }

  private getListingPerPage() {
    return this.parseInteger(this.config.get('ERLI_LISTING_PER_PAGE'), 120, 20, 240);
  }

  private getListingCacheTtlMs() {
    const seconds = this.parseInteger(
      this.config.get('ERLI_LISTING_CACHE_TTL_SECONDS'),
      120,
      20,
      1800,
    );
    return seconds * 1000;
  }

  private getDetailCacheTtlMs() {
    const seconds = this.parseInteger(
      this.config.get('ERLI_DETAIL_CACHE_TTL_SECONDS'),
      900,
      30,
      7200,
    );
    return seconds * 1000;
  }

  private getMaxOffers() {
    return this.parseInteger(this.config.get('ERLI_MAX_OFFERS'), 40, 5, 100);
  }

  private getDetailProbeLimit() {
    return this.parseInteger(this.config.get('ERLI_DETAIL_PROBE_LIMIT'), 80, 5, 160);
  }

  private getMaxQueries() {
    return this.parseInteger(this.config.get('ERLI_MAX_QUERIES'), 4, 1, 8);
  }

  getSourceDescriptor(): OfferSourceDescriptor {
    return {
      id: 'erli',
      label: 'Erli',
      enabled: this.isEnabled(),
      configured: true,
      optimizable: true,
      description:
        'Oferty z marketplace Erli (publiczny listing kategorii części LEGO + precyzyjne dopasowanie koloru).',
      requiresEnv: [],
      supportsSellerRatingPercentFilter: true,
    };
  }

  private async requestHtml(url: string) {
    const response = await firstValueFrom(
      this.httpService.get<string>(url, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 brickomat.pl/1.0',
        },
        responseType: 'text',
        maxRedirects: 5,
      }),
    );

    return String(response.data || '');
  }

  private extractReduxStateFromHtml(html: string) {
    const match = html.match(
      /window\.__REDUX_STATE__=(\{[\s\S]*?\});window\.__EXTERNAL_DATA__/,
    );

    if (!match?.[1]) {
      return null;
    }

    try {
      const sandbox: Record<string, unknown> = {
        window: {},
        Date,
      };

      const script = new Script(`window.__REDUX_STATE__=${match[1]};`);
      script.runInNewContext(sandbox, {
        timeout: 3500,
      });

      return (sandbox.window as any)?.__REDUX_STATE__ || null;
    } catch (error) {
      this.logger.warn(`Erli: nie udało się sparsować __REDUX_STATE__: ${String(error)}`);
      return null;
    }
  }

  private buildListingUrl(phrase: string, page = 1) {
    const base = this.getMarketplaceBaseUrl();
    const path = this.getListingPath();
    const params = new URLSearchParams();

    params.set('phrase', phrase);
    params.set('page', String(page));
    params.set('perPage', String(this.getListingPerPage()));

    return `${base}${path}?${params.toString()}`;
  }

  private buildProductUrl(product: any) {
    const id = Number(product?.id);
    const slug = String(product?.slug || '').trim();

    if (slug && Number.isFinite(id) && id > 0) {
      return `${this.getMarketplaceBaseUrl()}/produkt/${encodeURIComponent(slug)},${id}`;
    }

    if (Number.isFinite(id) && id > 0) {
      return `${this.getMarketplaceBaseUrl()}/produkt/${id}`;
    }

    if (slug) {
      return `${this.getMarketplaceBaseUrl()}/produkt/${encodeURIComponent(slug)}`;
    }

    return this.getMarketplaceBaseUrl();
  }

  private toThumbnail(baseUrl?: string | null) {
    const normalized = String(baseUrl || '').trim();
    if (!normalized) return null;

    if (/\.(jpe?g|png|webp|gif)$/i.test(normalized)) {
      return normalized;
    }

    return `${normalized}.l.webp`;
  }

  private extractPartDimensions(partName?: string) {
    const normalized = this.normalize(partName || '');
    const matches = normalized.match(/\d+\s*x\s*\d+/g) || [];
    return Array.from(new Set(matches.map((entry) => entry.replace(/\s+/g, ''))));
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
            (token) => token.length >= 2 && !this.PART_NAME_STOP_WORDS.has(token),
          ),
      ),
    );
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

  private hasLooseColorMatch(text: string, strictColorLabels: Set<string>) {
    if (strictColorLabels.size === 0) return true;
    const normalizedText = this.normalize(text);
    if (!normalizedText) return false;

    return Array.from(strictColorLabels.values()).some((label) => {
      if (!label) return false;
      return (
        normalizedText === label ||
        normalizedText.includes(` ${label} `) ||
        normalizedText.startsWith(`${label} `) ||
        normalizedText.endsWith(` ${label}`) ||
        normalizedText.includes(`-${label}`) ||
        normalizedText.includes(`${label}-`)
      );
    });
  }

  private hasStrictColorLabelMatch(value: string, strictColorLabels: Set<string>) {
    if (strictColorLabels.size === 0) return true;
    const normalizedValue = this.normalize(value);
    if (!normalizedValue) return false;
    return strictColorLabels.has(normalizedValue);
  }

  private hasRequestedIdMatch(corpus: string, requestedIds: string[]) {
    return requestedIds.some((rawId) => {
      const id = this.normalize(rawId);
      if (!id) return false;

      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
      return regex.test(corpus);
    });
  }

  private buildQueries(
    requestedIds: string[],
    designId?: string,
    partName?: string,
    colorName?: string,
  ) {
    const normalizedDesignId = String(designId || '').trim();
    const normalizedPartName = this.normalize(partName || '')
      .replace(/(\d)\s*x\s*(\d)/g, '$1 x $2')
      .replace(/\s+/g, ' ')
      .trim();
    const normalizedColor = this.normalize(colorName || '').trim();
    const primaryId = normalizedDesignId || String(requestedIds[0] || '').trim();

    const phrases: string[] = [];
    const push = (phrase: string) => {
      const normalizedPhrase = phrase.replace(/\s+/g, ' ').trim();
      if (!normalizedPhrase) return;
      if (phrases.includes(normalizedPhrase)) return;
      phrases.push(normalizedPhrase);
    };

    if (primaryId && normalizedPartName && normalizedColor) {
      push(`lego ${primaryId} ${normalizedPartName} ${normalizedColor}`);
    }
    if (primaryId && normalizedPartName) {
      push(`lego ${primaryId} ${normalizedPartName}`);
    }
    if (primaryId && normalizedColor) {
      push(`lego ${primaryId} ${normalizedColor}`);
    }
    if (primaryId) {
      push(`lego ${primaryId}`);
    }
    if (normalizedPartName && normalizedColor) {
      push(`lego ${normalizedPartName} ${normalizedColor}`);
    }
    if (normalizedPartName) {
      push(`lego ${normalizedPartName}`);
    }

    return phrases.slice(0, this.getMaxQueries());
  }

  private async fetchListingProductsByPhrase(phrase: string) {
    const cacheKey = this.normalize(phrase);
    const cached = this.listingCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.products;
    }

    const inFlight = this.listingInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async () => {
      const url = this.buildListingUrl(phrase, 1);
      const html = await this.requestHtml(url);
      const state = this.extractReduxStateFromHtml(html);
      const products = Array.isArray(state?.productListing?.products)
        ? state.productListing.products
        : [];

      this.listingCache.set(cacheKey, {
        products,
        expiresAt: Date.now() + this.getListingCacheTtlMs(),
      });

      return products;
    })();

    this.listingInFlight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.listingInFlight.delete(cacheKey);
    }
  }

  private extractColorInfoFromAttributes(attributes: any[]): ErliDetailColorInfo {
    const info: ErliDetailColorInfo = {
      manufacturerColors: [],
      colors: [],
      packQuantity: null,
    };

    for (const attribute of attributes || []) {
      const slug = this.normalize(attribute?.slug || attribute?.name || '');
      const values = Array.isArray(attribute?.stringValues)
        ? attribute.stringValues
            .map((entry: unknown) => String(entry || '').trim())
            .filter((entry: string) => entry.length > 0)
        : [];

      if (values.length === 0) continue;

      if (slug === 'kolorproducenta' || slug === 'manufacturercolor') {
        info.manufacturerColors.push(...values);
      }
      if (slug === 'kolor' || slug === 'color') {
        info.colors.push(...values);
      }

      const packQuantity = extractPackQuantityFromParameter(
        attribute?.name || attribute?.slug,
        attribute?.stringValues || attribute?.values || values,
      );
      if (packQuantity && (!info.packQuantity || packQuantity > info.packQuantity)) {
        info.packQuantity = packQuantity;
      }
    }

    info.manufacturerColors = Array.from(new Set(info.manufacturerColors));
    info.colors = Array.from(new Set(info.colors));

    return info;
  }

  private async fetchProductColorDetails(product: any): Promise<ErliDetailColorInfo> {
    const productId = Number(product?.id);
    if (!Number.isFinite(productId) || productId <= 0) {
      return {
        manufacturerColors: [],
        colors: [],
        packQuantity: null,
      };
    }

    const cached = this.detailCache.get(productId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const inFlight = this.detailInFlight.get(productId);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async () => {
      const url = this.buildProductUrl(product);
      const html = await this.requestHtml(url);
      const state = this.extractReduxStateFromHtml(html);
      const attributes = Array.isArray(state?.currentProduct?.product?.attributes)
        ? state.currentProduct.product.attributes
        : [];

      const parsed = this.extractColorInfoFromAttributes(attributes);

      this.detailCache.set(productId, {
        value: parsed,
        expiresAt: Date.now() + this.getDetailCacheTtlMs(),
      });

      return parsed;
    })().catch(() => ({
      manufacturerColors: [],
      colors: [],
      packQuantity: null,
    }));

    this.detailInFlight.set(productId, promise);
    try {
      return await promise;
    } finally {
      this.detailInFlight.delete(productId);
    }
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

    const requestedIds = Array.from(
      new Set(
        [...ids.slice(0, 12), designId || '']
          .map((entry) => String(entry || '').trim())
          .filter((entry) => entry.length > 0),
      ),
    );

    if (requestedIds.length === 0 && !partName) {
      return [];
    }

    const strictColorLabels = this.buildStrictColorLabels(colorName);
    const hasColorFilter = strictColorLabels.size > 0;
    const partNameTokens = this.extractPartNameTokens(partName);
    const partDimensions = this.extractPartDimensions(partName);
    const minTokenHits = partNameTokens.length > 0 ? Math.min(2, partNameTokens.length) : 0;

    const queries = this.buildQueries(requestedIds, designId, partName, colorName);
    if (queries.length === 0) {
      return [];
    }

    try {
      const collected = new Map<number, any>();

      for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
        const query = queries[queryIndex];
        const products = await this.fetchListingProductsByPhrase(query);
        const queryWeight = Math.max(0, queries.length - queryIndex) * 80;

        for (const product of products) {
          const id = Number(product?.id);
          const name = String(product?.name || '').trim();
          const slug = String(product?.slug || '').trim();
          if (!Number.isFinite(id) || id <= 0 || !name) continue;

          const corpus = this.normalize(`${name} ${slug}`);
          const idExactMatch = this.hasRequestedIdMatch(corpus, requestedIds);

          const tokenHits = partNameTokens.reduce((acc, token) => {
            return acc + (corpus.includes(token) ? 1 : 0);
          }, 0);

          const dimensionHits = partDimensions.filter((dim) => corpus.includes(dim)).length;

          const hasPartSignal =
            idExactMatch ||
            (minTokenHits > 0 &&
              tokenHits >= minTokenHits &&
              (partDimensions.length === 0 || dimensionHits > 0)) ||
            (requestedIds.length === 0 && minTokenHits > 0 && tokenHits >= minTokenHits);

          if (!hasPartSignal) continue;

          const rank =
            1200 +
            queryWeight +
            (idExactMatch ? 1300 : 0) +
            tokenHits * 140 +
            dimensionHits * 220;

          const existing = collected.get(id);
          if (!existing || rank > existing.__partRank) {
            collected.set(id, {
              ...product,
              __partRank: rank,
              __query: query,
            });
          }
        }
      }

      let candidates = Array.from(collected.values())
        .sort((a, b) => {
          if ((b.__partRank || 0) !== (a.__partRank || 0)) {
            return (b.__partRank || 0) - (a.__partRank || 0);
          }

          const aPrice = Number(a?.price || 0);
          const bPrice = Number(b?.price || 0);
          return aPrice - bPrice;
        })
        .slice(0, 120);

      if (hasColorFilter && candidates.length > 0) {
        const colorPrefiltered = candidates.filter((candidate) =>
          this.hasLooseColorMatch(
            `${candidate?.name || ''} ${candidate?.slug || ''}`,
            strictColorLabels,
          ),
        );

        const probePool = colorPrefiltered.length > 0 ? colorPrefiltered : candidates;
        const probeLimit = Math.min(this.getDetailProbeLimit(), probePool.length);
        const withDetails = await Promise.all(
          probePool.slice(0, probeLimit).map(async (candidate) => {
            const detail = await this.fetchProductColorDetails(candidate);
            return {
              ...candidate,
              __detailColor: detail,
            };
          }),
        );

        const detailById = new Map<number, ErliDetailColorInfo>();
        withDetails.forEach((entry) => {
          const id = Number(entry?.id);
          if (Number.isFinite(id) && id > 0) {
            detailById.set(id, entry.__detailColor || {
              manufacturerColors: [],
              colors: [],
              packQuantity: null,
            });
          }
        });

        candidates = probePool
          .map((candidate) => {
            const id = Number(candidate?.id);
            const detail = detailById.get(id) || {
              manufacturerColors: [],
              colors: [],
              packQuantity: null,
            };
            const manufacturerLabels = detail.manufacturerColors
              .map((entry) => this.normalize(entry))
              .filter((entry) => entry.length > 0);
            const genericLabels = detail.colors
              .map((entry) => this.normalize(entry))
              .filter((entry) => entry.length > 0);

            const hasDetailColor = manufacturerLabels.length > 0 || genericLabels.length > 0;
            const labelsForStrictMatch =
              manufacturerLabels.length > 0 ? manufacturerLabels : genericLabels;

            const detailColorMatch = hasDetailColor
              ? labelsForStrictMatch.some((label) =>
                  this.hasStrictColorLabelMatch(label, strictColorLabels),
                )
              : false;
            const textColorMatch = this.hasLooseColorMatch(
              `${candidate?.name || ''} ${candidate?.slug || ''}`,
              strictColorLabels,
            );

            return {
              ...candidate,
              __detailColor: detail,
              __matchedRequestedColor: hasDetailColor ? detailColorMatch : textColorMatch,
              __hasDetailColor: hasDetailColor,
              __colorMatchScore:
                (detailColorMatch ? 4 : 0) +
                (hasDetailColor ? 1 : 0),
            };
          })
          .filter(
            (candidate) =>
              Boolean(candidate.__hasDetailColor) &&
              Boolean(candidate.__matchedRequestedColor),
          );
      }

      return candidates
        .sort((a, b) => {
          if ((b.__partRank || 0) !== (a.__partRank || 0)) {
            return (b.__partRank || 0) - (a.__partRank || 0);
          }
          if ((b.__colorMatchScore || 0) !== (a.__colorMatchScore || 0)) {
            return (b.__colorMatchScore || 0) - (a.__colorMatchScore || 0);
          }
          return Number(a?.price || 0) - Number(b?.price || 0);
        })
        .slice(0, this.getMaxOffers())
        .map((product) => {
          const cents = Number(product?.price);
          const shippingCents = Number(product?.deliveryMinPrice);
          const colorInfo: ErliDetailColorInfo = product.__detailColor || {
            manufacturerColors: [],
            colors: [],
            packQuantity: null,
          };

          const resolvedColor =
            colorInfo.manufacturerColors[0] || colorInfo.colors[0] || null;
          const unitQuantity =
            colorInfo.packQuantity ||
            extractPackQuantityFromText(String(product?.name || '')) ||
            1;
          const availableOfferUnits = extractAvailableUnitsFromObject(product, 2);

          const shopId = Number(product?.shop?.shopId);
          const shopName = String(product?.shop?.name || '').trim();
          const positivesPercentRaw = Number(
            product?.shop?.shopRatings?.positivesPercent,
          );
          const positivesAmountRaw = Number(
            product?.shop?.shopRatings?.positivesAmount,
          );
          const negativesAmountRaw = Number(
            product?.shop?.shopRatings?.negativesAmount,
          );
          const sellerReviewsCount =
            Number.isFinite(positivesAmountRaw) && Number.isFinite(negativesAmountRaw)
              ? Math.max(0, positivesAmountRaw + negativesAmountRaw)
              : null;

          return {
            id: `erli-${product.id}`,
            name: String(product?.name || '').trim(),
            price: Number.isFinite(cents) ? (cents / 100).toFixed(2) : '0.00',
            currency: 'PLN',
            url: this.buildProductUrl(product),
            thumbnail: this.toThumbnail(product?.images?.[0]?.baseUrl),
            sellerId:
              Number.isFinite(shopId) && shopId > 0
                ? `erli-shop-${shopId}`
                : 'erli-shop-unknown',
            sellerLogin: shopName || 'Erli Shop',
            sellerFeedbackPercent: Number.isFinite(positivesPercentRaw)
              ? positivesPercentRaw
              : null,
            sellerFeedbackScore: Number.isFinite(positivesAmountRaw)
              ? positivesAmountRaw
              : null,
            sellerReviewsCount,
            deliveryLowestPrice:
              Number.isFinite(shippingCents) && shippingCents >= 0
                ? (shippingCents / 100).toFixed(2)
                : null,
            deliveryCurrency: 'PLN',
            shippingMissingPrice: !(Number.isFinite(shippingCents) && shippingCents >= 0),
            offerUnitQuantity: unitQuantity,
            offerUnitQuantitySource: colorInfo.packQuantity
              ? 'erli-product-attributes'
              : unitQuantity > 1
                ? 'erli-title'
                : 'default',
            availableOfferUnits,
            availablePieceQuantity:
              availableOfferUnits !== null ? availableOfferUnits * unitQuantity : null,
            color: resolvedColor,
            requestedColorName: colorName || null,
            matchedRequestedColor: hasColorFilter
              ? Boolean(product.__matchedRequestedColor)
              : true,
            colorConflict: hasColorFilter ? !Boolean(product.__matchedRequestedColor) : false,
            colorMatchScore: Number(product.__colorMatchScore || 0),
            precisionRank: Number(product.__partRank || 0),
            matchSource:
              hasColorFilter && product.__hasDetailColor
                ? 'erli-listing+product-detail-color'
                : 'erli-listing',
            queryContainsColor: hasColorFilter,
            queryContainsPartName: partNameTokens.length > 0,
            provider: 'erli',
            providerLabel: 'Erli',
            isEstimated: false,
          };
        });
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      const message =
        error?.response?.data?.message ||
        error?.response?.data?.error ||
        error?.message ||
        'Unknown Erli marketplace error';

      this.logger.warn(`Erli marketplace search failed [HTTP ${status || 'n/a'}]: ${String(message)}`);
      return [];
    }
  }
}
