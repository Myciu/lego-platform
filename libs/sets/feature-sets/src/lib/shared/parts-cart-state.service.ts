import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

export interface PartsCartItem {
  cartKey: string;
  id: number;
  designId: string;
  partName: string;
  imageUrl: string | null;
  partCategoryName: string | null;
  partIds: string[];
  selectedColorId: number | null;
  selectedColorName: string | null;
  selectedColorRgb: string | null;
  quantity: number;
}

@Injectable({ providedIn: 'root' })
export class PartsCartStateService {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly storageKey = 'brickomat.parts.cart.v1';

  readonly cart = signal<PartsCartItem[]>([]);

  constructor() {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }
    this.hydrateFromStorage();
  }

  private clampQuantity(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.min(999, Math.trunc(value)));
  }

  private normalizePartIds(input: unknown): string[] {
    if (!Array.isArray(input)) return [];

    const normalized = input
      .map((entry) => String(entry || '').trim())
      .filter((entry) => entry.length > 0);

    return Array.from(new Set(normalized)).slice(0, 24);
  }

  private sanitizeItem(raw: unknown): PartsCartItem | null {
    if (!raw || typeof raw !== 'object') return null;
    const entry = raw as Partial<PartsCartItem>;

    const cartKey = String(entry.cartKey || '').trim();
    const designId = String(entry.designId || '').trim();
    const partName = String(entry.partName || '').trim();
    const id = Number.parseInt(String(entry.id ?? ''), 10);
    const quantity = this.clampQuantity(Number(entry.quantity ?? 0));

    if (!cartKey || !designId || !partName || !Number.isFinite(id) || id <= 0 || quantity <= 0) {
      return null;
    }

    const selectedColorIdRaw = entry.selectedColorId;
    const selectedColorId =
      selectedColorIdRaw === null || selectedColorIdRaw === undefined
        ? null
        : Number.isFinite(Number(selectedColorIdRaw))
          ? Number(selectedColorIdRaw)
          : null;

    const selectedColorNameRaw = String(entry.selectedColorName || '').trim();
    const selectedColorRgbRaw = String(entry.selectedColorRgb || '').trim();

    return {
      cartKey,
      id,
      designId,
      partName,
      imageUrl: entry.imageUrl ? String(entry.imageUrl) : null,
      partCategoryName: entry.partCategoryName
        ? String(entry.partCategoryName)
        : null,
      partIds: this.normalizePartIds(entry.partIds),
      selectedColorId,
      selectedColorName: selectedColorNameRaw || null,
      selectedColorRgb: selectedColorRgbRaw || null,
      quantity,
    };
  }

  private persistToStorage(): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.cart()));
    } catch {
      // Ignore storage write errors (private mode / quota).
    }
  }

  private hydrateFromStorage(): void {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) {
        this.cart.set([]);
        return;
      }

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        this.cart.set([]);
        return;
      }

      const sanitized = parsed
        .map((entry) => this.sanitizeItem(entry))
        .filter((entry): entry is PartsCartItem => Boolean(entry));
      this.cart.set(sanitized);
    } catch {
      this.cart.set([]);
    }
  }

  setCart(items: PartsCartItem[]): void {
    const sanitized = (Array.isArray(items) ? items : [])
      .map((entry) => this.sanitizeItem(entry))
      .filter((entry): entry is PartsCartItem => Boolean(entry));
    this.cart.set(sanitized);
    this.persistToStorage();
  }

  clear(): void {
    this.cart.set([]);
    this.persistToStorage();
  }

  upsert(item: PartsCartItem, quantityToAdd = 1): void {
    const sanitized = this.sanitizeItem(item);
    const safeIncrement = Math.max(1, this.clampQuantity(quantityToAdd));
    if (!sanitized || safeIncrement <= 0) {
      return;
    }

    const current = [...this.cart()];
    const existingIndex = current.findIndex(
      (entry) => entry.cartKey === sanitized.cartKey,
    );

    if (existingIndex >= 0) {
      current[existingIndex] = {
        ...current[existingIndex],
        quantity: Math.min(999, current[existingIndex].quantity + safeIncrement),
      };
      this.cart.set(current);
      this.persistToStorage();
      return;
    }

    this.cart.set([
      ...current,
      {
        ...sanitized,
        quantity: safeIncrement,
      },
    ]);
    this.persistToStorage();
  }

  updateQuantity(cartKey: string, nextQuantity: number): void {
    const safeKey = String(cartKey || '').trim();
    if (!safeKey) return;

    const normalizedQuantity = this.clampQuantity(nextQuantity);
    const current = [...this.cart()];
    const index = current.findIndex((entry) => entry.cartKey === safeKey);
    if (index < 0) return;

    if (normalizedQuantity <= 0) {
      current.splice(index, 1);
      this.cart.set(current);
      this.persistToStorage();
      return;
    }

    current[index] = {
      ...current[index],
      quantity: normalizedQuantity,
    };
    this.cart.set(current);
    this.persistToStorage();
  }

  adjustQuantity(cartKey: string, delta: number): void {
    const safeKey = String(cartKey || '').trim();
    if (!safeKey || !Number.isFinite(delta) || delta === 0) return;

    const item = this.cart().find((entry) => entry.cartKey === safeKey);
    if (!item) return;

    this.updateQuantity(safeKey, item.quantity + delta);
  }

  remove(cartKey: string): void {
    const safeKey = String(cartKey || '').trim();
    if (!safeKey) return;
    this.cart.set(this.cart().filter((entry) => entry.cartKey !== safeKey));
    this.persistToStorage();
  }
}
