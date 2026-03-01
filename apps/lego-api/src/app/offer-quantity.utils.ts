export function normalizeQuantityText(value?: string | null): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function parsePositiveInteger(
  raw: unknown,
  min = 1,
  max = 1_000_000,
): number | null {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < min || parsed > max) return null;
  return parsed;
}

export function extractPackQuantityFromText(value?: string | null): number | null {
  const normalized = normalizeQuantityText(value);
  if (!normalized) return null;

  const withoutDimensions = normalized.replace(/\b\d{1,2}\s*[x×]\s*\d{1,2}\b/g, ' ');

  const collectMatches = (
    pattern: RegExp,
    priority: number,
    target: Array<{ quantity: number; priority: number }>,
  ) => {
    let found: RegExpExecArray | null;
    while ((found = pattern.exec(withoutDimensions))) {
      const quantity = parsePositiveInteger(found[1], 2, 5000);
      if (!quantity) continue;
      target.push({ quantity, priority });
    }
  };

  const scoredMatches: Array<{ quantity: number; priority: number }> = [];
  collectMatches(
    /\b(\d{1,4})\s*(?:szt\.?|sztuk(?:a|i)?|pcs?\.?|pieces?|pack(?:s|ow|i)?|opak\.?|opakowania?)\b/gi,
    3,
    scoredMatches,
  );
  collectMatches(
    /\b(\d{1,4})\s*(?:[-–]\s*)?(?:pak|pakiet|zestaw|set|lot)\b/gi,
    3,
    scoredMatches,
  );
  collectMatches(
    /\b(?:pak|pakiet|zestaw|set|lot)\s*(?:po\s*|x\s*)?(\d{1,4})\b/gi,
    3,
    scoredMatches,
  );
  collectMatches(/\b(?:qty|quantity)\s*[:=]?\s*(\d{1,4})\b/gi, 3, scoredMatches);
  collectMatches(/\b(?:ilosc|ilość)\s*[:=]?\s*(\d{1,4})\b/gi, 3, scoredMatches);
  collectMatches(/\b(?:w\s*(?:zestawie|opakowaniu))\s*(\d{1,4})\b/gi, 3, scoredMatches);
  collectMatches(
    /\b(?:pakiet|zestaw|set|lot)\s*(?:po\s*)?(\d{1,4})\b/gi,
    3,
    scoredMatches,
  );
  collectMatches(/(?:^|[^a-z0-9])x\s*(\d{1,4})(?=$|[^a-z0-9])/gi, 2, scoredMatches);
  collectMatches(/(?:^|[^a-z0-9])(\d{1,4})\s*[x×](?=\s*(?:szt|pcs|piece|brick|part|klocek|cegla))/gi, 2, scoredMatches);
  collectMatches(
    /(?:^|[^a-z0-9])(\d{1,4})\s*[x×]\s*(?:lego|brick(?:s)?|part(?:s)?|piece(?:s)?|szt\.?|pcs?\.?)(?=$|[^a-z0-9])/gi,
    2,
    scoredMatches,
  );
  collectMatches(/(?:^|[^a-z0-9])(\d{1,4})\s*[x×](?=\s*[a-z])/gi, 1, scoredMatches);
  collectMatches(/(?:^|[^a-z0-9])(\d{1,4})\s*[x×](?=$|[^a-z0-9])/gi, 1, scoredMatches);

  if (scoredMatches.length === 0) return null;

  const bestPriority = Math.max(...scoredMatches.map((entry) => entry.priority));
  const bestByPriority = scoredMatches
    .filter((entry) => entry.priority === bestPriority)
    .map((entry) => entry.quantity);
  return Math.max(...bestByPriority);
}

function valueToStrings(rawValue: unknown): string[] {
  if (Array.isArray(rawValue)) {
    return rawValue
      .flatMap((entry) => valueToStrings(entry))
      .filter((entry) => entry.length > 0);
  }

  if (rawValue && typeof rawValue === 'object') {
    const record = rawValue as Record<string, unknown>;
    return ['name', 'label', 'value', 'text', 'valuesLabel']
      .map((key) => String(record[key] || '').trim())
      .filter((entry) => entry.length > 0);
  }

  const scalar = String(rawValue || '').trim();
  return scalar.length > 0 ? [scalar] : [];
}

function isQuantityHintParameter(name: string): boolean {
  const normalized = normalizeQuantityText(name);
  if (!normalized) return false;

  return [
    'liczba sztuk',
    'ilosc sztuk',
    'ilosc elementow',
    'liczba elementow',
    'sztuk w opakowaniu',
    'sztuk',
    'quantity',
    'qty',
    'pieces',
    'pack size',
  ].some((token) => normalized.includes(token));
}

export function extractPackQuantityFromParameter(
  parameterName: unknown,
  rawValues: unknown,
): number | null {
  const name = String(parameterName || '').trim();
  const values = valueToStrings(rawValues);

  if (!name && values.length === 0) {
    return null;
  }

  if (isQuantityHintParameter(name)) {
    const directNumeric = values
      .map((entry) => parsePositiveInteger(entry, 2, 5000))
      .find((entry): entry is number => Boolean(entry));
    if (directNumeric) {
      return directNumeric;
    }
  }

  const combined = `${name} ${values.join(' ')}`.trim();
  return extractPackQuantityFromText(combined);
}

export function extractPackQuantityFromParameters(parameters: unknown): number | null {
  if (!Array.isArray(parameters)) return null;

  let best: number | null = null;
  for (const parameter of parameters) {
    const name = (parameter as any)?.name;
    const values = (parameter as any)?.values;
    const extracted = extractPackQuantityFromParameter(name, values);
    if (!extracted) continue;

    if (!best || extracted > best) {
      best = extracted;
    }
  }

  return best;
}

export function extractAvailableUnitsFromObject(
  source: unknown,
  maxDepth = 2,
): number | null {
  if (!source || typeof source !== 'object' || maxDepth < 0) return null;

  const record = source as Record<string, unknown>;
  const preferredKeys = [
    'available',
    'availableQuantity',
    'stock',
    'stockQuantity',
    'quantity',
    'qty',
    'inventory',
  ];

  for (const key of preferredKeys) {
    const value = record[key];
    const direct = parsePositiveInteger(value, 1, 1_000_000);
    if (direct) {
      return direct;
    }

    if (value && typeof value === 'object') {
      const nested = extractAvailableUnitsFromObject(value, maxDepth - 1);
      if (nested) {
        return nested;
      }
    }
  }

  if (maxDepth <= 0) return null;

  for (const [key, value] of Object.entries(record)) {
    if (!value || typeof value !== 'object') continue;

    const normalizedKey = normalizeQuantityText(key);
    if (
      /price|cost|shipping|delivery|rating|id|slug|image|url|currency/.test(
        normalizedKey,
      )
    ) {
      continue;
    }

    if (
      /qty|quant|stock|available|inventory|ilosc|ilos|szt/.test(
        normalizedKey,
      )
    ) {
      const nested = extractAvailableUnitsFromObject(value, maxDepth - 1);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}
