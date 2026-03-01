export interface PartColorOption {
  color_id: number;
  color_name: string;
  color_rgb: string;
  is_trans?: boolean;
}

export interface Part {
  id: number;
  designId: string;
  name: string;
  imageUrl: string | null;
  partCatId: number | null;
  partCategoryName: string | null;
  partIds: {
    [key: string]: string[];
  };
  colorInfo: {
    colors: PartColorOption[];
    totalColors: number;
  };
}

export interface PartCategory {
  id: number;
  name: string;
  partCount: number;
  isDefault: boolean;
}

export interface PartFilterColor {
  id: number;
  name: string;
  rgb: string;
  isTrans: boolean | null;
  partCount: number;
}

export interface BatchOfferPartRequest {
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

export interface AllegroPartOffer {
  id: string;
  name: string;
  price: string;
  currency: string;
  url: string;
  thumbnail?: string | null;
  color?: string;
  offerUnitQuantity?: number;
  offerUnitQuantitySource?: string;
  availableOfferUnits?: number | null;
  availablePieceQuantity?: number | null;
  provider?: string;
  providerLabel?: string;
  isEstimated?: boolean;
  colorMatchScore?: number;
  precisionRank?: number;
  matchedByColorParameter?: boolean;
  colorFilterName?: string | null;
  matchSource?: string;
  sellerId?: string | null;
  sellerLogin?: string | null;
  sellerCountry?: string | null;
  sellerCountryCode?: string | null;
  sellerCountryFlagUrl?: string | null;
  sellerIsCompany?: boolean;
  sellerIsSuperSeller?: boolean;
  sellerIsTopRated?: boolean;
  sellerFeedbackPercent?: number | null;
  sellerFeedbackScore?: number | null;
  sellerReviewsCount?: number | null;
  deliveryLowestPrice?: string | null;
  deliveryCurrency?: string | null;
  shippingMissingPrice?: boolean;
  requestedColorName?: string | null;
  colorDetectedFromOffer?: boolean;
  matchedRequestedColor?: boolean;
  colorConflict?: boolean;
  queryContainsColor?: boolean;
  queryContainsPartName?: boolean;
}

export interface BatchOfferResult {
  key: string;
  id: number;
  designId: string | null;
  partName: string | null;
  selectedColorId: number | null;
  selectedColorName: string | null;
  selectedColorRgb: string | null;
  quantity?: number | null;
  offers: AllegroPartOffer[];
}

export interface OfferSourceDescriptor {
  id: string;
  label: string;
  enabled: boolean;
  configured: boolean;
  optimizable: boolean;
  description: string;
  requiresEnv: string[];
  supportsSellerRatingPercentFilter?: boolean;
}

export interface CartOfferSelection {
  partKey: string;
  partName: string;
  requestedColorName: string | null;
  requestedQuantity: number;
  offerColor: string | null;
  offerId: string;
  offerName: string;
  offerUrl: string;
  provider: string | null;
  offerUnitQuantity?: number;
  offerUnitsToBuy?: number;
  offeredPieceQuantity?: number;
  unitOfferPrice: number;
  offerPrice: number;
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

export interface CartOfferSummary {
  mode: 'single_seller' | 'mixed_sellers';
  sellerId: string | null;
  sellerLogin: string | null;
  sellersCount: number;
  coveredParts: number;
  missingPartKeys: string[];
  missingPartNames: string[];
  itemsTotal: number;
  estimatedShippingTotal: number;
  estimatedGrandTotal: number;
  currency: string;
  selections: CartOfferSelection[];
}

export interface CartOptimizationSummary {
  partsCount: number;
  partsWithAnyOffers: number;
  currency: string;
  cheapestMixed: CartOfferSummary | null;
  mixedRanking: CartOfferSummary[];
  bestSingleSeller: CartOfferSummary | null;
  bestPartialSingleSeller: CartOfferSummary | null;
  topSingleSellerAlternatives: CartOfferSummary[];
}

export interface ProviderOfferDiagnostics {
  providerId: string;
  cacheHits: number;
  cacheMisses: number;
  inFlightHits: number;
  cooldownSkips: number;
  requestsStarted: number;
  requestsSucceeded: number;
  requestsFailed: number;
  offersReturned: number;
  avgDurationMs: number | null;
  minDurationMs: number | null;
  maxDurationMs: number | null;
  maxConcurrency: number;
  minIntervalMs: number;
  cooldownMs: number;
  cooldownRemainingMs: number;
}

export interface BatchOffersDiagnostics {
  enabled: boolean;
  requestStartedAt: string;
  requestFinishedAt: string;
  totalDurationMs: number;
  partsCount: number;
  providersRequested: string[];
  providersResolved: string[];
  partConcurrency: number;
  providerConcurrency: number;
  cacheTtlMs: number;
  fetchOffersMs: number;
  optimizationMs: number;
  providerStats: ProviderOfferDiagnostics[];
}

export interface BatchOffersResponse {
  results: BatchOfferResult[];
  optimization: CartOptimizationSummary | null;
  selectedProviders?: string[];
  availableSources?: OfferSourceDescriptor[];
  diagnostics?: BatchOffersDiagnostics | null;
}

export interface OfferSourcesResponse {
  sources: OfferSourceDescriptor[];
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  lastPage: number;
  limit: number;
}
