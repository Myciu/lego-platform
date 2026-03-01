import { OfferSourceId } from './offer-sources.types';

export interface BatchOfferRequestItem {
  key: string;
  id: number;
  designId: string;
  partName: string;
  partIds: string[];
  selectedColorId: number | null;
  selectedColorName: string | null;
  selectedColorRgb: string | null;
  quantity?: number | null;
}

export interface NormalizedBatchOfferRequestItem extends BatchOfferRequestItem {
  requestedQuantity: number;
}

export interface OfferPriceSelection {
  partKey: string;
  partName: string;
  requestedColorName: string | null;
  requestedQuantity: number;
  offerColor: string | null;
  offerId: string;
  offerName: string;
  offerUrl: string;
  provider: string | null;
  offerUnitQuantity: number;
  offerUnitsToBuy: number;
  offeredPieceQuantity: number;
  overPurchasedPieces: number;
  unitOfferPrice: number;
  offerPrice: number;
  finalLineScore: number;
  offerCurrency: string;
  estimatedDeliveryPrice: number;
  shippingMissingPrice?: boolean;
  availableOfferUnits?: number | null;
  availablePieceQuantity?: number | null;
  insufficientAvailability?: boolean;
  missingPieces?: number;
  sellerId: string | null;
  sellerLogin: string | null;
  sellerCountryCode?: string | null;
  sellerCountryFlagUrl?: string | null;
  sellerIsSuperSeller?: boolean;
  sellerIsTopRated?: boolean;
  sellerFeedbackPercent?: number | null;
  sellerFeedbackScore?: number | null;
  sellerReviewsCount?: number | null;
}

export interface OfferPriceSummary {
  mode: 'single_seller' | 'mixed_sellers';
  sellerId: string | null;
  sellerLogin: string | null;
  sellersCount: number;
  coveredParts: number;
  missingPartKeys: string[];
  missingPartNames: string[];
  itemsTotal: number;
  estimatedShippingTotal: number;
  oversupplyPenaltyTotal: number;
  customerObjectiveTotal: number;
  estimatedGrandTotal: number;
  currency: string;
  selections: OfferPriceSelection[];
}

export interface CartOptimizationSummary {
  partsCount: number;
  partsWithAnyOffers: number;
  currency: string;
  cheapestMixed: OfferPriceSummary | null;
  mixedRanking: OfferPriceSummary[];
  bestSingleSeller: OfferPriceSummary | null;
  bestPartialSingleSeller: OfferPriceSummary | null;
  topSingleSellerAlternatives: OfferPriceSummary[];
}

export interface ProviderOfferCacheEntry {
  value: any[];
  expiresAt: number;
}

export interface MixedRankingState {
  selections: Map<string, any>;
  itemsTotal: number;
  oversupplyPenaltyTotal: number;
  shippingBySeller: Map<string, number>;
  offerUnitsByIdentity: Map<string, number>;
  estimatedTotal: number;
  customerObjectiveTotal: number;
  sellersCount: number;
}

export interface ProviderRateLimiterState {
  active: number;
  queue: Array<() => void>;
  nextAllowedAt: number;
}

export interface ProviderDailyUsageState {
  dayKey: string;
  count: number;
}

export interface ProviderOfferDiagnosticsAccumulator {
  providerId: OfferSourceId;
  cacheHits: number;
  cacheMisses: number;
  inFlightHits: number;
  cooldownSkips: number;
  deadlineSkips: number;
  dailyLimitSkips: number;
  requestsStarted: number;
  requestsSucceeded: number;
  requestsFailed: number;
  offersReturned: number;
  durationTotalMs: number;
  minDurationMs: number | null;
  maxDurationMs: number | null;
}

export interface BatchOffersDiagnosticsAccumulator {
  startedAtMs: number;
  fetchOffersStartedAtMs: number;
  fetchOffersFinishedAtMs: number;
  optimizationStartedAtMs: number;
  optimizationFinishedAtMs: number;
  requestTimeoutMs: number;
  deadlineGuardMs: number;
  phasedFetchEnabled: boolean;
  partsCount: number;
  providersRequested: string[];
  providersResolved: OfferSourceId[];
  phaseOneProviders: OfferSourceId[];
  phaseTwoProviders: OfferSourceId[];
  phaseTwoPartsCount: number;
  phaseTwoSkippedDueDeadline: boolean;
  partConcurrency: number;
  providerConcurrency: number;
  cacheTtlMs: number;
  providerStats: Map<OfferSourceId, ProviderOfferDiagnosticsAccumulator>;
}
