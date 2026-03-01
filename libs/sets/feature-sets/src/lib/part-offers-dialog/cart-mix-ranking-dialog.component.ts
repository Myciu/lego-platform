import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { MatTooltipModule } from '@angular/material/tooltip';
import { CartOfferSummary } from '@lego-tracker/sets/data-access';

@Component({
  selector: 'lib-cart-mix-ranking-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatDividerModule,
    MatTooltipModule,
  ],
  template: `
    <h2 mat-dialog-title>Ranking miksu sprzedawców</h2>

    <mat-dialog-content>
      <p class="intro">
        Ranking uwzględnia cenę klocków i szacowany koszt przesyłki dla użytych sprzedawców.
      </p>
      <p class="intro subtle">
        Wysyłka w totalu jest liczona raz na unikalnego sprzedawcę.
      </p>
      <p class="intro subtle">
        @if (totalOptions >= 5) {
          Pokazujemy TOP 5 najbardziej opłacalnych wariantów.
        } @else {
          Dostępne warianty: {{ totalOptions }}.
        }
      </p>

      <div class="ranking-list">
        @for (option of options; track optionIndex($index, option)) {
          <section class="rank-card">
            <header class="rank-head">
              <div class="rank-number">#{{ $index + 1 }}</div>
              <div>
                <h3>{{ formatMoney(option.estimatedGrandTotal, option.currency) }}</h3>
                <p>
                  Towar: {{ formatMoney(option.itemsTotal, option.currency) }}
                  · Przesyłka: {{ formatMoney(option.estimatedShippingTotal, option.currency) }}
                </p>
              </div>
              <div class="meta">
                <span>{{ option.sellersCount }} sprzedawców</span>
                <span>{{ option.coveredParts }} / {{ partsCount }} klocków</span>
              </div>
            </header>
            @if ($index > 0) {
              <p class="delta" [class.positive]="getDeltaToBest(option) >= 0">
                {{ getDeltaToBest(option) >= 0 ? '+' : '' }}{{ formatMoney(getDeltaToBest(option), option.currency) }} vs #1
              </p>
            }

            <details>
              <summary>Szczegóły koszyka</summary>
              <div class="details-list">
                @for (selection of option.selections; track selection.partKey) {
                  <article class="row">
                    <div>
                      <strong>{{ selection.partName }}</strong>
                      <p>
                        Kolor: {{ selection.requestedColorName || selection.offerColor || 'Nieokreślony' }}
                        @if (selection.offerColor && selection.requestedColorName && selection.offerColor !== selection.requestedColorName) {
                          <span> (oferta: {{ selection.offerColor }})</span>
                        }
                      </p>
                      <p>Ilość: {{ selection.requestedQuantity }} · Źródło: {{ selection.provider || 'nieznane' }}</p>
                      <p>
                        @{{ selection.sellerLogin || selection.sellerId || 'sprzedawca' }}
                        @if (getSellerTrust(selection); as trust) {
                          <span
                            class="seller-trust"
                            [ngClass]="'tone-' + trust.tone"
                            [matTooltip]="trust.tooltip"
                          >
                            <mat-icon>{{ trust.icon }}</mat-icon>
                            {{ trust.label }}
                          </span>
                        }
                        @if (selection.sellerCountryFlagUrl) {
                          <img
                            class="seller-flag"
                            [src]="selection.sellerCountryFlagUrl"
                            [alt]="selection.sellerCountryCode || 'Kraj sprzedawcy'"
                            [title]="selection.sellerCountryCode || 'Kraj sprzedawcy'"
                          >
                        } @else if (selection.sellerCountryCode) {
                          <span class="seller-country-code">{{ selection.sellerCountryCode }}</span>
                        }
                      </p>
                      <a
                        class="offer-link"
                        [href]="selection.offerUrl"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Otwórz ofertę
                      </a>
                    </div>
                    <div class="amounts">
                      @if (selection.offerUnitsToBuy && selection.offerUnitQuantity && selection.offerUnitQuantity > 1) {
                        <span>
                          {{ selection.offerUnitsToBuy }} × pakiet po {{ selection.offerUnitQuantity }} szt.
                        </span>
                      }
                      <span>{{ formatMoney(selection.unitOfferPrice, selection.offerCurrency) }} / szt. (efektywnie)</span>
                      <span>{{ formatMoney(selection.offerPrice, selection.offerCurrency) }} łącznie</span>
                      @if (selection.shippingMissingPrice) {
                        <span class="shipping missing">Dostawa: brak ceny wysyłki</span>
                      } @else {
                        <span class="shipping">
                          Dostawa sprzedawcy: {{ formatMoney(selection.estimatedDeliveryPrice, selection.offerCurrency) }}
                          (nie sumuje się per pozycja)
                        </span>
                      }
                    </div>
                  </article>
                }
              </div>
            </details>
          </section>
        } @empty {
          <div class="empty">
            <mat-icon>sentiment_dissatisfied</mat-icon>
            <span>Brak wariantów miksu do pokazania.</span>
          </div>
        }
      </div>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Zamknij</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .intro { margin: 0 0 8px; color: #4b5563; font-size: 12px; }
    .intro.subtle { margin: 0 0 6px; color: #6b7280; }
    .ranking-list { display: flex; flex-direction: column; gap: 12px; }
    .rank-card {
      border: 1px solid #d1d5db;
      border-radius: 12px;
      padding: 12px;
      background: #fff;
    }
    .rank-head { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center; }
    .rank-number {
      width: 30px;
      height: 30px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      background: #111827;
      color: #fff;
      font-weight: 800;
      font-size: 12px;
    }
    .rank-head h3 { margin: 0; font-size: 18px; font-weight: 900; }
    .rank-head p { margin: 2px 0 0; font-size: 12px; color: #4b5563; }
    .meta { display: flex; flex-direction: column; align-items: flex-end; font-size: 11px; color: #6b7280; gap: 3px; }
    .delta {
      margin: 8px 0 0;
      font-size: 11px;
      font-weight: 800;
      color: #991b1b;
    }
    .delta.positive { color: #065f46; }
    details { margin-top: 10px; }
    summary { cursor: pointer; font-weight: 700; font-size: 12px; color: #111827; }
    .details-list { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
    .row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 8px;
      background: #f9fafb;
    }
    .row p { margin: 2px 0 0; font-size: 11px; color: #4b5563; }
    .offer-link {
      display: inline-flex;
      margin-top: 6px;
      font-size: 11px;
      font-weight: 700;
      color: #1d4ed8;
      text-decoration: none;
    }
    .offer-link:hover { text-decoration: underline; }
    .seller-flag {
      width: 14px;
      height: 10px;
      border-radius: 2px;
      margin-left: 6px;
      vertical-align: middle;
      border: 1px solid #d1d5db;
      object-fit: cover;
    }
    .seller-country-code {
      margin-left: 6px;
      font-size: 9px;
      font-weight: 800;
      color: #6b7280;
      border: 1px solid #d1d5db;
      border-radius: 999px;
      padding: 0 4px;
      vertical-align: middle;
    }
    .seller-trust {
      margin-left: 6px;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      font-size: 8px;
      font-weight: 800;
      border: 1px solid #d1d5db;
      border-radius: 999px;
      padding: 0 4px;
      height: 14px;
      line-height: 1;
      background: #f8fafc;
      color: #475569;
      vertical-align: middle;
      white-space: nowrap;
    }
    .seller-trust mat-icon {
      width: 9px;
      height: 9px;
      font-size: 9px;
    }
    .seller-trust.tone-excellent {
      border-color: #86efac;
      background: #f0fdf4;
      color: #166534;
    }
    .seller-trust.tone-good {
      border-color: #bbf7d0;
      background: #f7fef9;
      color: #15803d;
    }
    .seller-trust.tone-neutral {
      border-color: #cbd5e1;
      background: #f8fafc;
      color: #475569;
    }
    .seller-trust.tone-warning {
      border-color: #fed7aa;
      background: #fff7ed;
      color: #9a3412;
    }
    .amounts { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; font-size: 12px; font-weight: 700; }
    .shipping { font-size: 10px; color: #6b7280; font-weight: 600; }
    .shipping.missing { color: #9a3412; }
    .empty { display: flex; align-items: center; gap: 8px; color: #9ca3af; padding: 12px; }
    @media (max-width: 720px) {
      .rank-head { grid-template-columns: auto 1fr; }
      .meta { grid-column: 1 / -1; align-items: flex-start; flex-direction: row; }
      .row { grid-template-columns: 1fr; }
      .amounts { align-items: flex-start; }
    }
  `],
})
export class CartMixRankingDialogComponent {
  private readonly data = inject<{
    options: CartOfferSummary[];
    partsCount: number;
  }>(MAT_DIALOG_DATA);

