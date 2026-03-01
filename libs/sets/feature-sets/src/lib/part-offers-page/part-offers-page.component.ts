import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Subscription } from 'rxjs';
import {
  BatchOfferPartRequest,
  BatchOfferResult,
  BatchOffersDiagnostics,
  CartOfferSummary,
  CartOptimizationSummary,
  OfferSourceDescriptor,
  PartService,
} from '@lego-tracker/sets/data-access';
import {
  PartsCartItem,
  PartsCartStateService,
} from '../shared/parts-cart-state.service';
import { CartMixRankingDialogComponent } from '../part-offers-dialog/cart-mix-ranking-dialog.component';
import {
  asCssColor,
  BrandLogoComponent,
  ProviderAvatarComponent,
  resolveOfferColorPreview,
} from '@lego-tracker/shared/ui';

interface OfferResult extends BatchOfferResult {}
interface LoadingSourceItem {
  id: string;
  label: string;
}
type LoadingStage = 'idle' | 'stage1' | 'stage2';
type ReloadReason = 'manual' | 'provider';

interface SellerTrustMeta {
  icon: string;
  label: string;
  tooltip: string;
  tone: 'excellent' | 'good' | 'neutral' | 'warning';
}

@Component({
  selector: 'lib-part-offers-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    MatButtonModule,
    MatDividerModule,
    MatIconModule,
    MatTooltipModule,
    BrandLogoComponent,
    ProviderAvatarComponent,
  ],
  templateUrl: './part-offers-page.component.html',
  styleUrl: './part-offers-page.component.scss',
})
export class PartOffersPageComponent implements OnInit, OnDestroy {
  private readonly partService = inject(PartService);
  private readonly cartState = inject(PartsCartStateService);
  private readonly dialogService = inject(MatDialog);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly duplicateRequestWindowMs = 900;

  private requestSequence = 0;
  private lastBatchRequestSignature = '';
  private lastBatchRequestAtMs = 0;
  private offerSourcesSub: Subscription | null = null;
  private batchOffersSub: Subscription | null = null;
  private ebayStageSub: Subscription | null = null;
  private stagedMergeSub: Subscription | null = null;
  private providerQuerySub: Subscription | null = null;
  private reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly cartItems = this.cartState.cart;
  protected readonly hasPendingCartChanges = signal<boolean>(false);
  protected readonly isOffersLoading = signal(true);
  protected readonly isBackgroundRefreshing = signal(false);
  protected readonly isOptimizationLoading = signal(true);
  protected readonly loadingStage = signal<LoadingStage>('idle');
  protected readonly loadingTitle = signal('Pobieramy oferty...');
  protected readonly loadingDescription = signal(
    'Łączymy się ze źródłami i budujemy najtańszy wariant koszyka.',
  );
  protected readonly loadingAllProviders = signal<string[]>([]);
  protected readonly loadingProviders = signal<string[]>([]);
  protected readonly loadingCompletedProviders = signal<string[]>([]);
  protected readonly results = signal<OfferResult[]>([]);
  protected readonly optimization = signal<CartOptimizationSummary | null>(null);
  protected readonly diagnostics = signal<BatchOffersDiagnostics | null>(null);
  protected readonly isDiagnosticsExpanded = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly availableSources = signal<OfferSourceDescriptor[]>([]);
  protected readonly selectedProviders = signal<string[]>([]);
  protected readonly minSellerRatingPercent = signal<number>(0);
  protected readonly sellerRatingThresholdOptions = [0, 80, 90, 95];
  protected readonly selectedSingleSellerKey = signal<string | null>(null);
  protected readonly providerTechnicalIssues = signal<Record<string, boolean>>({});
  protected readonly skeletonOfferSlots = [0, 1, 2, 3];
  protected readonly asCssColor = asCssColor;
  protected readonly resolveOfferColorPreview = resolveOfferColorPreview;

  ngOnInit(): void {
    this.hasPendingCartChanges.set(false);
    this.ensureViewportTopOnEntry();

    this.offerSourcesSub?.unsubscribe();
    this.offerSourcesSub = this.partService.getOfferSources().subscribe({
      next: (res) => {
        this.availableSources.set(res.sources || []);
        this.bindProviderQuery();
      },
      error: () => {
        this.availableSources.set([]);
        this.bindProviderQuery();
      },
    });
  }

  private ensureViewportTopOnEntry(): void {
    if (typeof window === 'undefined') return;
    const scrollTop = () => window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    scrollTop();
    setTimeout(scrollTop, 0);
    setTimeout(scrollTop, 180);
  }

