import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialog, MatDialogModule, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { Subscription } from 'rxjs';
import {
  BatchOffersDiagnostics,
  BatchOfferPartRequest,
  BatchOfferResult,
  CartOfferSummary,
  CartOptimizationSummary,
  OfferSourceDescriptor,
  PartService,
} from '@lego-tracker/sets/data-access';
import {
  asCssColor,
  ProviderAvatarComponent,
  resolveOfferColorPreview,
} from '@lego-tracker/shared/ui';
import { CartMixRankingDialogComponent } from './cart-mix-ranking-dialog.component';

interface OfferResult extends BatchOfferResult {}

interface PartOffersDialogData {
  parts: BatchOfferPartRequest[];
  providers?: string[];
}

type ReloadReason = 'manual' | 'provider';

@Component({
  selector: 'lib-part-offers-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatDividerModule,
    ProviderAvatarComponent,
  ],
  template: `
    <h2 mat-dialog-title>Porównywarka ofert części LEGO</h2>
    
    <mat-dialog-content>
      <div class="results-container">
        <section class="cart-panel" [class.dirty]="hasPendingCartChanges()">
          <header class="cart-panel-header">
            <h3>Koszyk</h3>
            <button
              mat-button
              type="button"
              class="cart-panel-clear"
              [disabled]="cartParts().length === 0"
              (click)="clearDialogCart()"
            >
              Usuń wszystko
            </button>
          </header>

          @if (cartParts().length > 0) {
            <div class="cart-panel-list">
              @for (part of cartParts(); track part.key) {
                <article class="cart-line">
                  <div class="cart-line-main">
                    <strong>{{ part.partName || ('Klocek ' + part.designId) }}</strong>
                    @if (part.selectedColorName) {
                      <span class="cart-line-color">
                        <span
                          class="cart-line-color-dot"
                          [style.background-color]="asCssColor(part.selectedColorRgb)"
                        ></span>
                        {{ part.selectedColorName }}
                      </span>
                    }
                  </div>
                  <div class="cart-line-actions">
                    <button
                      type="button"
                      class="qty-btn"
                      (click)="adjustCartQuantity(part.key, -1)"
                      [disabled]="sanitizeQuantity(part.quantity) <= 1"
                      aria-label="Usuń jedną sztukę"
                    >
                      <mat-icon>remove</mat-icon>
                    </button>
                    <input
                      class="qty-input"
                      type="number"
                      min="1"
                      max="999"
                      [ngModel]="sanitizeQuantity(part.quantity)"
                      (ngModelChange)="setCartQuantityFromInput(part.key, $event)"
                      aria-label="Ilość sztuk w koszyku"
                    >
                    <button
                      type="button"
                      class="qty-btn"
                      (click)="adjustCartQuantity(part.key, 1)"
                      aria-label="Dodaj jedną sztukę"
                    >
                      <mat-icon>add</mat-icon>
                    </button>
                    <button
                      type="button"
                      class="remove-line-btn"
                      (click)="removeCartPart(part.key)"
                      aria-label="Usuń pozycję z koszyka"
                    >
                      <mat-icon>delete_outline</mat-icon>
                    </button>
                  </div>
                </article>
              }
            </div>

            @if (hasPendingCartChanges()) {
              <button mat-flat-button class="recompute-btn" (click)="reloadOffers(false, 'manual')">
                Oblicz ponownie najkorzystniejsze oferty
              </button>
            }
          } @else {
            <p class="cart-empty-note">Koszyk jest pusty.</p>
          }
        </section>

        @if (loadError()) {
          <div class="request-error">
            <mat-icon>error_outline</mat-icon>
            <span>{{ loadError() }}</span>
          </div>
        }

        @if (isOptimizationLoading()) {
          <section class="optimizer-summary optimizer-skeleton">
            <div class="skeleton line lg"></div>
            <div class="skeleton line md"></div>
            <div class="optimizer-grid">
              <article class="optimizer-card">
                <div class="skeleton line sm"></div>
                <div class="skeleton line lg"></div>
                <div class="skeleton line md"></div>
              </article>
              <article class="optimizer-card">
                <div class="skeleton line sm"></div>
                <div class="skeleton line lg"></div>
                <div class="skeleton line md"></div>
              </article>
            </div>
          </section>
        } @else if (optimization()) {
          <section class="optimizer-summary">
            <header class="optimizer-header">
              <mat-icon>local_shipping</mat-icon>
              <div>
                <h3>Optymalizacja koszyka</h3>
                <p>
                  Klocki w koszyku: {{ optimization()!.partsCount }},
                  znalezione: {{ optimization()!.partsWithAnyOffers }},
                  źródła: {{ selectedProvidersLabel() }}
                </p>
              </div>
            </header>

            <div class="optimizer-grid">
              <article
                class="optimizer-card single-seller"
                [class.best]="isSingleSellerCheaperOrEqualThanMixed()"
                [class.partial]="!hasSingleSellerFullCoverage()"
              >
                <h4>Najtaniej u jednego sprzedawcy</h4>
                @if (optimization()!.bestSingleSeller; as bestSingle) {
                  @if (getSummaryPrimaryProviderId(bestSingle); as providerId) {
                    <div class="source-brand">
                      <offer-provider-avatar
                        [sourceId]="providerId"
                        [label]="getSummaryPrimaryProviderLabel(bestSingle)"
                        [size]="16"
                      ></offer-provider-avatar>
                      <span class="source-state">
                        {{ getSummaryPrimaryProviderLabel(bestSingle) }}
                      </span>
                    </div>
                  }
                  <p class="seller-name">{{ bestSingle.sellerLogin || 'Sprzedawca' }}</p>
                  <p class="price-main">{{ formatMoney(bestSingle.estimatedGrandTotal, bestSingle.currency) }}</p>
                  <p class="price-breakdown">
                    Towar: {{ formatMoney(bestSingle.itemsTotal, bestSingle.currency) }}
                    · Dostawa: {{ formatMoney(bestSingle.estimatedShippingTotal, bestSingle.currency) }}
                  </p>
                  @if (optimization()!.cheapestMixed; as mixed) {
                    <p class="coverage">
                      Różnica vs mix:
                      {{ formatDiff(bestSingle.estimatedGrandTotal - mixed.estimatedGrandTotal, bestSingle.currency) }}
                    </p>
                  }
                  <p class="coverage">Znaleziono: {{ bestSingle.coveredParts }}/{{ optimization()!.partsCount }}</p>
                } @else if (optimization()!.bestPartialSingleSeller; as partial) {
                  @if (getSummaryPrimaryProviderId(partial); as providerId) {
                    <div class="source-brand">
                      <offer-provider-avatar
                        [sourceId]="providerId"
                        [label]="getSummaryPrimaryProviderLabel(partial)"
                        [size]="16"
                      ></offer-provider-avatar>
                      <span class="source-state">
                        {{ getSummaryPrimaryProviderLabel(partial) }}
                      </span>
                    </div>
                  }
                  <p class="seller-name">{{ partial.sellerLogin || 'Sprzedawca' }}</p>
                  <p class="price-main">{{ formatMoney(partial.estimatedGrandTotal, partial.currency) }}</p>
                  <p class="price-breakdown">
                    Towar: {{ formatMoney(partial.itemsTotal, partial.currency) }}
                    · Dostawa: {{ formatMoney(partial.estimatedShippingTotal, partial.currency) }}
                  </p>
                  <p class="coverage">Znaleziono: {{ partial.coveredParts }}/{{ optimization()!.partsCount }}</p>
                  @if (partial.missingPartNames.length > 0) {
                    <p class="coverage">Brakuje: {{ previewList(partial.missingPartNames, 3) }}</p>
                  }
                  <div class="single-seller-warning">
                    <mat-icon>error_outline</mat-icon>
                    <span>
                      Nie udało się skompletować całego zestawu u jednego sprzedawcy.
                    </span>
                  </div>
                } @else {
                  <p class="empty-note">Brak ofert dla wariantu jednego sprzedawcy.</p>
                }
                @if (getSingleSellerDetails(); as singleDetails) {
                  @if (singleDetails.selections.length > 0) {
                    <details class="single-offers">
                      <summary>Podejrzyj oferty tego sprzedawcy</summary>
                      <div class="single-offers-list">
                        @for (selection of singleDetails.selections; track selection.partKey + '-' + selection.offerId) {
                          <a
                            class="single-offer-link"
                            [href]="selection.offerUrl"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {{ selection.partName }} · {{ formatMoney(selection.offerPrice, selection.offerCurrency) }}
                          </a>
                        }
                      </div>
                    </details>
                  }
                }
              </article>

              <article class="optimizer-card mix-best">
                <h4>Najtańszy miks sprzedawców</h4>
                <p class="mix-emphasis">Najtaniej i najlepiej dla całego koszyka</p>
                @if (optimization()!.cheapestMixed; as mixed) {
                  <p class="price-main">{{ formatMoney(mixed.estimatedGrandTotal, mixed.currency) }}</p>
                  <p class="price-breakdown">
                    Towar: {{ formatMoney(mixed.itemsTotal, mixed.currency) }}
                    · Dostawa: {{ formatMoney(mixed.estimatedShippingTotal, mixed.currency) }}
                  </p>
                  <p class="coverage">Sprzedawcy: {{ mixed.sellersCount }}</p>
                  <p class="coverage subtle">Dostawa liczona raz na unikalnego sprzedawcę.</p>
                  @if (optimization()!.bestSingleSeller; as single) {
                    <p class="savings" [class.negative]="getMixedSavingsValue() !== null && getMixedSavingsValue()! < 0">
                      @if (getMixedSavingsValue() !== null && getMixedSavingsValue()! >= 0) {
                        Oszczędzasz {{ formatMoney(getMixedSavingsValue()!, mixed.currency) }} vs {{ single.sellerLogin || '1 sprzedawca' }}
                      } @else if (getMixedSavingsValue() !== null) {
                        Miks droższy o {{ formatMoney(abs(getMixedSavingsValue()!), mixed.currency) }} vs {{ single.sellerLogin || '1 sprzedawca' }}
                      }
                    </p>
                  }
                  @if (canOpenMixedRanking()) {
                    <button mat-stroked-button class="details-btn" (click)="openMixedRanking()">
                      Zobacz ranking miksu
                    </button>
                  }
                } @else {
                  <p class="empty-note">Brak wystarczających ofert do porównania.</p>
                }
              </article>
            </div>

            @if (topSingleSellerAlternatives().length > 1) {
              <div class="alt-list">
                <h4>Alternatywni sprzedawcy (pełny koszyk)</h4>
                <div class="alt-row">
                  @for (option of topSingleSellerAlternatives().slice(1, 4); track option.sellerId) {
                    <div class="alt-chip">
                      <strong>{{ option.sellerLogin || option.sellerId || 'Sprzedawca' }}</strong>
                      <span>{{ formatMoney(option.estimatedGrandTotal, option.currency) }}</span>
                    </div>
                  }
                </div>
              </div>
            }
          </section>
        }

        @if (availableSources().length > 0) {
          <section class="sources-panel">
            <header class="sources-header">
              <h3>Źródła ofert</h3>
              <p>Wybierz marketplace, z których chcesz liczyć koszyk.</p>
            </header>
            <div class="sources-row">
              @for (source of availableSources(); track source.id) {
                <button
                  type="button"
                  class="source-chip"
                  [class.active]="isProviderSelected(source.id)"
                  [class.disabled]="!isSourceSelectable(source)"
                  [disabled]="!isSourceSelectable(source)"
                  (click)="toggleProvider(source.id)"
                >
                  <span class="source-brand">
                    <offer-provider-avatar
                      [sourceId]="source.id"
                      [label]="source.label"
                      [size]="16"
                    ></offer-provider-avatar>
                    <strong>{{ source.label }}</strong>
                  </span>
                  <span class="source-state">{{ getSourceStatusLabel(source) }}</span>
                </button>
              }
            </div>
          </section>
        }

        @if (diagnostics(); as diag) {
          <section class="diagnostics-panel">
            <button
              type="button"
              class="diagnostics-toggle"
              (click)="toggleDiagnosticsExpanded()"
              [attr.aria-expanded]="isDiagnosticsExpanded()"
            >
              <span class="diagnostics-title">
                <mat-icon>monitor_heart</mat-icon>
                Panel diagnostyczny (DEV)
              </span>
              <span class="diagnostics-summary">
                {{ formatMs(diag.totalDurationMs) }} ·
                fetch {{ formatMs(diag.fetchOffersMs) }} ·
                opt {{ formatMs(diag.optimizationMs) }}
              </span>
              <mat-icon class="diagnostics-chevron">
                {{ isDiagnosticsExpanded() ? 'expand_less' : 'expand_more' }}
              </mat-icon>
            </button>

            @if (isDiagnosticsExpanded()) {
              <div class="diagnostics-body">
                <div class="diagnostics-kpis">
                  <span>Pozycje: <strong>{{ diag.partsCount }}</strong></span>
                  <span>Part workers: <strong>{{ diag.partConcurrency }}</strong></span>
                  <span>Provider workers: <strong>{{ diag.providerConcurrency }}</strong></span>
                  <span>TTL cache: <strong>{{ formatMs(diag.cacheTtlMs) }}</strong></span>
                  <span>Provider query: <strong>{{ diag.providersRequested.length > 0 ? diag.providersRequested.join(', ') : 'wszystkie aktywne' }}</strong></span>
                  <span>Provider active: <strong>{{ diag.providersResolved.join(', ') || 'brak' }}</strong></span>
                </div>

                @if (diag.providerStats.length > 0) {
                  <div class="diagnostics-table-wrap">
                    <table class="diagnostics-table">
                      <thead>
                        <tr>
                          <th>Provider</th>
                          <th>Cache</th>
                          <th>In-flight</th>
                          <th>Cooldown</th>
                          <th>Req OK/FAIL</th>
                          <th>Oferty</th>
                          <th>AVG</th>
                          <th>MIN-MAX</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (entry of diag.providerStats; track entry.providerId) {
                          <tr>
                            <td>{{ entry.providerId }}</td>
                            <td>{{ entry.cacheHits }}/{{ entry.cacheMisses }}</td>
                            <td>{{ entry.inFlightHits }}</td>
                            <td>{{ entry.cooldownSkips }}</td>
                            <td>{{ entry.requestsSucceeded }}/{{ entry.requestsFailed }}</td>
                            <td>{{ entry.offersReturned }}</td>
                            <td>{{ formatMs(entry.avgDurationMs) }}</td>
                            <td>{{ formatMs(entry.minDurationMs) }} - {{ formatMs(entry.maxDurationMs) }}</td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                }
              </div>
            }
          </section>
        }

        @if (!isOffersLoading() && displayResults().length === 0) {
          <div class="no-offers global-empty">
            <mat-icon>search_off</mat-icon>
            <div>
              <strong>Nie znaleziono ofert dla obecnych ustawień.</strong>
              <span>Spróbuj odblokować więcej źródeł albo zmienić kolor/ilość w koszyku.</span>
            </div>
          </div>
        }

        @for (res of displayResults(); track res.key) {
          <section class="part-offers-group" [class.loading]="isOffersLoading()">
            <header class="group-header">
              <mat-icon color="primary">extension</mat-icon>
              <h3>{{ res.partName || ('Klocek ID: ' + res.id) }}</h3>
              <span class="qty-badge">x{{ sanitizeQuantity(res.quantity) }}</span>
              @if (res.selectedColorName) {
                <span class="selected-color-chip">
                  <span class="selected-color-dot" [style.background-color]="asCssColor(res.selectedColorRgb)"></span>
                  {{ res.selectedColorName }}
                </span>
              }
              <span class="count-badge">{{ isOffersLoading() ? '...' : (res.offers.length + ' ofert') }}</span>
            </header>

            <div class="offers-scroll-row">
              @if (isOffersLoading()) {
                @for (slot of skeletonOfferSlots; track slot) {
                  <div class="offer-mini-card skeleton-card">
                    <div class="skeleton sk-image"></div>
                    <div class="skeleton sk-price"></div>
                    <div class="skeleton sk-line"></div>
                    <div class="skeleton sk-line short"></div>
                    <div class="skeleton sk-btn"></div>
                  </div>
                }
              } @else {
                @for (offer of res.offers; track offer.id) {
                  <div class="offer-mini-card">
                    <div class="img-wrapper">
                      <img [src]="offer.thumbnail" [alt]="offer.name">
                    </div>
                    @if (offer.providerLabel || offer.provider) {
                      <span class="offer-provider-corner">{{ offer.providerLabel || offer.provider }}</span>
                    }
                    <div class="offer-info">
                      <span class="price">{{ offer.price }} {{ offer.currency }}</span>
                      <p class="name">{{ offer.name }}</p>
                      @if (offer.sellerLogin || offer.sellerCountryFlagUrl || offer.sellerCountryCode) {
                        <div class="seller-row">
                          <p class="seller">
                            @if (offer.sellerLogin) {
                              @{{ offer.sellerLogin }}
                            } @else {
                              sprzedawca
                            }
                          </p>
                          @if (offer.sellerCountryFlagUrl) {
                            <img
                              class="seller-flag"
                              [src]="offer.sellerCountryFlagUrl"
                              [alt]="offer.sellerCountry || offer.sellerCountryCode || 'Kraj sprzedawcy'"
                              [title]="offer.sellerCountry || offer.sellerCountryCode || 'Kraj sprzedawcy'"
                            >
                          } @else if (offer.sellerCountryCode) {
                            <span
                              class="seller-country-code"
                              [title]="offer.sellerCountry || offer.sellerCountryCode"
                            >
                              {{ offer.sellerCountryCode }}
                            </span>
                          }
                        </div>
                      }
                      @if (offer.color) {
                        <span
                          class="offer-color"
                          [class.match]="offer.colorMatchScore && offer.colorMatchScore >= 2"
                        >
                          <span
                            class="offer-color-dot"
                            [style.background-color]="resolveOfferColorPreview(offer.color, res.selectedColorRgb)"
                          ></span>
                          {{ offer.color }}
                        </span>
                      }
                      @if (offer.shippingMissingPrice) {
                        <span class="offer-shipping-missing">brak ceny wysyłki</span>
                      }
                      @if (offer.isEstimated) {
                        <span class="offer-benchmark">Benchmark</span>
                      }
                    </div>
                    <a [href]="offer.url" target="_blank" class="buy-btn">
                      Zobacz ofertę
                    </a>
                  </div>
                } @empty {
                  <div class="no-offers modern-empty">
                    <mat-icon>inventory_2</mat-icon>
                    <div>
                      <strong>Brak ofert dla tej pozycji.</strong>
                      <span>Sprawdź inny kolor, zwiększ liczbę źródeł lub przelicz koszyk ponownie.</span>
                    </div>
                  </div>
                }
              }
            </div>
            <mat-divider></mat-divider>
          </section>
        }
      </div>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button
        mat-button
        [mat-dialog-close]="{ parts: cartParts(), hasPendingCartChanges: hasPendingCartChanges() }"
      >
        ZAMKNIJ
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .results-container { display: flex; flex-direction: column; gap: 24px; }
    .skeleton {
      position: relative;
      overflow: hidden;
      background: #e5e7eb;
      border-radius: 6px;
    }
    .skeleton::after {
      content: '';
      position: absolute;
      inset: 0;
      transform: translateX(-100%);
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.6), transparent);
      animation: shimmer 1.2s infinite;
    }
    @keyframes shimmer {
      100% { transform: translateX(100%); }
    }
    .skeleton.line { height: 12px; margin-bottom: 8px; }
    .skeleton.line.sm { width: 42%; }
    .skeleton.line.md { width: 62%; }
    .skeleton.line.lg { width: 78%; }
    .sources-panel {
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      background: #fff;
      padding: 12px;
    }
    .diagnostics-panel {
      border: 1px dashed #d1d5db;
      border-radius: 12px;
      background: #f8fafc;
      overflow: hidden;
    }
    .diagnostics-toggle {
      width: 100%;
      border: 0;
      background: transparent;
      cursor: pointer;
      padding: 10px 12px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 8px;
      text-align: left;
    }
    .diagnostics-title {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 800;
      color: #0f172a;
    }
    .diagnostics-title mat-icon,
    .diagnostics-chevron {
      width: 16px;
      height: 16px;
      font-size: 16px;
      color: #475569;
    }
    .diagnostics-summary {
      font-size: 11px;
      color: #64748b;
      font-weight: 700;
      white-space: nowrap;
    }
    .diagnostics-body {
      border-top: 1px dashed #d1d5db;
      padding: 10px 12px 12px;
      display: grid;
      gap: 10px;
    }
    .diagnostics-kpis {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      font-size: 11px;
      color: #334155;
    }
    .diagnostics-kpis strong {
      color: #0f172a;
      font-weight: 800;
    }
    .diagnostics-table-wrap {
      overflow-x: auto;
    }
    .diagnostics-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
      color: #334155;
    }
    .diagnostics-table th,
    .diagnostics-table td {
      padding: 6px 8px;
      border-bottom: 1px solid #e2e8f0;
      text-align: left;
      white-space: nowrap;
    }
    .diagnostics-table th {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #64748b;
      font-weight: 800;
    }
    .sources-header {
      display: grid;
      gap: 2px;
      margin-bottom: 10px;
    }
    .sources-header h3 { margin: 0; font-size: 14px; font-weight: 800; }
    .sources-header p {
      margin: 0;
      font-size: 12px;
      color: #6b7280;
    }
    .sources-row {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
    }
    .source-chip {
      border: 1px solid #d1d5db;
      background: #fff;
      border-radius: 10px;
      padding: 8px 10px;
      min-width: 0;
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
      cursor: pointer;
      text-align: left;
      transition: all .15s ease;
      font-size: 11px;
      color: #4b5563;
    }
    .source-brand {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .source-chip strong { font-size: 12px; color: #111827; }
    .source-chip .source-state {
      font-weight: 600;
      color: #6b7280;
      font-size: 10px;
      line-height: 1.2;
    }
    .source-chip.active {
      border-color: #2563eb;
      background: #eff6ff;
      color: #1d4ed8;
    }
    .source-chip.disabled {
      opacity: .55;
      cursor: not-allowed;
    }
    .cart-panel {
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      background: #fff;
      padding: 12px;
      display: grid;
      gap: 10px;
    }
    .cart-panel.dirty {
      border-color: #e3c150;
      background: linear-gradient(180deg, #fffcf1 0%, #ffffff 100%);
    }
    .cart-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .cart-panel-header h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 800;
    }
    .cart-panel-clear {
      min-width: 0;
      padding: 0 8px;
      font-size: 12px;
      font-weight: 700;
    }
    .cart-panel-list {
      display: grid;
      gap: 8px;
    }
    .cart-line {
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      padding: 8px;
      background: #f9fafb;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .cart-line-main {
      min-width: 0;
      display: grid;
      gap: 3px;
    }
    .cart-line-main strong {
      font-size: 12px;
      color: #111827;
      line-height: 1.25;
    }
    .cart-line-color {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      color: #4b5563;
      font-weight: 700;
    }
    .cart-line-color-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      border: 1px solid rgba(0, 0, 0, 0.2);
      display: inline-block;
    }
    .cart-line-actions {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .qty-btn,
    .remove-line-btn {
      width: 28px;
      height: 28px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      background: #fff;
      color: #4b5563;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
    }
    .qty-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .qty-btn mat-icon,
    .remove-line-btn mat-icon {
      width: 16px;
      height: 16px;
      font-size: 16px;
    }
    .remove-line-btn {
      color: #b91c1c;
      border-color: #f3d0d0;
      background: #fff7f7;
    }
    .qty-input {
      width: 52px;
      height: 28px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      text-align: center;
      font-size: 12px;
      font-weight: 800;
      color: #111827;
      background: #fff;
      outline: none;
      padding: 0 4px;
    }
    .qty-input:focus {
      border-color: #c81f20;
      box-shadow: 0 0 0 2px rgba(200, 31, 32, 0.18);
    }
    .recompute-btn {
      justify-self: start;
      height: 34px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 800;
      background: linear-gradient(135deg, #fff3b4, #f4c714);
      color: #3f3200;
    }
    .cart-empty-note {
      margin: 0;
      font-size: 12px;
      color: #6b7280;
    }
    .request-error {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      border-radius: 10px;
      border: 1px solid #fecaca;
      background: #fff7f7;
      color: #991b1b;
      font-size: 12px;
      font-weight: 700;
    }
    .request-error mat-icon {
      width: 16px;
      height: 16px;
      font-size: 16px;
    }
    .optimizer-summary {
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 16px;
      background: linear-gradient(180deg, #f8fafc 0%, #ffffff 100%);
    }
    .optimizer-skeleton .optimizer-card { min-height: 76px; }
    .optimizer-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 14px;
    }
    .optimizer-header h3 { margin: 0; font-size: 16px; font-weight: 800; }
    .optimizer-header p { margin: 2px 0 0; color: #6b7280; font-size: 12px; }
    .optimizer-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .optimizer-card {
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      background: #fff;
      padding: 12px;
    }
    .optimizer-card.single-seller.best {
      border-color: #86efac;
      background: #f0fdf4;
    }
    .optimizer-card.single-seller.partial {
      border-color: #d1d5db;
      background: #f8fafc;
    }
    .optimizer-card.mix-best {
      border-color: #86efac;
      background: linear-gradient(180deg, #f0fdf4 0%, #ffffff 100%);
    }
    .optimizer-card h4 {
      margin: 0 0 8px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #4b5563;
    }
    .mix-emphasis {
      margin: -2px 0 8px;
      font-size: 12px;
      font-weight: 800;
      color: #065f46;
    }
    .seller-name { margin: 0 0 4px; font-weight: 700; font-size: 13px; }
    .price-main { margin: 0; font-size: 20px; font-weight: 900; color: #111827; }
    .price-breakdown { margin: 4px 0 0; font-size: 12px; color: #4b5563; }
    .coverage { margin: 6px 0 0; font-size: 12px; color: #374151; }
    .coverage.subtle { color: #6b7280; font-size: 11px; }
    .empty-note { margin: 0; color: #6b7280; font-size: 12px; }
    .empty-note.compact { margin-top: 6px; font-size: 11px; }
    .single-seller-warning {
      margin-top: 8px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 8px;
      padding: 6px 8px;
      border: 1px solid #f3d0d0;
      background: #fff7f7;
      color: #8a1c1c;
      font-size: 11px;
      font-weight: 700;
      line-height: 1.25;
    }
    .single-seller-warning mat-icon {
      width: 14px;
      height: 14px;
      font-size: 14px;
    }
    .savings {
      margin: 6px 0 0;
      font-size: 12px;
      font-weight: 800;
      color: #065f46;
    }
    .savings.negative { color: #991b1b; }
    .savings.neutral { color: #4b5563; font-weight: 700; }
    .details-btn { margin-top: 8px; height: 30px; font-size: 11px; }
    .single-offers {
      margin-top: 10px;
    }
    .single-offers summary {
      cursor: pointer;
      font-size: 11px;
      font-weight: 700;
      color: #1f2937;
    }
    .single-offers-list {
      margin-top: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .single-offer-link {
      font-size: 11px;
      color: #1d4ed8;
      text-decoration: none;
      line-height: 1.25;
    }
    .single-offer-link:hover {
      text-decoration: underline;
    }
    .alt-list { margin-top: 12px; }
    .alt-list h4 { margin: 0 0 8px; font-size: 12px; color: #4b5563; text-transform: uppercase; letter-spacing: 0.04em; }
    .alt-row { display: flex; flex-wrap: wrap; gap: 8px; }
    .alt-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid #d1d5db;
      border-radius: 999px;
      padding: 4px 10px;
      background: #fff;
      font-size: 11px;
    }
    .group-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .group-header h3 { margin: 0; font-weight: 700; }
    .count-badge { background: #eee; padding: 2px 8px; border-radius: 12px; font-size: 12px; min-width: 44px; text-align: center; }
    .qty-badge {
      border: 1px solid #d1d5db;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 800;
      color: #374151;
      background: #fff;
    }
    .selected-color-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid #d1d5db;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 700;
    }
    .selected-color-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      border: 1px solid rgba(0,0,0,0.2);
      display: inline-block;
    }
    
    .offers-scroll-row { 
      display: flex; gap: 16px; overflow-x: auto; padding-bottom: 16px; 
      &::-webkit-scrollbar { height: 6px; }
      &::-webkit-scrollbar-thumb { background: #ccc; border-radius: 3px; }
    }

    .offer-mini-card {
      position: relative;
      min-width: 176px;
      max-width: 176px;
      min-height: 304px;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: #fff;

      .img-wrapper {
        height: 100px;
        width: 100%;
        display: flex;
        justify-content: center;
        align-items: center;
        overflow: hidden;
        border-radius: 8px;

        img {
          width: 100%;
          height: 100%;
          max-width: 100%;
          max-height: 100%;
          object-fit: contain;
          display: block;
        }
      }
      .offer-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
        flex: 1;
        min-height: 0;
      }
      .price { color: #991b1b; font-weight: 800; font-size: 1.05rem; }
      .name { font-size: 11px; color: #374151; height: 30px; overflow: hidden; margin: 0; }
      .seller-row {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .seller { font-size: 10px; color: #6b7280; margin: 0; display: inline; }
      .seller-flag {
        width: 14px;
        height: 10px;
        border-radius: 2px;
        border: 1px solid #d1d5db;
        object-fit: cover;
      }
      .seller-country-code {
        font-size: 9px;
        font-weight: 800;
        color: #6b7280;
        border: 1px solid #d1d5db;
        border-radius: 999px;
        padding: 0 4px;
      }
      .offer-benchmark,
      .offer-shipping-missing {
        display: inline-flex;
        align-self: flex-start;
        font-size: 10px;
        font-weight: 700;
        border: 1px solid #d1d5db;
        border-radius: 999px;
        padding: 2px 6px;
      }
      .offer-benchmark { color: #92400e; background: #fffbeb; border-color: #fcd34d; }
      .offer-shipping-missing {
        color: #9a3412;
        background: #fff7ed;
        border-color: #fdba74;
      }
      .offer-color {
        display: inline-flex;
        align-self: flex-start;
        align-items: center;
        gap: 5px;
        font-size: 10px;
        font-weight: 600;
        color: #4b5563;
        border: 1px solid #e5e7eb;
        border-radius: 999px;
        padding: 1px 7px;
        max-width: 100%;
      }
      .offer-color-dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        border: 1px solid rgba(0,0,0,0.18);
        flex-shrink: 0;
      }
      .offer-color.match {
        color: #4b5563;
        border-color: #d6dbe4;
        background: #f8fafc;
      }
      .buy-btn {
        width: 100%;
        margin-top: auto;
        height: 30px;
        border-radius: 8px;
        border: 1px solid #d7aa0b;
        background: linear-gradient(135deg, #fff3b4, #f4c714);
        color: #3f3200;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 800;
        text-decoration: none;
      }
    }
    .offer-provider-corner {
      position: absolute;
      top: 6px;
      right: 6px;
      font-size: 9px;
      font-weight: 800;
      color: #475569;
      border: 1px solid #d1d5db;
      border-radius: 999px;
      padding: 2px 6px;
      background: rgba(255, 255, 255, 0.96);
      pointer-events: none;
    }
    .offer-mini-card.skeleton-card {
      .sk-image { height: 100px; border-radius: 8px; }
      .sk-price { height: 18px; width: 58%; }
      .sk-line { height: 10px; width: 100%; }
      .sk-line.short { width: 72%; }
      .sk-btn { height: 32px; width: 100%; border-radius: 8px; margin-top: 4px; }
    }

    .no-offers { display: flex; align-items: center; gap: 8px; padding: 16px; color: #999; font-style: italic; }
    .no-offers.global-empty {
      border: 1px dashed #d1d5db;
      border-radius: 10px;
      background: linear-gradient(180deg, #f8fafc 0%, #ffffff 100%);
      color: #6b7280;
      font-style: normal;
      align-items: flex-start;
    }
    .no-offers.global-empty > div {
      display: grid;
      gap: 2px;
    }
    .no-offers.global-empty strong {
      font-size: 13px;
      color: #334155;
    }
    .no-offers.global-empty span {
      font-size: 12px;
      color: #64748b;
    }
    .modern-empty {
      min-width: 100%;
      border: 1px dashed #d1d5db;
      border-radius: 10px;
      background: linear-gradient(180deg, #f9fafb 0%, #ffffff 100%);
      color: #6b7280;
      font-style: normal;
      justify-content: center;
      text-align: left;
      align-items: flex-start;
    }
    .modern-empty > div {
      display: grid;
      gap: 2px;
    }
    .modern-empty strong {
      font-size: 12px;
      color: #334155;
    }
    .modern-empty span {
      font-size: 11px;
      color: #64748b;
    }
    .modern-empty mat-icon {
      color: #9ca3af;
    }

    @media (max-width: 720px) {
      .sources-row {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .optimizer-grid {
        grid-template-columns: 1fr;
      }
      .cart-line {
        flex-direction: column;
        align-items: flex-start;
      }
      .cart-line-actions {
        width: 100%;
        justify-content: flex-end;
      }
      .recompute-btn {
        width: 100%;
        justify-self: stretch;
      }
    }
    @media (max-width: 460px) {
      .sources-row {
        grid-template-columns: 1fr;
      }
    }
  `]
})
export class PartOffersDialogComponent implements OnInit, OnDestroy {
  private readonly partService = inject(PartService);
  private readonly dialogService = inject(MatDialog);
  private readonly data = inject<PartOffersDialogData>(MAT_DIALOG_DATA);
  private requestSequence = 0;
  private offerSourcesSub: Subscription | null = null;
  private batchOffersSub: Subscription | null = null;
  protected readonly cartParts = signal<BatchOfferPartRequest[]>(
    (this.data.parts || []).map((part) => ({
      ...part,
      quantity: this.sanitizeQuantity(part.quantity),
    })),
  );
  protected readonly hasPendingCartChanges = signal<boolean>(false);