  protected readonly allOptions = this.data.options || [];
  protected readonly options = this.allOptions.slice(0, 5);
  protected readonly totalOptions = this.allOptions.length;
  protected readonly partsCount = this.data.partsCount || 0;

  protected optionIndex(index: number, option: CartOfferSummary): string {
    const sellerPart = option.sellerId || `mix-${option.sellersCount}`;
    return `${sellerPart}-${index}`;
  }

  protected formatMoney(value?: number | null, currency = 'PLN'): string {
    const safeValue = Number.isFinite(Number(value)) ? Number(value) : 0;
    return `${safeValue.toFixed(2)} ${currency}`;
  }

  protected getDeltaToBest(option: CartOfferSummary): number {
    const best = this.options[0];
    if (!best) return 0;
    return option.estimatedGrandTotal - best.estimatedGrandTotal;
  }

  protected getSellerTrust(selection: any):
    | { icon: string; label: string; tooltip: string; tone: 'excellent' | 'good' | 'neutral' | 'warning' }
    | null {
    if (!selection) return null;
    const provider = String(selection?.provider || '').toLowerCase();
    if (provider === 'allegro' && Boolean(selection?.sellerIsSuperSeller)) {
      return { icon: 'verified', label: 'SS', tooltip: 'Allegro Super Seller', tone: 'excellent' };
    }
    if (Boolean(selection?.sellerIsTopRated)) {
      return { icon: 'workspace_premium', label: 'TR', tooltip: 'Top Rated seller', tone: 'excellent' };
    }
    const feedbackPercent = Number.parseFloat(
      String(selection?.sellerFeedbackPercent ?? 'NaN').replace(',', '.'),
    );
    if (!Number.isFinite(feedbackPercent)) return null;

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
}
