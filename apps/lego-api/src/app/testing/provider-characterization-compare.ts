import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strict as assert } from 'node:assert';

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

type CharacterizationResult = {
  providers: Record<string, ProviderSnapshot>;
};

function readSnapshot(filePath: string): CharacterizationResult {
  const raw = readFileSync(resolve(filePath), 'utf8');
  return JSON.parse(raw) as CharacterizationResult;
}

function stableFingerprint(snapshot: ProviderSnapshot) {
  return snapshot.fingerprint.map((offer) => ({
    id: offer.id,
    provider: offer.provider,
    color: offer.color,
    offerUnitQuantity: offer.offerUnitQuantity,
    availableOfferUnits: offer.availableOfferUnits,
    availablePieceQuantity: offer.availablePieceQuantity,
  }));
}

function compareProvider(
  providerId: string,
  before: ProviderSnapshot,
  after: ProviderSnapshot,
) {
  assert.equal(
    after.ok,
    before.ok,
    `[${providerId}] Expected 'ok' to remain ${before.ok}, got ${after.ok}`,
  );

  assert.equal(
    after.count,
    before.count,
    `[${providerId}] Expected identical offer count (${before.count}), got ${after.count}`,
  );

  if (!before.ok || !after.ok) {
    const beforeError = String(before.error || '');
    const afterError = String(after.error || '');
    assert.equal(
      afterError,
      beforeError,
      `[${providerId}] Expected identical error message.\nBefore: ${beforeError}\nAfter: ${afterError}`,
    );
    return;
  }

  const beforeFingerprint = stableFingerprint(before);
  const afterFingerprint = stableFingerprint(after);
  assert.deepEqual(
    afterFingerprint,
    beforeFingerprint,
    `[${providerId}] Offer fingerprint mismatch`,
  );
}

function main() {
  const beforePath = process.argv[2];
  const afterPath = process.argv[3];

  if (!beforePath || !afterPath) {
    process.stderr.write(
      'Usage: provider-characterization-compare <before.json> <after.json>\n',
    );
    process.exit(1);
  }

  const before = readSnapshot(beforePath);
  const after = readSnapshot(afterPath);
  const providerIds = ['allegro', 'ebay', 'erli', 'brickowl'];

  providerIds.forEach((providerId) => {
    compareProvider(
      providerId,
      before.providers[providerId],
      after.providers[providerId],
    );
  });

  process.stdout.write(
    'Provider characterization comparison passed: allegro, ebay, erli, brickowl.\n',
  );
}

main();
