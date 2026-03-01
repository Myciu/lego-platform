import { PartColorPickerDialogComponent } from '../part-color-picker-dialog/part-color-picker-dialog.component';
import {
  Component,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, ParamMap, Router } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatDialog } from '@angular/material/dialog';
import { Subscription, catchError, forkJoin, of } from 'rxjs';
import {
  OfferSourceDescriptor,
  Part,
  PartCategory,
  PartColorOption,
  PartFilterColor,
  PartService,
} from '@lego-tracker/sets/data-access';
import {
  PartsCartItem,
  PartsCartStateService,
} from '../shared/parts-cart-state.service';
import {
  asCssColor,
  BrandLogoComponent,
  ProviderAvatarComponent,
} from '@lego-tracker/shared/ui';

interface PlatformPartIds {
  platform: string;
  ids: string[];
}

interface PartIdPreview {
  legoIds: string[];
  hiddenPlatforms: PlatformPartIds[];
}

@Component({
  selector: 'lib-parts',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatPaginatorModule,
    MatTooltipModule,
    MatExpansionModule,
    BrandLogoComponent,
    ProviderAvatarComponent,
  ],
  templateUrl: './parts.component.html',
  styleUrl: './parts.component.scss',
})
export class PartsComponent implements OnInit, OnDestroy {
  private readonly partService = inject(PartService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly dialog = inject(MatDialog);
  private readonly cartState = inject(PartsCartStateService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly allowedPageSizes = [10, 20, 40];
  private readonly defaultPageSize = 20;
  private readonly unknownColorOption: PartColorOption = {
    color_id: -1,
    color_name: 'Nieokreślony',
    color_rgb: 'A8ADB7',
  };
  private readonly platformOrder = [
    'LEGO Design',
    'LEGO',
    'BrickLink',
    'BrickOwl',
    'LDraw',
    'Brickset',
    'Peeron',
  ];
  private readonly platformAliases: Record<string, string> = {
    lego: 'LEGO',
    legodesign: 'LEGO Design',
    bricklink: 'BrickLink',
    brickowl: 'BrickOwl',
    ldraw: 'LDraw',
    brickset: 'Brickset',
    peeron: 'Peeron',
    rebrickable: 'Rebrickable',
  };
  private readonly primaryLegoPlatforms = new Set(['lego', 'legodesign']);

  protected readonly parts = signal<Part[]>([]);
  protected readonly categories = signal<PartCategory[]>([]);
  protected readonly colors = signal<PartFilterColor[]>([]);
  protected readonly providerSources = signal<OfferSourceDescriptor[]>([]);
  protected readonly selectedCategoryIds = signal<number[]>([]);
  protected readonly selectedColorIds = signal<number[]>([]);
  protected readonly selectedProviderIds = signal<string[]>([]);
  protected readonly selectedPartColorIds = signal<Record<number, number>>({});
  protected readonly totalParts = signal<number>(0);
  protected readonly isLoading = signal<boolean>(false);
  protected readonly skeletonCardSlots = [0, 1, 2, 3, 4, 5];
  protected readonly skeletonSwatchSlots = [0, 1, 2, 3, 4, 5];
  protected readonly cart = this.cartState.cart;
  protected readonly draftQuantities = signal<Record<string, number>>({});
  protected readonly draftQuantityInputs = signal<Record<string, string>>({});
  protected readonly mobileFiltersOpen = signal<boolean>(false);
  protected readonly asCssColor = asCssColor;

  protected searchQuery = '';
  protected readonly pageSize = signal<number>(this.defaultPageSize);
  protected readonly currentPage = signal<number>(0);
  private filtersLoaded = false;
  private routeStateSub: Subscription | null = null;
  private lastSearchStateKey = '';

  public ngOnInit(): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }
    this.loadFilters();
  }

  public ngOnDestroy(): void {
    this.routeStateSub?.unsubscribe();
    this.routeStateSub = null;
  }

  protected onSearch(): void {
    this.currentPage.set(0);
    this.syncStateToUrl();
  }