  protected readonly isOffersLoading = signal(true);
  protected readonly isOptimizationLoading = signal(true);
  protected readonly results = signal<OfferResult[]>([]);
  protected readonly optimization = signal<CartOptimizationSummary | null>(null);
  protected readonly diagnostics = signal<BatchOffersDiagnostics | null>(null);
  protected readonly isDiagnosticsExpanded = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly availableSources = signal<OfferSourceDescriptor[]>([]);
  protected readonly selectedProviders = signal<string[]>([]);
  protected readonly skeletonOfferSlots = [0, 1, 2, 3];
  protected readonly asCssColor = asCssColor;
  protected readonly resolveOfferColorPreview = resolveOfferColorPreview;

  private buildFallbackResults(parts: BatchOfferPartRequest[]): OfferResult[] {
    return (parts || []).map((part) => ({
      key: part.key,
      id: part.id,
      designId: part.designId || null,
      partName: part.partName || part.designId || String(part.id),
      selectedColorId: part.selectedColorId ?? null,
      selectedColorName: part.selectedColorName ?? null,
      selectedColorRgb: part.selectedColorRgb ?? null,
      quantity: this.sanitizeQuantity(part.quantity),
      offers: [],
    }));
  }

  private syncResultsWithCart(): void {
    const byKey = new Map(
      this.cartParts().map((part) => [String(part.key), part] as const),
    );
    const next = this.results()
      .filter((result) => byKey.has(String(result.key)))
      .map((result) => {
        const part = byKey.get(String(result.key));
        if (!part) return result;
        return {
          ...result,
          quantity: this.sanitizeQuantity(part.quantity),
          selectedColorId: part.selectedColorId ?? null,
          selectedColorName: part.selectedColorName ?? null,
          selectedColorRgb: part.selectedColorRgb ?? null,
          partName: part.partName || result.partName,
        };
      });
    this.results.set(next);
  }

