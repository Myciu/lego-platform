import { Injectable } from '@nestjs/common';
import { AllegroService } from './allegro.service';
import { BrickowlService } from './brickowl.service';
import { EbayService } from './ebay.service';
import { ErliService } from './erli.service';
import {
  OfferLookupInput,
  OfferSourceDescriptor,
  OfferSourceId,
} from './offer-sources.types';

type OfferProviderService = {
  getSourceDescriptor: () => OfferSourceDescriptor;
  findOffersByExternalIds: (
    ids: string[],
    colorName?: string,
    designId?: string,
    partName?: string,
  ) => Promise<any[]>;
};

@Injectable()
export class OfferProviderGateway {
  constructor(
    private readonly allegro: AllegroService,
    private readonly ebay: EbayService,
    private readonly erli: ErliService,
    private readonly brickowl: BrickowlService,
  ) {}

  private getProviderServices(): Record<OfferSourceId, OfferProviderService> {
    return {
      allegro: this.allegro,
      ebay: this.ebay,
      erli: this.erli,
      brickowl: this.brickowl,
    };
  }

  getSourceDescriptors(): OfferSourceDescriptor[] {
    return Object.values(this.getProviderServices()).map((service) =>
      service.getSourceDescriptor(),
    );
  }

  async findOffers(providerId: OfferSourceId, input: OfferLookupInput): Promise<any[]> {
    const provider = this.getProviderServices()[providerId];
    if (!provider) return [];

    return provider.findOffersByExternalIds(
      input.ids,
      input.colorName,
      input.designId,
      input.partName,
    );
  }
}
