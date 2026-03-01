import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SetsModule } from '../sets.module';
import { AllegroService } from '../allegro.service';
import { EbayService } from '../ebay.service';
import { ErliService } from '../erli.service';
import { BrickowlService } from '../brickowl.service';

type OfferLike = {
  id?: string;
  name?: string;
  price?: string;
  provider?: string;
  color?: string;
  sellerLogin?: string | null;
  offerUnitQuantity?: number;
  availableOfferUnits?: number | null;
  availablePieceQuantity?: number | null;
};

type ProviderSnapshot = {
  ok: boolean;
  count: number;
  error?: string;
  fingerprint: Array<{
    id: string;
    name: string;
    price: string;
    provider: string;
    color: string;
    sellerLogin: string | null;
    offerUnitQuantity: number | null;
    availableOfferUnits: number | null;
    availablePieceQuantity: number | null;
  }>;
};

function fingerprint(offers: unknown[]): ProviderSnapshot['fingerprint'] {
  return (Array.isArray(offers) ? offers : []).slice(0, 8).map((offer: any) => {
    const normalized = offer as OfferLike;
    return {
      id: String(normalized?.id || ''),
      name: String(normalized?.name || '').slice(0, 90),
      price: String(normalized?.price || ''),
      provider: String(normalized?.provider || ''),
      color: String(normalized?.color || ''),
      sellerLogin: normalized?.sellerLogin ?? null,
      offerUnitQuantity: Number.isFinite(Number(normalized?.offerUnitQuantity))
        ? Number(normalized?.offerUnitQuantity)
        : null,
      availableOfferUnits: Number.isFinite(Number(normalized?.availableOfferUnits))
        ? Number(normalized?.availableOfferUnits)
        : null,
      availablePieceQuantity: Number.isFinite(Number(normalized?.availablePieceQuantity))
        ? Number(normalized?.availablePieceQuantity)
        : null,
    };
  });
}

async function run() {
  const app = await NestFactory.createApplicationContext(SetsModule, {
    logger: false,
  });

  try {
    const allegro = app.get(AllegroService);
    const ebay = app.get(EbayService);
    const erli = app.get(ErliService);
    const brickowl = app.get(BrickowlService);

    const ids = ['3004', '93792', '442413'];
    const color = 'Black';
    const designId = '3004';
    const partName = 'Brick 1 x 2';

    const startedAt = new Date().toISOString();
    const [allegroOffers, ebayOffers, erliOffers, brickowlOffers] = await Promise.all([
      allegro
        .findOffersByExternalIds(ids, color, designId, partName)
        .catch((error) => ({ __error: String(error?.message || error) })),
      ebay
        .findOffersByExternalIds(ids, color, designId, partName)
        .catch((error) => ({ __error: String(error?.message || error) })),
      erli
        .findOffersByExternalIds(ids, color, designId, partName)
        .catch((error) => ({ __error: String(error?.message || error) })),
      brickowl
        .findOffersByExternalIds(ids, color, designId, partName)
        .catch((error) => ({ __error: String(error?.message || error) })),
    ]);

    const asSnapshot = (value: unknown): ProviderSnapshot => {
      if (Array.isArray(value)) {
        return {
          ok: true,
          count: value.length,
          fingerprint: fingerprint(value),
        };
      }

      return {
        ok: false,
        count: 0,
        error: (value as any)?.__error || 'unknown',
        fingerprint: [],
      };
    };

    const output = {
      startedAt,
      input: { ids, color, designId, partName },
      providers: {
        allegro: asSnapshot(allegroOffers),
        ebay: asSnapshot(ebayOffers),
        erli: asSnapshot(erliOffers),
        brickowl: asSnapshot(brickowlOffers),
      },
    };

    process.stdout.write(JSON.stringify(output, null, 2));
  } finally {
    await app.close();
  }
}

run().catch((error) => {
  process.stderr.write(String(error?.stack || error));
  process.exit(1);
});