  private mutateCartParts(
    mutator: (parts: BatchOfferPartRequest[]) => BatchOfferPartRequest[],
  ): void {
    const snapshot = this.cartParts().map((part) => ({ ...part }));
    const next = mutator(snapshot);
    this.cartParts.set(next);
    this.hasPendingCartChanges.set(next.length > 0);
    this.syncResultsWithCart();
    this.optimization.set(null);
  }

  ngOnInit(): void {
    this.offerSourcesSub?.unsubscribe();
    this.offerSourcesSub = this.partService.getOfferSources().subscribe({
      next: (res) => {
        const sources = res.sources || [];
        this.availableSources.set(sources);
        const selectableProviders = this.getSelectableProviderIds();
        const explicitProviders = Array.isArray(this.data.providers)
          ? Array.from(
              new Set(
                this.data.providers!
                  .map((providerId) => String(providerId || '').trim())
                  .filter((providerId) => selectableProviders.includes(providerId)),
              ),
            )
          : [];

        // [] means "all active" to keep UX consistent with filter semantics.
        this.selectedProviders.set(explicitProviders.length > 0 ? explicitProviders : []);
        this.reloadOffers(false);
      },
      error: () => {
        this.availableSources.set([]);
        const fallbackProviders = Array.isArray(this.data.providers)
          ? this.data.providers.filter((providerId) => String(providerId || '').trim().length > 0)
          : [];
        this.selectedProviders.set(fallbackProviders.length > 0 ? fallbackProviders : []);
        this.reloadOffers(false);
      },
    });
  }

