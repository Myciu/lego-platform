const OFFER_COLOR_TOKENS: Array<[string[], string]> = [
  [['black', 'czarny'], '#1f2937'],
  [['white', 'bialy', 'biały'], '#f8fafc'],
  [['red', 'czerw'], '#c81f20'],
  [['blue', 'niebies'], '#1d4ed8'],
  [['green', 'zielon'], '#166534'],
  [['yellow', 'zolty', 'żółty'], '#f4c714'],
  [['orange', 'pomaran'], '#f97316'],
  [['pink', 'rozowy', 'różowy'], '#ec4899'],
  [['purple', 'fiolet'], '#7e22ce'],
  [['brown', 'braz', 'brąz'], '#6b4f3a'],
  [['tan', 'bez', 'beż'], '#d2b48c'],
  [['dark bluish gray', 'dark bluish grey'], '#5f6873'],
  [['light bluish gray', 'light bluish grey'], '#a5b0bb'],
  [['gray', 'grey', 'szary'], '#7b8794'],
  [['turquoise', 'teal'], '#0f8a95'],
  [['lime'], '#84cc16'],
  [['azure'], '#0ea5e9'],
];

export function asCssColor(rgb?: string | null): string {
  if (!rgb) return '#cccccc';
  return rgb.startsWith('#') ? rgb : `#${rgb}`;
}

export function resolveOfferColorPreview(
  colorName?: string | null,
  fallbackRgb?: string | null,
): string {
  const normalized = String(colorName || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  for (const [tokens, hex] of OFFER_COLOR_TOKENS) {
    if (tokens.some((token) => normalized.includes(token))) {
      return hex;
    }
  }

  if (fallbackRgb) {
    return asCssColor(fallbackRgb);
  }

  return '#9ca3af';
}