  private performSearch(): void {
    this.isLoading.set(true);
    this.partService
      .searchRemote(
        this.searchQuery.trim(),
        this.currentPage() + 1,
        this.pageSize(),
        this.selectedCategoryIds(),
        this.selectedColorIds()
      )
      .subscribe({
        next: (res) => {
          const pageParts = res.data || [];
          this.parts.set(pageParts);
          this.totalParts.set(res.total || 0);
          this.initializeSelectedColorsForPage(pageParts);
          this.isLoading.set(false);
        },
        error: () => {
          this.isLoading.set(false);
          this.parts.set([]);
          this.totalParts.set(0);
        },
      });
  }

  private loadFilters(): void {
    forkJoin({
      categories: this.partService.getCategories().pipe(catchError(() => of([] as PartCategory[]))),
      colors: this.partService.getColors().pipe(catchError(() => of([] as PartFilterColor[]))),
      providers: this.partService
        .getOfferSources()
        .pipe(catchError(() => of({ sources: [] as OfferSourceDescriptor[] }))),
    }).subscribe({
      next: ({ categories, colors, providers }) => {
        this.categories.set(categories || []);
        this.colors.set(colors || []);
        this.providerSources.set(providers?.sources || []);
        this.filtersLoaded = true;
        this.bindUrlState();
      },
    });
  }

  private bindUrlState(): void {
    this.routeStateSub?.unsubscribe();
    this.routeStateSub = this.route.queryParamMap.subscribe((params) => {
      if (!this.filtersLoaded) return;
      const searchStateChanged = this.applyStateFromUrl(params);
      if (searchStateChanged) {
        this.performSearch();
      }
    });
  }

  private parseNumberList(rawValue: string | null): number[] {
    const raw = String(rawValue || '').trim();
    if (!raw) return [];
    return Array.from(
      new Set(
        raw
          .split(',')
          .map((entry) => Number.parseInt(entry.trim(), 10))
          .filter((entry) => Number.isInteger(entry) && entry > 0),
      ),
    );
  }