  ngOnDestroy(): void {
    this.offerSourcesSub?.unsubscribe();
    this.offerSourcesSub = null;
    this.batchOffersSub?.unsubscribe();
    this.batchOffersSub = null;
  }

  protected reloadOffers(
    preserveCurrentState = true,
    reason: ReloadReason = 'provider',
  ): void {
    const cartParts = this.cartParts();
    if (cartParts.length === 0) {
      this.requestSequence += 1;
      this.batchOffersSub?.unsubscribe();
      this.batchOffersSub = null;
      this.results.set([]);
      this.optimization.set(null);
      this.diagnostics.set(null);
      this.isOffersLoading.set(false);
      this.isOptimizationLoading.set(false);
      this.hasPendingCartChanges.set(false);
      this.loadError.set(null);
      return;
    }

    const currentRequest = ++this.requestSequence;
    this.isOffersLoading.set(true);
    this.isOptimizationLoading.set(true);
    this.loadError.set(null);
    const hasVisibleResults = this.results().length > 0;
    const refreshMissingOnly = reason === 'manual' && hasVisibleResults;
    const refreshMissingPartKeys = refreshMissingOnly
      ? this.results()
          .filter((result) => !Array.isArray(result.offers) || result.offers.length === 0)
          .map((result) => String(result.key || '').trim())
          .filter((entry) => entry.length > 0)
      : [];
    const forceRefresh = reason === 'manual';

    this.batchOffersSub?.unsubscribe();
    this.batchOffersSub = this.partService
      .getBatchOffers(cartParts, this.getEffectiveSelectedProviderIds(), {
        forceRefresh,
        refreshMissingOnly,
        refreshMissingPartKeys,
      })
      .subscribe({
        next: (res) => {
          if (currentRequest !== this.requestSequence) return;
          this.results.set(res.results || []);
          this.optimization.set(res.optimization || null);
          this.diagnostics.set(res.diagnostics || null);
          this.isOffersLoading.set(false);
          this.isOptimizationLoading.set(false);
          this.hasPendingCartChanges.set(false);
          this.loadError.set(null);
          this.batchOffersSub = null;
        },
        error: () => {
          if (currentRequest !== this.requestSequence) return;
          if (!preserveCurrentState) {
            this.results.set([]);
            this.optimization.set(null);
            this.diagnostics.set(null);
          }
          this.isOffersLoading.set(false);
          this.isOptimizationLoading.set(false);
          this.loadError.set(
            'Nie udało się pobrać ofert. Sprawdź połączenie z API i spróbuj ponownie.',
          );
          this.batchOffersSub = null;
        },
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

  protected getSourceStatusLabel(source: OfferSourceDescriptor): string {
    if (!source.enabled) return 'Wyłączone';
    if (!source.configured) return 'Brak konfiguracji API';
    return this.isProviderSelected(source.id)
      ? 'Uwzględnione w porównaniu'
      : 'Kliknij, aby dodać';
  }

  // Backward-compatibility for older compiled template chunks.
  protected getSourceHintLabel(source: OfferSourceDescriptor): string {
    return this.getSourceStatusLabel(source);
  }

  protected hasSingleSellerFullCoverage(): boolean {
    return Boolean(this.optimization()?.bestSingleSeller);
  }

  protected isSingleSellerCheaperOrEqualThanMixed(): boolean {
    const optimization = this.optimization();
    const single = optimization?.bestSingleSeller;
    const mixed = optimization?.cheapestMixed;
    if (!single || !mixed) return false;
    return single.estimatedGrandTotal <= mixed.estimatedGrandTotal;
  }

  protected getSingleSellerDetails() {
    const optimization = this.optimization();
    if (!optimization) return null;
    return optimization.bestSingleSeller || optimization.bestPartialSingleSeller || null;
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
    this.reloadOffers(true);
  }

  protected adjustCartQuantity(partKey: string, delta: number): void {
    if (!delta) return;
    this.mutateCartParts((parts) =>
      parts.map((part) => {
        if (part.key !== partKey) return part;
        return {
          ...part,
          quantity: this.sanitizeQuantity((part.quantity ?? 1) + delta),
        };
      }),
    );
  }

  protected setCartQuantityFromInput(
    partKey: string,
    rawValue: string | number | null,
  ): void {
    const parsed =
      typeof rawValue === 'number'
        ? rawValue
        : Number.parseInt(String(rawValue || ''), 10);
    const nextQuantity = this.sanitizeQuantity(
      Number.isFinite(parsed) ? parsed : 1,
    );
    this.mutateCartParts((parts) =>
      parts.map((part) =>
        part.key === partKey ? { ...part, quantity: nextQuantity } : part,
      ),
    );
  }

  protected removeCartPart(partKey: string): void {
    this.mutateCartParts((parts) => parts.filter((part) => part.key !== partKey));
  }

  protected clearDialogCart(): void {
    this.requestSequence += 1;
    this.batchOffersSub?.unsubscribe();
    this.batchOffersSub = null;
    this.cartParts.set([]);
    this.results.set([]);
    this.optimization.set(null);
    this.diagnostics.set(null);
    this.isOffersLoading.set(false);
    this.isOptimizationLoading.set(false);
    this.hasPendingCartChanges.set(false);
    this.loadError.set(null);
  }

  protected toggleDiagnosticsExpanded(): void {
    this.isDiagnosticsExpanded.update((current) => !current);
  }

  protected formatMs(value?: number | null): string {
    const safeValue = Number(value);
    if (!Number.isFinite(safeValue) || safeValue < 0) return '0 ms';
    if (safeValue >= 1000) return `${(safeValue / 1000).toFixed(2)} s`;
    return `${Math.round(safeValue)} ms`;
  }

  protected displayResults(): OfferResult[] {
    const parts = this.cartParts();
    if (parts.length === 0) return [];

    const partKeys = new Set(parts.map((part) => String(part.key)));
    const currentResults = this.results().filter((result) =>
      partKeys.has(String(result.key)),
    );

    if (currentResults.length > 0) {
      return currentResults;
    }

    return this.buildFallbackResults(parts);
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

  protected sanitizeQuantity(value?: number | null): number {
    const parsed = Number.parseInt(String(value ?? '1'), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 1;
    return Math.min(parsed, 999);
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

  protected getMixedSavingsValue(): number | null {
    const optimization = this.optimization();
    if (!optimization?.cheapestMixed || !optimization?.bestSingleSeller) {
      return null;
    }

    return (
      optimization.bestSingleSeller.estimatedGrandTotal -
      optimization.cheapestMixed.estimatedGrandTotal
    );
  }

  protected previewList(items: string[], max = 3): string {
    const safeItems = Array.isArray(items) ? items.filter((entry) => !!entry) : [];
    if (safeItems.length === 0) return 'brak';
    if (safeItems.length <= max) return safeItems.join(', ');
    return `${safeItems.slice(0, max).join(', ')} +${safeItems.length - max}`;
  }

  protected canOpenMixedRanking(): boolean {
    return this.getMixedRankingOptions(this.optimization()).length > 0;
  }

  protected openMixedRanking(): void {
    const optimization = this.optimization();
    if (!optimization) {
      return;
    }

    const options = this.getMixedRankingOptions(optimization);

    if (options.length === 0) {
      return;
    }

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
