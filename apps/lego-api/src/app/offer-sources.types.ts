export type OfferSourceId = 'allegro' | 'ebay' | 'erli' | 'brickowl';

export interface OfferSourceDescriptor {
  id: OfferSourceId;
  label: string;
  enabled: boolean;
  configured: boolean;
  optimizable: boolean;
  description: string;
  requiresEnv: string[];
  supportsSellerRatingPercentFilter?: boolean;
}

export interface OfferLookupInput {
  ids: string[];
  colorName?: string;
  designId?: string;
  partName?: string;
}