  private parseStringList(rawValue: string | null): string[] {
    const raw = String(rawValue || '').trim();
    if (!raw) return [];
    return Array.from(
      new Set(
        raw
          .split(',')
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => entry.length > 0),
      ),
    );
  }

  private filterKnownIds(values: number[], knownIds: number[]): number[] {
    const known = new Set(knownIds);
    return values.filter((value) => known.has(value));
  }

  private buildSearchStateKey(): string {
    return JSON.stringify({
      q: this.searchQuery.trim(),
      page: this.currentPage(),
      size: this.pageSize(),
      cat: [...this.selectedCategoryIds()].sort((a, b) => a - b),
      colors: [...this.selectedColorIds()].sort((a, b) => a - b),
    });
  }

  private applyStateFromUrl(params: ParamMap): boolean {
    this.searchQuery = String(params.get('q') || '').trim();

    const pageRaw = Number.parseInt(String(params.get('page') || '1'), 10);
    const normalizedPage = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw - 1 : 0;
    this.currentPage.set(normalizedPage);

    const sizeRaw = Number.parseInt(
      String(params.get('size') || this.defaultPageSize),
      10,
    );
    const normalizedSize = this.allowedPageSizes.includes(sizeRaw)
      ? sizeRaw
      : this.defaultPageSize;
    this.pageSize.set(normalizedSize);

    const categoryIds = this.filterKnownIds(
      this.parseNumberList(params.get('cat')),
      this.categories().map((category) => category.id),
    );
    this.selectedCategoryIds.set(categoryIds);

    const colorIds = this.filterKnownIds(
      this.parseNumberList(params.get('colors')),
      this.colors().map((color) => color.id),
    );
    this.selectedColorIds.set(colorIds);

    const selectableProviders = this.getSelectableProviderSources().map(
      (source) => source.id,
    );
    const providerIds = this.parseStringList(params.get('providers')).filter((providerId) =>
      selectableProviders.includes(providerId),
    );
    const selectedProviders =
      providerIds.length === 0 || providerIds.length === selectableProviders.length
        ? []
        : providerIds;
    this.selectedProviderIds.set(selectedProviders);

    const nextSearchStateKey = this.buildSearchStateKey();
    const hasSearchStateChanged = this.lastSearchStateKey !== nextSearchStateKey;
    this.lastSearchStateKey = nextSearchStateKey;
    return hasSearchStateChanged;
  }

  private syncStateToUrl(): void {
    if (!this.filtersLoaded) return;

    const selectableProviders = this.getSelectableProviderSources().map(
      (source) => source.id,
    );
    const selectedProviders = this.selectedProviderIds().filter((providerId) =>
      selectableProviders.includes(providerId),
    );
    const shouldUseAllProviders =
      selectedProviders.length === 0 ||
      selectedProviders.length === selectableProviders.length;

    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        q: this.searchQuery.trim() || null,
        page: this.currentPage() > 0 ? this.currentPage() + 1 : null,
        size: this.pageSize() !== this.defaultPageSize ? this.pageSize() : null,
        cat: this.selectedCategoryIds().length
          ? this.selectedCategoryIds().join(',')
          : null,
        colors: this.selectedColorIds().length
          ? this.selectedColorIds().join(',')
          : null,
        providers: !shouldUseAllProviders
          ? selectedProviders.join(',')
          : null,
      },
      queryParamsHandling: 'merge',
    });
  }

  private formatFilterSummary(selectedCount: number): string {
    return selectedCount === 0 ? 'Wszystkie aktywne' : `${selectedCount} aktywne`;
  }

  private initializeSelectedColorsForPage(parts: Part[]): void {
    const current = { ...this.selectedPartColorIds() };
    const visibleIds = new Set(parts.map((part) => part.id));

    Object.keys(current).forEach((partId) => {
      const numericPartId = Number(partId);
      if (!visibleIds.has(numericPartId)) {
        delete current[numericPartId];
      }
    });

    for (const part of parts) {
      const configuredColorId = current[part.id];
      const stillValid =
        configuredColorId !== undefined &&
        part.colorInfo.colors.some((color) => color.color_id === configuredColorId);

      if (stillValid) continue;

      const firstColor = part.colorInfo.colors[0];
      if (firstColor) {
        current[part.id] = firstColor.color_id;
      }
    }

    this.selectedPartColorIds.set(current);
  }

  protected toggleCategory(categoryId: number): void {
    const selected = new Set(this.selectedCategoryIds());
    if (selected.has(categoryId)) {
      selected.delete(categoryId);
    } else {
      selected.add(categoryId);
    }
    this.selectedCategoryIds.set(Array.from(selected));
    this.currentPage.set(0);
    this.syncStateToUrl();
  }

  protected toggleColor(colorId: number): void {
    const selected = new Set(this.selectedColorIds());
    if (selected.has(colorId)) {
      selected.delete(colorId);
    } else {
      selected.add(colorId);
    }
    this.selectedColorIds.set(Array.from(selected));
    this.currentPage.set(0);
    this.syncStateToUrl();
  }

  protected clearAllFilters(): void {
    this.selectedCategoryIds.set([]);
    this.selectedColorIds.set([]);
    this.selectedProviderIds.set([]);
    this.currentPage.set(0);
    this.syncStateToUrl();
  }

  protected toggleMobileFilters(): void {
    this.mobileFiltersOpen.set(!this.mobileFiltersOpen());
  }

  protected closeMobileFilters(): void {
    this.mobileFiltersOpen.set(false);
  }

  protected getActiveFiltersCount(): number {
    const selectableProviderCount = this.getSelectableProviderSources().length;
    const selectedProviderCount = this.selectedProviderIds().length;
    const providerFiltersActive =
      selectableProviderCount > 0 &&
      selectedProviderCount > 0 &&
      selectedProviderCount < selectableProviderCount;

    return (
      this.selectedCategoryIds().length +
      this.selectedColorIds().length +
      (providerFiltersActive ? 1 : 0)
    );
  }

  protected isCategorySelected(categoryId: number): boolean {
    return this.selectedCategoryIds().includes(categoryId);
  }

  protected isColorSelected(colorId: number): boolean {
    return this.selectedColorIds().includes(colorId);
  }

  protected getCategoryFilterSummary(): string {
    return this.formatFilterSummary(this.selectedCategoryIds().length);
  }

  protected getColorFilterSummary(): string {
    return this.formatFilterSummary(this.selectedColorIds().length);
  }

  protected getSelectableProviderSources(): OfferSourceDescriptor[] {
    return this.providerSources().filter(
      (source) => source.enabled && source.configured,
    );
  }

  protected isProviderFilterSelected(providerId: string): boolean {
    const selected = this.selectedProviderIds();
    if (selected.length === 0) {
      return this.getSelectableProviderSources().some(
        (source) => source.id === providerId,
      );
    }
    return selected.includes(providerId);
  }

  protected getProviderFilterSummary(): string {
    return this.formatFilterSummary(this.selectedProviderIds().length);
  }

  protected toggleProviderFilter(providerId: string): void {
    const selectable = this.getSelectableProviderSources();
    if (!selectable.some((source) => source.id === providerId)) {
      return;
    }

    const selectableIds = selectable.map((source) => source.id);
    const selected = new Set(
      this.selectedProviderIds().length > 0
        ? this.selectedProviderIds()
        : selectableIds,
    );
    if (selected.has(providerId)) {
      selected.delete(providerId);
    } else {
      selected.add(providerId);
    }

    const next = Array.from(selected).filter((id) => selectableIds.includes(id));
    this.selectedProviderIds.set(
      next.length === 0 || next.length === selectableIds.length ? [] : next,
    );
    this.syncStateToUrl();
  }

  protected resetCategoryFilters(): void {
    this.selectedCategoryIds.set([]);
    this.currentPage.set(0);
    this.syncStateToUrl();
  }

  protected resetColorFilters(): void {
    this.selectedColorIds.set([]);
    this.currentPage.set(0);
    this.syncStateToUrl();
  }

  protected resetProviderFilters(): void {
    this.selectedProviderIds.set([]);
    this.syncStateToUrl();
  }

  protected openRemainingColors(part: Part): void {
    if (!part.colorInfo.colors.length || part.colorInfo.colors.length <= 12) {
      return;
    }

    const selectedColor = this.getSelectedPartColor(part);
    const dialogRef = this.dialog.open(PartColorPickerDialogComponent, {
      width: '520px',
      maxWidth: '95vw',
      data: {
        partName: part.name,
        colors: part.colorInfo.colors,
        selectedColorId: selectedColor.color_id,
      },
    });

    dialogRef.afterClosed().subscribe((selectedColorId?: number) => {
      if (typeof selectedColorId === 'number') {
        this.setSelectedPartColor(part, selectedColorId);
      }
    });
  }

  protected setSelectedPartColor(part: Part, colorId: number): void {
    if (!part.colorInfo.colors.length) {
      return;
    }
    this.selectedPartColorIds.set({
      ...this.selectedPartColorIds(),
      [part.id]: colorId,
    });
  }

  protected isSelectedPartColor(part: Part, colorId: number): boolean {
    return this.getSelectedPartColor(part)?.color_id === colorId;
  }

  protected getSelectedPartColor(part: Part): PartColorOption {
    const selectedColorId = this.selectedPartColorIds()[part.id];
    if (selectedColorId !== undefined) {
      const selectedColor = part.colorInfo.colors.find((color) => color.color_id === selectedColorId);
      if (selectedColor) {
        return selectedColor;
      }
    }
    return part.colorInfo.colors[0] || this.unknownColorOption;
  }

  protected hasSelectableColors(part: Part): boolean {
    return part.colorInfo.colors.length > 0;
  }

  protected getSelectedPartColorName(part: Part): string {
    const selectedColor = this.getSelectedPartColor(part);
    return selectedColor.color_name;
  }

  private normalizePartIdValue(value: unknown): string {
    const raw = String(value || '').trim();
    if (!raw) return '';

    const normalized = raw
      .replace(/\.dat$/i, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized || normalized.length > 32) {
      return '';
    }

    return normalized;
  }

  private normalizePlatformLabel(rawKey: string): string {
    const normalized = rawKey.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!normalized) return rawKey;
    return this.platformAliases[normalized] || rawKey;
  }

  private sortPlatforms(a: PlatformPartIds, b: PlatformPartIds): number {
    const indexA = this.platformOrder.indexOf(a.platform);
    const indexB = this.platformOrder.indexOf(b.platform);
    const safeA = indexA >= 0 ? indexA : this.platformOrder.length + 1;
    const safeB = indexB >= 0 ? indexB : this.platformOrder.length + 1;
    if (safeA !== safeB) return safeA - safeB;
    return a.platform.localeCompare(b.platform);
  }

  protected getPartPlatformIds(part: Part): PlatformPartIds[] {
    const groups: PlatformPartIds[] = [];
    const designId = this.normalizePartIdValue(part.designId);

    if (designId) {
      groups.push({
        platform: 'LEGO Design',
        ids: [designId],
      });
    }

    Object.entries(part.partIds || {}).forEach(([rawPlatform, rawIds]) => {
      if (!Array.isArray(rawIds) || rawIds.length === 0) return;

      const platform = this.normalizePlatformLabel(String(rawPlatform || '').trim());
      const ids = Array.from(
        new Set(
          rawIds
            .map((entry) => this.normalizePartIdValue(entry))
            .filter((entry) => entry.length > 0),
        ),
      );
      if (ids.length === 0) return;

      groups.push({
        platform,
        ids: ids.slice(0, 6),
      });
    });

    return groups.sort((a, b) => this.sortPlatforms(a, b));
  }

  protected getPartIdPreview(part: Part): PartIdPreview {
    const groups = this.getPartPlatformIds(part);
    const seenIds = new Set<string>();
    const legoIds: string[] = [];
    const hiddenPlatforms: PlatformPartIds[] = [];

    for (const group of groups) {
      const uniqueIds = group.ids.filter((rawId) => {
        const id = this.normalizePartIdValue(rawId);
        if (!id || seenIds.has(id)) return false;
        seenIds.add(id);
        return true;
      });

      if (uniqueIds.length === 0) continue;

      const normalizedPlatform = String(group.platform || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');

      if (this.primaryLegoPlatforms.has(normalizedPlatform)) {
        legoIds.push(...uniqueIds);
        continue;
      }

      hiddenPlatforms.push({
        platform: group.platform,
        ids: uniqueIds,
      });
    }

    return {
      legoIds: legoIds.slice(0, 8),
      hiddenPlatforms,
    };
  }

  private buildPartSearchIds(part: Part): string[] {
    const unique = new Set<string>();
    const add = (value: unknown) => {
      const normalized = this.normalizePartIdValue(value);
      if (!normalized) return;
      unique.add(normalized);
    };

    add(part.designId);

    Object.values(part.partIds || {}).forEach((rawIds) => {
      if (!Array.isArray(rawIds)) return;
      rawIds.forEach((value) => add(value));
    });

    return Array.from(unique).slice(0, 20);
  }

  private getCartKey(part: Part): string {
    const selectedColor = this.getSelectedPartColor(part);
    return `${part.id}-${selectedColor.color_id}`;
  }

  private clampQuantity(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.min(999, Math.trunc(value)));
  }

  protected getDraftQuantity(part: Part): number {
    const draftValue = this.draftQuantities()[this.getCartKey(part)];
    if (draftValue === undefined) {
      return 1;
    }
    return this.clampQuantity(draftValue);
  }

  protected getDraftQuantityInputValue(part: Part): string {
    const key = this.getCartKey(part);
    const raw = this.draftQuantityInputs()[key];
    if (raw !== undefined) return raw;
    return String(this.getDraftQuantity(part));
  }

  protected setDraftQuantityFromInput(part: Part, rawValue: string | number | null): void {
    const cartKey = this.getCartKey(part);
    const raw =
      typeof rawValue === 'number'
        ? String(rawValue)
        : String(rawValue ?? '').trim();
    const parsed = Number.parseInt(raw, 10);
    const nextQuantity = Number.isNaN(parsed) ? 0 : this.clampQuantity(parsed);

    this.draftQuantityInputs.set({
      ...this.draftQuantityInputs(),
      [cartKey]: raw,
    });
    this.draftQuantities.set({
      ...this.draftQuantities(),
      [cartKey]: nextQuantity,
    });
  }

  protected commitDraftQuantity(part: Part): void {
    const cartKey = this.getCartKey(part);
    const raw = String(this.draftQuantityInputs()[cartKey] ?? '').trim();
    const parsed =
      raw.length > 0 ? Number.parseInt(raw, 10) : Number.NaN;
    const nextQuantity = Number.isNaN(parsed) ? 0 : this.clampQuantity(parsed);

    this.draftQuantityInputs.set({
      ...this.draftQuantityInputs(),
      [cartKey]: String(nextQuantity),
    });
    this.draftQuantities.set({
      ...this.draftQuantities(),
      [cartKey]: nextQuantity,
    });
  }

  protected adjustDraftQuantity(part: Part, delta: number): void {
    const cartKey = this.getCartKey(part);
    const nextQuantity = this.clampQuantity(this.getDraftQuantity(part) + delta);

    this.draftQuantityInputs.set({
      ...this.draftQuantityInputs(),
      [cartKey]: String(nextQuantity),
    });
    this.draftQuantities.set({
      ...this.draftQuantities(),
      [cartKey]: nextQuantity,
    });
  }

  protected addDraftToCart(part: Part): void {
    const draftQuantity = this.getDraftQuantity(part);
    if (draftQuantity <= 0) {
      return;
    }

    this.addToCart(part, draftQuantity);

    const cartKey = this.getCartKey(part);
    this.draftQuantityInputs.set({
      ...this.draftQuantityInputs(),
      [cartKey]: '1',
    });
    this.draftQuantities.set({
      ...this.draftQuantities(),
      [cartKey]: 1,
    });
  }

  private buildCartItemFromPart(part: Part, quantity: number): PartsCartItem {
    const selectedColor = this.getSelectedPartColor(part);
    const hasColor = selectedColor.color_id >= 0;
    const partIds = this.buildPartSearchIds(part);
    const safePartIds =
      partIds.length > 0
        ? partIds
        : [String(part.designId || '').trim()].filter((entry) => entry.length > 0);

    return {
      cartKey: `${part.id}-${selectedColor.color_id}`,
      id: part.id,
      designId: part.designId,
      partName: part.name,
      imageUrl: part.imageUrl || null,
      partCategoryName: part.partCategoryName || null,
      partIds: safePartIds,
      selectedColorId: hasColor ? selectedColor.color_id : null,
      selectedColorName: hasColor ? selectedColor.color_name : null,
      selectedColorRgb: hasColor ? selectedColor.color_rgb : null,
      quantity: Math.max(1, this.clampQuantity(quantity)),
    };
  }

  protected addToCart(part: Part, quantity = 1): void {
    const quantityToAdd = Math.max(1, this.clampQuantity(quantity));
    const cartItem = this.buildCartItemFromPart(part, quantityToAdd);
    this.cartState.upsert(cartItem, quantityToAdd);
  }

  protected decrementCartItem(part: Part): void {
    const cartKey = this.getCartKey(part);
    this.cartState.adjustQuantity(cartKey, -1);
  }

  protected removeCartItem(part: Part): void {
    const cartKey = this.getCartKey(part);
    this.cartState.remove(cartKey);
  }

  protected getSelectedPartQuantity(part: Part): number {
    const cartKey = this.getCartKey(part);
    const item = this.cart().find((entry) => entry.cartKey === cartKey);
    return item?.quantity || 0;
  }

  protected getCartTotalQuantity(): number {
    return this.cart().reduce((sum, entry) => sum + (entry.quantity || 1), 0);
  }

  protected getCartLineCount(): number {
    return this.cart().length;
  }

  protected clearCart(): void {
    this.cartState.clear();
    this.draftQuantities.set({});
    this.draftQuantityInputs.set({});
  }

  protected openCartPage(): void {
    if (this.cart().length === 0) {
      return;
    }
    this.router.navigate(['/parts/cart'], {
      queryParamsHandling: 'preserve',
    });
  }

  protected handlePageEvent(event: PageEvent): void {
    this.currentPage.set(event.pageIndex);
    this.pageSize.set(event.pageSize);
    this.syncStateToUrl();
  }

}
