const PROVIDER_DOMAIN_MAP: Record<string, string> = {
  allegro: 'allegro.pl',
  ebay: 'ebay.com',
  erli: 'erli.pl',
  brickowl: 'brickowl.com',
};

const PROVIDER_AVATAR_TEXT_MAP: Record<string, string> = {
  allegro: 'A',
  ebay: 'e',
  erli: 'E',
  brickowl: 'BO',
};

export function buildProviderLogoUrl(sourceId?: string | null): string {
  const normalizedId = String(sourceId || '').trim().toLowerCase();
  const domain = PROVIDER_DOMAIN_MAP[normalizedId] || 'lego.com';
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

export function buildProviderAvatarText(
  label?: string | null,
  sourceId?: string | null,
): string {
  const normalizedId = String(sourceId || '').trim().toLowerCase();
  if (PROVIDER_AVATAR_TEXT_MAP[normalizedId]) {
    return PROVIDER_AVATAR_TEXT_MAP[normalizedId];
  }

  const normalizedLabel = String(label || '').trim();
  if (!normalizedLabel) return '?';
  return normalizedLabel.slice(0, 2).toUpperCase();
}