  ngOnDestroy(): void {
    this.offerSourcesSub?.unsubscribe();
    this.offerSourcesSub = null;
    this.cancelOffersRequests();
    this.providerQuerySub?.unsubscribe();
    this.providerQuerySub = null;
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
      this.reloadDebounceTimer = null;
    }
  }

  private bindProviderQuery(): void {
    this.providerQuerySub?.unsubscribe();
    this.providerQuerySub = this.route.queryParamMap.subscribe((params) => {
      const selectable = this.getSelectableProviderIds();
      const raw = String(params.get('providers') || '');
      const parsed = raw
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0);
      const normalized = Array.from(new Set(parsed)).filter((entry) =>
        selectable.includes(entry),
      );
      const selected =
        normalized.length === 0 || normalized.length === selectable.length
          ? []
          : normalized;
      this.selectedProviders.set(selected);
      this.minSellerRatingPercent.set(
        this.sanitizeMinSellerRatingPercent(
          Number.parseInt(String(params.get('sellerRatingMin') || '0'), 10),
        ),
      );
      this.scheduleReload(false, 'provider');
    });
  }

  private scheduleReload(
    preserveCurrentState: boolean,
    reason: ReloadReason,
  ): void {
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
      this.reloadDebounceTimer = null;
    }
    this.reloadDebounceTimer = setTimeout(() => {
      this.reloadDebounceTimer = null;
      this.reloadOffers(preserveCurrentState, reason);
    }, 180);
  }

  private cancelOffersRequests(): void {
    this.batchOffersSub?.unsubscribe();
    this.batchOffersSub = null;
    this.ebayStageSub?.unsubscribe();
    this.ebayStageSub = null;
    this.stagedMergeSub?.unsubscribe();
    this.stagedMergeSub = null;
  }

  private syncProvidersToUrl(): void {
    const selectable = this.getSelectableProviderIds();
    const selected = this.selectedProviders().filter((providerId) =>
      selectable.includes(providerId),
    );
    const shouldUseAll = selected.length === 0 || selected.length === selectable.length;
    const providersParam = shouldUseAll ? null : selected.join(',');
    const minSellerRatingPercentParam =
      this.minSellerRatingPercent() > 0 ? this.minSellerRatingPercent() : null;

    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        providers: providersParam,
        sellerRatingMin: minSellerRatingPercentParam,
      },
      queryParamsHandling: 'merge',
    });
  }

  private sanitizeMinSellerRatingPercent(rawValue: unknown): number {
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric)) return 0;
    const intValue = Math.floor(numeric);
    if (intValue <= 0) return 0;
    return Math.max(0, Math.min(100, intValue));
  }

  private buildFallbackResults(items: PartsCartItem[]): OfferResult[] {
    return items.map((item) => ({
      key: item.cartKey,
      id: item.id,
      designId: item.designId || null,
      partName: item.partName || item.designId || String(item.id),
      selectedColorId: item.selectedColorId ?? null,
      selectedColorName: item.selectedColorName ?? null,
      selectedColorRgb: item.selectedColorRgb ?? null,
      quantity: this.sanitizeQuantity(item.quantity),
      offers: [],
    }));
  }

  private syncResultsWithCart(): void {
    const byKey = new Map(
      this.cartItems().map((entry) => [String(entry.cartKey), entry] as const),
    );
    const next = this.results()
      .filter((result) => byKey.has(String(result.key)))
      .map((result) => {
        const item = byKey.get(String(result.key));
        if (!item) return result;
        return {
          ...result,
          partName: item.partName || result.partName,
          quantity: this.sanitizeQuantity(item.quantity),
          selectedColorId: item.selectedColorId ?? null,
          selectedColorName: item.selectedColorName ?? null,
          selectedColorRgb: item.selectedColorRgb ?? null,
        };
      });
    this.results.set(next);
  }

  private buildBatchRequest(items: PartsCartItem[]): BatchOfferPartRequest[] {
    return items.map((item) => {
      const safePartIds =
        Array.isArray(item.partIds) && item.partIds.length > 0
          ? item.partIds
          : [String(item.designId || '').trim()].filter((entry) => entry.length > 0);

      return {
        key: item.cartKey,
        id: item.id,
        designId: item.designId,
        partName: item.partName,
        partIds: safePartIds,
        selectedColorId: item.selectedColorId ?? null,
        selectedColorName: item.selectedColorName ?? null,
        selectedColorRgb: item.selectedColorRgb ?? null,
        quantity: this.sanitizeQuantity(item.quantity),
      };
    });
  }

  protected reloadOffers(
    preserveCurrentState = true,
    reason: ReloadReason = 'manual',
  ): void {
    const items = this.cartItems();
    if (items.length === 0) {
      this.requestSequence += 1;
      this.cancelOffersRequests();
      this.results.set([]);
      this.optimization.set(null);
      this.diagnostics.set(null);
      this.isOffersLoading.set(false);
      this.isBackgroundRefreshing.set(false);
      this.isOptimizationLoading.set(false);
      this.resetLoadingState();
      this.hasPendingCartChanges.set(false);
      this.loadError.set(null);
      return;
    }

    const batchRequest = this.buildBatchRequest(items);
    const providerIds = this.getEffectiveSelectedProviderIds();
    const minSellerRatingPercent = this.minSellerRatingPercent();
    const requestSignature = this.buildBatchRequestSignature(
      batchRequest,
      providerIds,
      minSellerRatingPercent,
    );
    const now = Date.now();
    if (
      requestSignature === this.lastBatchRequestSignature &&
      now - this.lastBatchRequestAtMs < this.duplicateRequestWindowMs
    ) {
      return;
    }
    this.lastBatchRequestSignature = requestSignature;
    this.lastBatchRequestAtMs = now;

    const currentRequest = ++this.requestSequence;
    const hadVisibleResults = preserveCurrentState && this.results().length > 0;

    this.isOffersLoading.set(!hadVisibleResults);
    this.isBackgroundRefreshing.set(hadVisibleResults);
    this.isOptimizationLoading.set(true);
    this.loadError.set(null);
    const allLoadProviders = this.normalizeProviderIds(providerIds);
    this.loadingAllProviders.set(allLoadProviders);
    this.loadingCompletedProviders.set([]);
    this.loadingProviders.set(allLoadProviders);
    this.updateLoadingState({
      stage: 'stage1',
      description:
        'Budujemy pierwszy ranking i przygotowujemy oferty do porównania.',
    });

    const applyResponse = (
      res: {
        results?: OfferResult[];
        optimization?: CartOptimizationSummary | null;
        diagnostics?: BatchOffersDiagnostics | null;
      },
      options?: { mergeDiagnostics?: boolean },
    ): void => {
      this.results.set(res.results || []);
      this.optimization.set(res.optimization || null);
      if (options?.mergeDiagnostics) {
        const merged = this.mergeBatchDiagnostics(
          this.diagnostics(),
          res.diagnostics || null,
        );
        this.diagnostics.set(merged);
        this.refreshProviderTechnicalIssuesFromDiagnostics(merged);
      } else {
        const nextDiagnostics = res.diagnostics || null;
        this.diagnostics.set(nextDiagnostics);
        this.refreshProviderTechnicalIssuesFromDiagnostics(nextDiagnostics);
      }
    };

    const finalizeSuccess = (): void => {
      this.loadingCompletedProviders.set(allLoadProviders);
      this.isOffersLoading.set(false);
      this.isBackgroundRefreshing.set(false);
      this.isOptimizationLoading.set(false);
      this.resetLoadingState();
      this.hasPendingCartChanges.set(false);
      this.loadError.set(null);
      this.cancelOffersRequests();
    };

    const finalizeWarning = (message: string): void => {
      this.isOffersLoading.set(false);
      this.isBackgroundRefreshing.set(false);
      this.isOptimizationLoading.set(false);
      this.loadingCompletedProviders.set(allLoadProviders);
      this.resetLoadingState();
      this.hasPendingCartChanges.set(false);
      this.loadError.set(message);
      this.cancelOffersRequests();
    };

    const finalizeError = (
      message: string,
      keepCurrentState: boolean,
      error?: any,
    ): void => {
      if (!keepCurrentState) {
        this.results.set([]);
        this.optimization.set(null);
        this.diagnostics.set(null);
      }
      if (error) {
        this.markProviderTechnicalIssuesFromError(error, allLoadProviders);
      }
      this.isOffersLoading.set(false);
      this.isBackgroundRefreshing.set(false);
      this.isOptimizationLoading.set(false);
      this.resetLoadingState();
      this.loadError.set(message);
      this.cancelOffersRequests();
    };
    const hasVisibleResults = this.results().length > 0;
    const refreshMissingOnly = reason === 'manual' && hasVisibleResults;
    const refreshMissingPartKeys = refreshMissingOnly
      ? this.results()
          .filter((result) => !Array.isArray(result.offers) || result.offers.length === 0)
          .map((result) => String(result.key || '').trim())
          .filter((entry) => entry.length > 0)
      : [];
    const forceRefresh = reason === 'manual';

    this.cancelOffersRequests();
    if (this.shouldUseStagedEbayLoading(providerIds)) {
      this.loadOffersWithStagedEbay({
        currentRequest,
        batchRequest,
        allProviders: providerIds,
        refreshMissingOnly,
        refreshMissingPartKeys,
        forceRefresh,
        minSellerRatingPercent,
        applyResponse,
        finalizeSuccess,
        finalizeWarning,
        finalizeError: (message, error) =>
          finalizeError(message, preserveCurrentState, error),
      });
      return;
    }

    this.batchOffersSub = this.partService
      .getBatchOffers(batchRequest, providerIds, {
        forceRefresh,
        refreshMissingOnly,
        refreshMissingPartKeys,
        minSellerRatingPercent,
      })
      .subscribe({
        next: (res) => {
          if (currentRequest !== this.requestSequence) return;
          applyResponse(res);
          finalizeSuccess();
        },
        error: (error) => {
          if (currentRequest !== this.requestSequence) return;
          finalizeError(
            'Nie udało się pobrać ofert. Sprawdź połączenie z API i spróbuj ponownie.',
            preserveCurrentState,
            error,
          );
        },
      });
  }

  private shouldUseStagedEbayLoading(providerIds: string[]): boolean {
    const normalized = this.normalizeProviderIds(providerIds);
    if (!normalized.includes('ebay')) return false;
    return normalized.some((providerId) => providerId !== 'ebay');
  }

  private loadOffersWithStagedEbay(params: {
    currentRequest: number;
    batchRequest: BatchOfferPartRequest[];
    allProviders: string[];
    refreshMissingOnly: boolean;
    refreshMissingPartKeys: string[];
    forceRefresh: boolean;
    minSellerRatingPercent: number;
    applyResponse: (
      res: {
        results?: OfferResult[];
        optimization?: CartOptimizationSummary | null;
        diagnostics?: BatchOffersDiagnostics | null;
      },
      options?: { mergeDiagnostics?: boolean },
    ) => void;
    finalizeSuccess: () => void;
    finalizeWarning: (message: string) => void;
    finalizeError: (message: string, error?: any) => void;
  }): void {
    const allProviders = this.normalizeProviderIds(params.allProviders);
    const phaseOneProviders = allProviders.filter((providerId) => providerId !== 'ebay');
    const phaseTwoProviders = ['ebay'];

    this.loadingAllProviders.set(allProviders);
    this.loadingCompletedProviders.set([]);
    this.loadingProviders.set(phaseOneProviders);
    this.updateLoadingState({
      stage: 'stage1',
      description:
        'Budujemy pierwszy ranking i przygotowujemy oferty do porównania.',
    });

    let phaseOneReady = false;
    let ebayStatus: 'pending' | 'success' | 'error' = 'pending';

    const startFinalMerge = () => {
      if (params.currentRequest !== this.requestSequence) return;
      this.loadingProviders.set(phaseTwoProviders);
      this.updateLoadingState({
        stage: 'stage2',
        description:
          'Finalizujemy ranking i odświeżamy ceny bez przeładowania strony.',
      });
      this.isOffersLoading.set(false);
      this.isBackgroundRefreshing.set(true);
      this.isOptimizationLoading.set(true);

      this.stagedMergeSub?.unsubscribe();
      this.stagedMergeSub = this.partService
        .getBatchOffers(params.batchRequest, allProviders, {
          forceRefresh: false,
          refreshMissingOnly: false,
          refreshMissingPartKeys: [],
          minSellerRatingPercent: params.minSellerRatingPercent,
        })
        .subscribe({
          next: (res) => {
            if (params.currentRequest !== this.requestSequence) return;
            params.applyResponse(res, { mergeDiagnostics: true });
            params.finalizeSuccess();
          },
          error: (error) => {
            if (params.currentRequest !== this.requestSequence) return;
            this.markProviderTechnicalIssuesFromError(error, allProviders);
            params.finalizeWarning(
              'Nie udało się odświeżyć finalnego rankingu po eBay. Pokazujemy wynik etapu 1.',
            );
          },
        });
    };

    this.batchOffersSub = this.partService
      .getBatchOffers(params.batchRequest, phaseOneProviders, {
        forceRefresh: params.forceRefresh,
        refreshMissingOnly: params.refreshMissingOnly,
        refreshMissingPartKeys: params.refreshMissingPartKeys,
        minSellerRatingPercent: params.minSellerRatingPercent,
      })
      .subscribe({
        next: (res) => {
          if (params.currentRequest !== this.requestSequence) return;
          phaseOneReady = true;
          params.applyResponse(res);
          this.loadingCompletedProviders.set(phaseOneProviders);
          this.isOffersLoading.set(false);
          this.isBackgroundRefreshing.set(true);
          this.isOptimizationLoading.set(false);
          this.hasPendingCartChanges.set(false);
          this.loadError.set(null);
          this.batchOffersSub = null;

          if (ebayStatus === 'success') {
            startFinalMerge();
            return;
          }

          if (ebayStatus === 'error') {
            params.finalizeWarning(
              'Nie udało się pobrać ofert z eBay. Pokazujemy wyniki z Allegro/Erli.',
            );
            return;
          }

          this.loadingProviders.set(phaseTwoProviders);
          this.updateLoadingState({
            stage: 'stage2',
            description:
              'Finalizujemy ranking i odświeżamy ceny bez przeładowania strony.',
          });
        },
        error: (error) => {
          if (params.currentRequest !== this.requestSequence) return;
          this.ebayStageSub?.unsubscribe();
          this.ebayStageSub = null;
          params.finalizeError(
            'Nie udało się pobrać ofert. Sprawdź połączenie z API i spróbuj ponownie.',
            error,
          );
        },
      });

    this.ebayStageSub = this.partService
      .getBatchOffers(params.batchRequest, phaseTwoProviders, {
        forceRefresh: params.forceRefresh,
        refreshMissingOnly: false,
        refreshMissingPartKeys: [],
        minSellerRatingPercent: params.minSellerRatingPercent,
      })
      .subscribe({
        next: () => {
          if (params.currentRequest !== this.requestSequence) return;
          ebayStatus = 'success';
          this.ebayStageSub = null;
          this.loadingCompletedProviders.update((current) =>
            Array.from(new Set([...current, ...phaseTwoProviders])),
          );
          if (phaseOneReady) {
            startFinalMerge();
          }
        },
        error: () => {
          if (params.currentRequest !== this.requestSequence) return;
          ebayStatus = 'error';
          this.ebayStageSub = null;
          this.providerTechnicalIssues.update((current) => ({
            ...current,
            ebay: true,
          }));
          if (phaseOneReady) {
            params.finalizeWarning(
              'Nie udało się pobrać ofert z eBay. Pokazujemy wyniki z Allegro/Erli.',
            );
          }
        },
      });
  }

  protected adjustCartQuantity(cartKey: string, delta: number): void {
    if (!delta) return;
    this.cartState.adjustQuantity(cartKey, delta);
    const hasItems = this.cartItems().length > 0;
    this.hasPendingCartChanges.set(hasItems);
    this.syncResultsWithCart();
    this.optimization.set(null);
    this.loadError.set(null);
  }

  protected setCartQuantityFromInput(
    cartKey: string,
    rawValue: string | number | null,
  ): void {
    const parsed =
      typeof rawValue === 'number'
        ? rawValue
        : Number.parseInt(String(rawValue || ''), 10);
    const quantity = this.sanitizeQuantity(Number.isFinite(parsed) ? parsed : 1);
    this.cartState.updateQuantity(cartKey, quantity);
    const hasItems = this.cartItems().length > 0;
    this.hasPendingCartChanges.set(hasItems);
    this.syncResultsWithCart();
    this.optimization.set(null);
    this.loadError.set(null);
  }

  protected removeCartPart(cartKey: string): void {
    this.cartState.remove(cartKey);
    const hasItems = this.cartItems().length > 0;
    this.hasPendingCartChanges.set(hasItems);
    this.syncResultsWithCart();
    this.optimization.set(null);
    this.loadError.set(null);

    if (!hasItems) {
      this.results.set([]);
      this.diagnostics.set(null);
      this.isOffersLoading.set(false);
      this.isBackgroundRefreshing.set(false);
      this.isOptimizationLoading.set(false);
      this.resetLoadingState();
    }
  }

  protected clearCart(): void {
    this.requestSequence += 1;
    this.cancelOffersRequests();
    this.cartState.clear();
    this.results.set([]);
    this.optimization.set(null);
    this.diagnostics.set(null);
    this.isOffersLoading.set(false);
    this.isBackgroundRefreshing.set(false);
    this.isOptimizationLoading.set(false);
    this.resetLoadingState();
    this.hasPendingCartChanges.set(false);
    this.loadError.set(null);
  }

  protected navigateToParts(): void {
    this.router.navigate(['/parts'], {
      queryParamsHandling: 'preserve',
    });
  }

  protected isSourceSelectable(source: OfferSourceDescriptor): boolean {
    return source.enabled && source.configured;
  }

  private getSelectableProviderIds(): string[] {
    return this.availableSources()
      .filter((source) => this.isSourceSelectable(source))
      .map((source) => source.id);
  }

  private getEffectiveSelectedProviderIds(): string[] {
    const selectable = this.getSelectableProviderIds();
    const selected = this.selectedProviders().filter((providerId) =>
      selectable.includes(providerId),
    );
    return selected.length > 0 ? selected : selectable;
  }

  private normalizeProviderIds(providerIds: string[]): string[] {
    return Array.from(
      new Set(
        providerIds
          .map((entry) => String(entry || '').trim().toLowerCase())
          .filter((entry) => entry.length > 0),
      ),
    );
  }

  private buildBatchRequestSignature(
    batchRequest: BatchOfferPartRequest[],
    providerIds: string[],
    minSellerRatingPercent: number,
  ): string {
    const providerSignature = this.normalizeProviderIds(providerIds).sort().join(',');
    const partsSignature = batchRequest
      .map((entry) =>
        [
          entry.key,
          this.sanitizeQuantity(entry.quantity),
          entry.selectedColorId ?? 'null',
          this.normalizeProviderIds(entry.partIds).slice(0, 8).join('|'),
        ].join(':'),
      )
      .sort()
      .join(';');
    return `${providerSignature}::${partsSignature}::sellerRatingMin:${minSellerRatingPercent}`;
  }

  private updateLoadingState(params: {
    stage: LoadingStage;
    description: string;
  }): void {
    this.loadingStage.set(params.stage);
    this.loadingTitle.set('Pobieramy oferty...');
    this.loadingDescription.set(params.description);
  }

  private resetLoadingState(): void {
    this.loadingStage.set('idle');
    this.loadingAllProviders.set([]);
    this.loadingProviders.set([]);
    this.loadingCompletedProviders.set([]);
    this.loadingTitle.set('Pobieramy oferty...');
    this.loadingDescription.set(
      'Łączymy się ze źródłami i budujemy najtańszy wariant koszyka.',
    );
  }

  protected showLoadingHero(): boolean {
    return this.isOffersLoading() || this.isBackgroundRefreshing();
  }

  protected isAnyOffersRequestInProgress(): boolean {
    return (
      this.isOffersLoading() || this.isBackgroundRefreshing() || this.isOptimizationLoading()
    );
  }

  protected loadingKickerLabel(): string {
    return 'Pobieramy oferty';
  }

  protected loadingStageLabel(): string {
    if (this.loadingStage() === 'stage1') return '1/2';
    if (this.loadingStage() === 'stage2') return '2/2';
    return 'Trwa ładowanie';
  }

  protected isProviderSelected(providerId: string): boolean {
    return this.getEffectiveSelectedProviderIds().includes(providerId);
  }

  protected toggleProvider(providerId: string): void {
    const source = this.availableSources().find((entry) => entry.id === providerId);
    if (!source || !this.isSourceSelectable(source)) return;

    const selectable = this.getSelectableProviderIds();
    const selected = new Set(this.getEffectiveSelectedProviderIds());
    if (selected.has(providerId)) {
      selected.delete(providerId);
    } else {
      selected.add(providerId);
    }

    const next = Array.from(selected.values()).filter((provider) =>
      selectable.includes(provider),
    );
    this.selectedProviders.set(
      next.length === 0 || next.length === selectable.length ? [] : next,
    );
    this.syncProvidersToUrl();
  }

  protected setMinSellerRatingPercent(value: number): void {
    const next = this.sanitizeMinSellerRatingPercent(value);
    if (next === this.minSellerRatingPercent()) return;
    this.minSellerRatingPercent.set(next);
    this.syncProvidersToUrl();
  }

  protected selectedProvidersLabel(): string {
    const ids = this.getEffectiveSelectedProviderIds();
    if (ids.length === 0) return 'Wszystkie aktywne';
    const labels = ids.map((id) => {
      const source = this.availableSources().find((entry) => entry.id === id);
      return source?.label || id;
    });
    return labels.join(', ');
  }

  protected sellerRatingThresholdLabel(): string {
    const minRating = this.minSellerRatingPercent();
    return minRating > 0 ? `Ocena sprzedawcy od ${minRating}%` : 'Ocena sprzedawcy: dowolna';
  }

  protected sellerRatingFilterHint(): string {
    const effectiveProviders = this.availableSources().filter(
      (source) =>
        this.isProviderSelected(source.id) &&
        source.supportsSellerRatingPercentFilter,
    );
    if (effectiveProviders.length === 0) {
      return 'Próg opinii nie jest obsługiwany dla wybranych źródeł.';
    }
    const labels = effectiveProviders.map((source) => source.label);
    return `Próg opinii działa dla: ${labels.join(', ')}.`;
  }

  protected loadingSourceChips(): LoadingSourceItem[] {
    const fallback: LoadingSourceItem[] = [
      { id: 'allegro', label: 'Allegro' },
      { id: 'ebay', label: 'eBay' },
      { id: 'erli', label: 'Erli' },
      { id: 'brickowl', label: 'BrickOwl' },
    ];

    const allLoadingProviderIds = this.loadingAllProviders();
    if (allLoadingProviderIds.length > 0) {
      const byId = new Map(
        this.availableSources().map((source) => [source.id, source.label] as const),
      );
      const stageSources = allLoadingProviderIds.map((id) => ({
        id,
        label: byId.get(id) || id,
      }));
      if (stageSources.length > 0) return stageSources;
    }

    const stageProviderIds = this.loadingProviders();
    if (stageProviderIds.length > 0) {
      const byId = new Map(
        this.availableSources().map((source) => [source.id, source.label] as const),
      );
      const stageSources = stageProviderIds.map((id) => ({
        id,
        label: byId.get(id) || id,
      }));
      if (stageSources.length > 0) return stageSources;
    }

    const sources = this.availableSources();
    if (sources.length === 0) return fallback;

    const selectedIds = this.getEffectiveSelectedProviderIds();
    if (selectedIds.length > 0) {
      const selected = selectedIds
        .map((id) => {
          const source = sources.find((entry) => entry.id === id);
          if (!source) return null;
          return {
            id: source.id,
            label: source.label,
          };
        })
        .filter((entry): entry is LoadingSourceItem => Boolean(entry));

      if (selected.length > 0) return selected;
    }

    const active = sources
      .filter((source) => this.isSourceSelectable(source))
      .map((source) => ({
        id: source.id,
        label: source.label,
      }));
    return active.length > 0 ? active : fallback;
  }

  protected getLoadingProviderState(providerId: string): 'done' | 'loading' | 'pending' {
    const normalizedProviderId = String(providerId || '').trim().toLowerCase();
    if (!normalizedProviderId) return 'pending';

    const completed = new Set(this.loadingCompletedProviders());
    if (completed.has(normalizedProviderId)) {
      return 'done';
    }

    const active = new Set(this.loadingProviders());
    if (active.has(normalizedProviderId)) {
      return 'loading';
    }

    const all = new Set(this.loadingAllProviders());
    if (all.has(normalizedProviderId)) {
      return 'pending';
    }

    return 'pending';
  }

  protected getLoadingProviderStateLabel(providerId: string): string {
    const state = this.getLoadingProviderState(providerId);
    if (state === 'done') return 'załadowano';
    return 'ładowanie';
  }

  protected getSourceStatusLabel(source: OfferSourceDescriptor): string {
    if (!source.enabled) return 'Wyłączone';
    if (!source.configured) return 'Brak konfiguracji API';
    if (this.isAnyOffersRequestInProgress() && this.isProviderSelected(source.id)) {
      const state = this.getLoadingProviderState(source.id);
      if (state === 'done') return 'Załadowano';
      if (state === 'loading') return 'Ładowanie...';
      return 'W kolejce';
    }
    if (this.hasSourceTechnicalIssues(source.id)) {
      return 'Problemy techniczne';
    }
    return this.isProviderSelected(source.id)
      ? 'Uwzględnione'
      : 'Kliknij, aby dodać';
  }

  protected hasSourceTechnicalIssues(sourceId: string): boolean {
    const providerId = String(sourceId || '').trim().toLowerCase();
    if (!providerId) return false;
    if (this.providerTechnicalIssues()[providerId]) {
      return true;
    }
    const diagnostics = this.diagnostics();
    if (!diagnostics || !Array.isArray(diagnostics.providerStats)) return false;
    const entry = diagnostics.providerStats.find(
      (item) => String(item?.providerId || '').trim().toLowerCase() === providerId,
    );
    if (!entry) return false;
    return this.isProviderDiagnosticsInErrorState(entry);
  }

  private refreshProviderTechnicalIssuesFromDiagnostics(
    diagnostics: BatchOffersDiagnostics | null,
  ): void {
    if (!diagnostics || !Array.isArray(diagnostics.providerStats)) return;

    const next = { ...this.providerTechnicalIssues() };
    diagnostics.providerStats.forEach((entry) => {
      const providerId = String(entry?.providerId || '').trim().toLowerCase();
      if (!providerId) return;
      const succeeded = Number(entry?.requestsSucceeded || 0);

      if (this.isProviderDiagnosticsInErrorState(entry)) {
        next[providerId] = true;
        return;
      }

      if (succeeded > 0) {
        next[providerId] = false;
      }
    });

    this.providerTechnicalIssues.set(next);
  }

  private isProviderDiagnosticsInErrorState(entry: any): boolean {
    const failed = Number(entry?.requestsFailed || 0);
    const succeeded = Number(entry?.requestsSucceeded || 0);
    const cooldownSkips = Number(entry?.cooldownSkips || 0);
    const cooldownRemainingMs = Number(entry?.cooldownRemainingMs || 0);
    const offersReturned = Number(entry?.offersReturned || 0);

    if (failed > 0 && succeeded === 0) {
      return true;
    }

    return (
      succeeded === 0 &&
      offersReturned === 0 &&
      (cooldownSkips > 0 || cooldownRemainingMs > 0)
    );
  }

  private markProviderTechnicalIssuesFromError(
    error: any,
    fallbackProviderIds: string[],
  ): void {
    const message = String(error?.error?.message || error?.message || '').toLowerCase();
    const knownProviders = ['allegro', 'ebay', 'erli', 'brickowl'];
    const next = { ...this.providerTechnicalIssues() };
    let markedAny = false;

    knownProviders.forEach((providerId) => {
      if (message.includes(providerId)) {
        next[providerId] = true;
        markedAny = true;
      }
    });

    if (!markedAny) {
      this.normalizeProviderIds(fallbackProviderIds).forEach((providerId) => {
        next[providerId] = true;
      });
    }

    this.providerTechnicalIssues.set(next);
  }

  protected getSourceHintLabel(source: OfferSourceDescriptor): string {
    return this.getSourceStatusLabel(source);
  }

  protected hasSingleSellerFullCoverage(): boolean {
    return Boolean(this.getSingleSellerDetails()?.missingPartKeys?.length === 0);
  }

  protected isSingleSellerCheaperOrEqualThanMixed(): boolean {
    const single = this.getSingleSellerDetails();
    const optimization = this.optimization();
    const mixed = optimization?.cheapestMixed;
    if (!single || !mixed) return false;
    if ((single.missingPartKeys || []).length > 0) return false;
    return single.estimatedGrandTotal <= mixed.estimatedGrandTotal;
  }

  protected getSingleSellerDetails() {
    const optimization = this.optimization();
    if (!optimization) return null;

    const alternatives = Array.isArray(optimization.topSingleSellerAlternatives)
      ? optimization.topSingleSellerAlternatives
      : [];
    const preferredKey = this.selectedSingleSellerKey();
    if (preferredKey) {
      const preferred = alternatives.find(
        (summary) => this.getSingleSellerSummaryKey(summary) === preferredKey,
      );
      if (preferred) return preferred;
      this.selectedSingleSellerKey.set(null);
    }

    return optimization.bestSingleSeller || optimization.bestPartialSingleSeller || null;
  }

  protected selectSingleSellerOption(summary: CartOfferSummary): void {
    const key = this.getSingleSellerSummaryKey(summary);
    if (!key) return;
    this.selectedSingleSellerKey.set(key);
  }

  protected isSingleSellerOptionActive(summary: CartOfferSummary): boolean {
    const current = this.getSingleSellerDetails();
    return this.getSingleSellerSummaryKey(current) === this.getSingleSellerSummaryKey(summary);
  }

  private getSingleSellerSummaryKey(
    summary: CartOfferSummary | null | undefined,
  ): string | null {
    if (!summary) return null;
    const sellerId = String(summary.sellerId || '').trim();
    if (sellerId) return `seller:${sellerId}`;
    const providerId = String(summary.selections?.[0]?.provider || '').trim().toLowerCase();
    const sellerLogin = String(summary.sellerLogin || '').trim().toLowerCase();
    if (providerId || sellerLogin) return `fallback:${providerId}:${sellerLogin}`;
    return null;
  }

  protected getSummaryPrimaryProviderId(
    summary: CartOfferSummary | null | undefined,
  ): string | null {
    if (!summary || !Array.isArray(summary.selections) || summary.selections.length === 0) {
      return null;
    }
    const raw = String(summary.selections[0]?.provider || '')
      .trim()
      .toLowerCase();
    if (!raw) return null;
    return raw;
  }

  protected getSummaryPrimaryProviderLabel(
    summary: CartOfferSummary | null | undefined,
  ): string {
    const providerId = this.getSummaryPrimaryProviderId(summary);
    if (!providerId) return 'Nieznana platforma';
    const source = this.availableSources().find((entry) => entry.id === providerId);
    return source?.label || providerId;
  }

  private parseSellerFeedbackPercent(offer: any): number | null {
    const parsed = Number.parseFloat(
      String(offer?.sellerFeedbackPercent ?? 'NaN').replace(',', '.'),
    );
    if (!Number.isFinite(parsed)) return null;
    return Math.max(0, Math.min(100, parsed));
  }

  protected getOfferSellerTrust(offer: any): SellerTrustMeta | null {
    if (!offer) return null;

    const provider = String(offer?.provider || '').toLowerCase();
    const isAllegroSuperSeller = provider === 'allegro' && Boolean(offer?.sellerIsSuperSeller);
    if (isAllegroSuperSeller) {
      return {
        icon: 'verified',
        label: 'SS',
        tooltip: 'Allegro Super Seller',
        tone: 'excellent',
      };
    }

    if (Boolean(offer?.sellerIsTopRated)) {
      return {
        icon: 'workspace_premium',
        label: 'TR',
        tooltip: 'Top Rated seller',
        tone: 'excellent',
      };
    }

    const feedbackPercent = this.parseSellerFeedbackPercent(offer);
    if (feedbackPercent === null) return null;

    if (feedbackPercent >= 98) {
      return {
        icon: 'verified_user',
        label: `${Math.round(feedbackPercent)}%`,
        tooltip: `Pozytywne opinie: ${feedbackPercent.toFixed(1)}%`,
        tone: 'excellent',
      };
    }
    if (feedbackPercent >= 90) {
      return {
        icon: 'thumb_up',
        label: `${Math.round(feedbackPercent)}%`,
        tooltip: `Pozytywne opinie: ${feedbackPercent.toFixed(1)}%`,
        tone: 'good',
      };
    }
    if (feedbackPercent >= 80) {
      return {
        icon: 'check_circle',
        label: `${Math.round(feedbackPercent)}%`,
        tooltip: `Pozytywne opinie: ${feedbackPercent.toFixed(1)}%`,
        tone: 'neutral',
      };
    }

    return {
      icon: 'warning_amber',
      label: `${Math.round(feedbackPercent)}%`,
      tooltip: `Pozytywne opinie: ${feedbackPercent.toFixed(1)}%`,
      tone: 'warning',
    };
  }

  protected getSummarySellerTrust(
    summary: CartOfferSummary | null | undefined,
  ): SellerTrustMeta | null {
    if (!summary || !Array.isArray(summary.selections) || summary.selections.length === 0) {
      return null;
    }
    return this.getOfferSellerTrust(summary.selections[0]);
  }

  protected displayResults(): OfferResult[] {
    const items = this.cartItems();
    if (items.length === 0) return [];

    const partKeys = new Set(items.map((entry) => String(entry.cartKey)));
    const currentResults = this.results().filter((result) =>
      partKeys.has(String(result.key)),
    );

    if (currentResults.length > 0) {
      return currentResults;
    }

    return this.buildFallbackResults(items);
  }

  protected formatMoney(value?: number | null, currency = 'PLN'): string {
    const safeValue = Number.isFinite(Number(value)) ? Number(value) : 0;
    return `${safeValue.toFixed(2)} ${currency}`;
  }

  protected formatDiff(value?: number | null, currency = 'PLN'): string {
    const safeValue = Number.isFinite(Number(value)) ? Number(value) : 0;
    const sign = safeValue > 0 ? '+' : '';
    return `${sign}${safeValue.toFixed(2)} ${currency}`;
  }

  protected abs(value: number): number {
    return Math.abs(value);
  }

  protected formatMs(value?: number | null): string {
    const safeValue = Number(value);
    if (!Number.isFinite(safeValue) || safeValue < 0) return '0 ms';
    if (safeValue >= 1000) return `${(safeValue / 1000).toFixed(2)} s`;
    return `${Math.round(safeValue)} ms`;
  }

  protected getMixedSavingsValue(): number | null {
    const optimization = this.optimization();
    const selectedSingle = this.getSingleSellerDetails();
    if (!optimization?.cheapestMixed || !selectedSingle) {
      return null;
    }
    return (
      selectedSingle.estimatedGrandTotal - optimization.cheapestMixed.estimatedGrandTotal
    );
  }

  protected previewList(items: string[], max = 3): string {
    const safeItems = Array.isArray(items) ? items.filter((entry) => !!entry) : [];
    if (safeItems.length === 0) return 'brak';
    if (safeItems.length <= max) return safeItems.join(', ');
    return `${safeItems.slice(0, max).join(', ')} +${safeItems.length - max}`;
  }

  protected formatMissingPartsWithQuantity(
    summary: CartOfferSummary | null | undefined,
    max = 3,
  ): string {
    if (!summary) return 'brak';
    const names = Array.isArray(summary.missingPartNames) ? summary.missingPartNames : [];
    const keys = Array.isArray(summary.missingPartKeys) ? summary.missingPartKeys : [];
    if (names.length === 0) return 'brak';

    const quantityByCartKey = new Map<string, number>();
    this.cartItems().forEach((item) => {
      quantityByCartKey.set(
        String(item.cartKey || ''),
        this.sanitizeQuantity(item.quantity),
      );
    });

    const formatted = names.map((name, index) => {
      const key = String(keys[index] || '');
      const quantity = quantityByCartKey.get(key) || 1;
      return `${name} ×${quantity}`;
    });

    if (formatted.length <= max) return formatted.join(', ');
    return `${formatted.slice(0, max).join(', ')} +${formatted.length - max}`;
  }

  protected canOpenMixedRanking(): boolean {
    return this.getMixedRankingOptions(this.optimization()).length > 0;
  }

  protected openMixedRanking(): void {
    const optimization = this.optimization();
    if (!optimization) return;

    const options = this.getMixedRankingOptions(optimization);
    if (options.length === 0) return;

    this.dialogService.open(CartMixRankingDialogComponent, {
      width: '980px',
      maxWidth: '96vw',
      data: {
        options,
        partsCount: optimization.partsCount,
      },
    });
  }

  protected topSingleSellerAlternatives(): CartOfferSummary[] {
    const alternatives = this.optimization()?.topSingleSellerAlternatives;
    return Array.isArray(alternatives) ? alternatives : [];
  }

  protected visibleSingleSellerAlternatives(): CartOfferSummary[] {
    const alternatives = this.topSingleSellerAlternatives();
    if (alternatives.length <= 1) return [];
    const activeKey = this.getSingleSellerSummaryKey(this.getSingleSellerDetails());
    return alternatives
      .filter((entry) => this.getSingleSellerSummaryKey(entry) !== activeKey)
      .slice(0, 3);
  }

  protected singleSellerOptionTrack(index: number, summary: CartOfferSummary): string {
    return this.getSingleSellerSummaryKey(summary) || `single-option-${index}`;
  }

  private mergeBatchDiagnostics(
    existing: BatchOffersDiagnostics | null,
    incoming: BatchOffersDiagnostics | null,
  ): BatchOffersDiagnostics | null {
    if (!incoming) return existing;
    if (!existing) return incoming;

    const mergedProviderStatsById = new Map<string, any>();
    for (const entry of Array.isArray(existing.providerStats) ? existing.providerStats : []) {
      mergedProviderStatsById.set(String(entry.providerId || '').toLowerCase(), {
        ...entry,
      });
    }
    for (const entry of Array.isArray(incoming.providerStats) ? incoming.providerStats : []) {
      const key = String(entry.providerId || '').toLowerCase();
      const current = mergedProviderStatsById.get(key);
      if (!current) {
        mergedProviderStatsById.set(key, { ...entry });
        continue;
      }
      const baseSucceeded = Number(current.requestsSucceeded || 0);
      const nextSucceeded = Number(entry.requestsSucceeded || 0);
      const totalSucceeded = baseSucceeded + nextSucceeded;
      const currentAvg = Number(current.avgDurationMs || 0);
      const nextAvg = Number(entry.avgDurationMs || 0);
      const weightedAvg =
        totalSucceeded > 0
          ? (currentAvg * baseSucceeded + nextAvg * nextSucceeded) / totalSucceeded
          : Math.max(currentAvg, nextAvg, 0);

      mergedProviderStatsById.set(key, {
        ...current,
        ...entry,
        cacheHits: Number(current.cacheHits || 0) + Number(entry.cacheHits || 0),
        cacheMisses: Number(current.cacheMisses || 0) + Number(entry.cacheMisses || 0),
        inFlightHits: Number(current.inFlightHits || 0) + Number(entry.inFlightHits || 0),
        cooldownSkips: Number(current.cooldownSkips || 0) + Number(entry.cooldownSkips || 0),
        requestsStarted: Number(current.requestsStarted || 0) + Number(entry.requestsStarted || 0),
        requestsSucceeded: totalSucceeded,
        requestsFailed: Number(current.requestsFailed || 0) + Number(entry.requestsFailed || 0),
        offersReturned: Number(current.offersReturned || 0) + Number(entry.offersReturned || 0),
        avgDurationMs: Number.isFinite(weightedAvg)
          ? Number(weightedAvg.toFixed(2))
          : null,
        minDurationMs: this.pickMinNullableDuration(
          current.minDurationMs,
          entry.minDurationMs,
        ),
        maxDurationMs: this.pickMaxNullableDuration(
          current.maxDurationMs,
          entry.maxDurationMs,
        ),
        maxConcurrency: Math.max(
          Number(current.maxConcurrency || 0),
          Number(entry.maxConcurrency || 0),
        ),
        minIntervalMs: Math.max(
          Number(current.minIntervalMs || 0),
          Number(entry.minIntervalMs || 0),
        ),
        cooldownMs: Math.max(Number(current.cooldownMs || 0), Number(entry.cooldownMs || 0)),
        cooldownRemainingMs: Math.max(
          Number(current.cooldownRemainingMs || 0),
          Number(entry.cooldownRemainingMs || 0),
        ),
      });
    }

    const providersRequested = Array.from(
      new Set([
        ...(Array.isArray(existing.providersRequested) ? existing.providersRequested : []),
        ...(Array.isArray(incoming.providersRequested) ? incoming.providersRequested : []),
      ]),
    );
    const providersResolved = Array.from(
      new Set([
        ...(Array.isArray(existing.providersResolved) ? existing.providersResolved : []),
        ...(Array.isArray(incoming.providersResolved) ? incoming.providersResolved : []),
      ]),
    );

    return {
      ...incoming,
      requestStartedAt: existing.requestStartedAt,
      requestFinishedAt: incoming.requestFinishedAt,
      totalDurationMs:
        Number(existing.totalDurationMs || 0) + Number(incoming.totalDurationMs || 0),
      fetchOffersMs:
        Number(existing.fetchOffersMs || 0) + Number(incoming.fetchOffersMs || 0),
      optimizationMs:
        Number(existing.optimizationMs || 0) + Number(incoming.optimizationMs || 0),
      providersRequested,
      providersResolved,
      providerStats: Array.from(mergedProviderStatsById.values()),
    };
  }

  private pickMinNullableDuration(
    a: number | null | undefined,
    b: number | null | undefined,
  ): number | null {
    const normalized = [a, b]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0);
    if (normalized.length === 0) return null;
    return Math.min(...normalized);
  }

  private pickMaxNullableDuration(
    a: number | null | undefined,
    b: number | null | undefined,
  ): number | null {
    const normalized = [a, b]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0);
    if (normalized.length === 0) return null;
    return Math.max(...normalized);
  }

  protected toggleDiagnosticsExpanded(): void {
    this.isDiagnosticsExpanded.update((current) => !current);
  }

  protected sanitizeQuantity(value?: number | null): number {
    const parsed = Number.parseInt(String(value ?? '1'), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 1;
    return Math.min(parsed, 999);
  }

  private getMixedRankingOptions(
    optimization: CartOptimizationSummary | null,
  ): CartOfferSummary[] {
    if (!optimization) return [];
    const mixedRanking = Array.isArray(optimization.mixedRanking)
      ? optimization.mixedRanking
      : [];
    if (mixedRanking.length > 0) return mixedRanking;
    return optimization.cheapestMixed ? [optimization.cheapestMixed] : [];
  }
}
