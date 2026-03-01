import { strict as assert } from 'node:assert';
import { OfferProviderGateway } from '../offer-provider.gateway';
import { OfferSourceDescriptor, OfferSourceId } from '../offer-sources.types';

type CallRecord = {
  ids: string[];
  colorName?: string;
  designId?: string;
  partName?: string;
};

function createMockProvider(id: OfferSourceId, calls: Map<OfferSourceId, CallRecord[]>) {
  const descriptor: OfferSourceDescriptor = {
    id,
    label: id.toUpperCase(),
    enabled: true,
    configured: true,
    optimizable: true,
    description: `${id} mock`,
    requiresEnv: [],
  };

  return {
    getSourceDescriptor: () => descriptor,
    findOffersByExternalIds: async (
      ids: string[],
      colorName?: string,
      designId?: string,
      partName?: string,
    ) => {
      const current = calls.get(id) || [];
      current.push({ ids, colorName, designId, partName });
      calls.set(id, current);
      return [
        {
          id: `${id}-offer`,
          provider: id,
          color: colorName || null,
          designId: designId || null,
          partName: partName || null,
        },
      ];
    },
  };
}

async function run() {
  const calls = new Map<OfferSourceId, CallRecord[]>();
  const allegro = createMockProvider('allegro', calls);
  const ebay = createMockProvider('ebay', calls);
  const erli = createMockProvider('erli', calls);
  const brickowl = createMockProvider('brickowl', calls);

  const gateway = new OfferProviderGateway(
    allegro as any,
    ebay as any,
    erli as any,
    brickowl as any,
  );

  const descriptors = gateway.getSourceDescriptors();
  assert.equal(descriptors.length, 4, 'Expected 4 source descriptors');
  assert.deepEqual(
    descriptors.map((descriptor) => descriptor.id).sort(),
    ['allegro', 'brickowl', 'ebay', 'erli'],
  );

  const payload = {
    ids: ['3001', '54534'],
    colorName: 'Black',
    designId: '3001',
    partName: 'Brick 2 x 4',
  };

  for (const providerId of ['allegro', 'ebay', 'erli', 'brickowl'] as OfferSourceId[]) {
    const offers = await gateway.findOffers(providerId, payload);
    assert.equal(offers.length, 1, `[${providerId}] Expected single mock offer`);
    assert.equal(
      offers[0]?.provider,
      providerId,
      `[${providerId}] Expected provider marker in offer`,
    );
  }

  for (const providerId of ['allegro', 'ebay', 'erli', 'brickowl'] as OfferSourceId[]) {
    const providerCalls = calls.get(providerId) || [];
    assert.equal(providerCalls.length, 1, `[${providerId}] Expected one invocation`);
    assert.deepEqual(providerCalls[0], payload, `[${providerId}] Invocation payload mismatch`);
  }

  const unknown = await gateway.findOffers('allegro', {
    ids: [],
  });
  assert.ok(Array.isArray(unknown), 'Expected array response for valid provider');

  process.stdout.write(
    'OfferProviderGateway contract passed for allegro, ebay, erli, brickowl.\n',
  );
}

run().catch((error) => {
  process.stderr.write(String(error?.stack || error));
  process.exit(1);
});
