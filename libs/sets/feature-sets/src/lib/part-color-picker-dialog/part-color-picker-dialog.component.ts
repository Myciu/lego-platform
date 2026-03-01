import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { PartColorOption } from '@lego-tracker/sets/data-access';
import { asCssColor } from '@lego-tracker/shared/ui';

interface PartColorPickerDialogData {
  partName: string;
  colors: PartColorOption[];
  selectedColorId: number | null;
}

@Component({
  selector: 'lib-part-color-picker-dialog',
  standalone: true,
  imports: [CommonModule, MatDialogModule, MatButtonModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>Wybierz kolor</h2>
    <mat-dialog-content>
      <p class="part-name">{{ data.partName }}</p>

      @if (data.colors.length > 0) {
        <div class="color-grid">
          @for (color of data.colors; track color.color_id) {
            <button
              type="button"
              class="color-option"
              [class.active]="isSelected(color.color_id)"
              (click)="selectColor(color.color_id)"
            >
              <span
                class="swatch"
                [style.background-color]="asCssColor(color.color_rgb)"
                [class.translucent]="color.is_trans"
              ></span>
              <span class="label">{{ color.color_name }}</span>
              @if (isSelected(color.color_id)) {
                <mat-icon>check</mat-icon>
              }
            </button>
          }
        </div>
      } @else {
        <p class="empty">Brak dostępnych kolorów dla tego elementu.</p>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Anuluj</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .part-name {
      margin: 0 0 12px;
      font-size: 12px;
      color: #6b7280;
    }

    .color-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
      gap: 8px;
      max-height: min(58vh, 460px);
      overflow: auto;
      padding-right: 2px;
    }

    .color-option {
      border: 1px solid #d6dae2;
      border-radius: 10px;
      background: #fff;
      min-height: 36px;
      padding: 6px 8px;
      display: grid;
      grid-template-columns: 16px minmax(0, 1fr) 16px;
      align-items: center;
      gap: 8px;
      text-align: left;
      cursor: pointer;
      transition: border-color .14s ease, background .14s ease;
    }

    .color-option:hover {
      border-color: #bec5d2;
    }

    .color-option.active {
      border-color: #c81f20;
      background: #fff7f6;
    }

    .swatch {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      border: 1px solid rgba(0, 0, 0, 0.2);
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.16);
      display: inline-block;
    }

    .swatch.translucent {
      background-image: repeating-linear-gradient(
        -45deg,
        rgba(255, 255, 255, 0.48),
        rgba(255, 255, 255, 0.48) 2px,
        rgba(0, 0, 0, 0.06) 2px,
        rgba(0, 0, 0, 0.06) 4px
      );
    }

    .label {
      font-size: 12px;
      font-weight: 700;
      color: #1f2937;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    mat-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
      color: #b91c1c;
    }

    .empty {
      margin: 0;
      color: #6b7280;
      font-size: 13px;
    }
  `],
})
export class PartColorPickerDialogComponent {
  protected readonly data = inject<PartColorPickerDialogData>(MAT_DIALOG_DATA);
  private readonly dialogRef =
    inject<MatDialogRef<PartColorPickerDialogComponent>>(MatDialogRef);
  protected readonly asCssColor = asCssColor;

  protected isSelected(colorId: number): boolean {
    return this.data.selectedColorId === colorId;
  }

  protected selectColor(colorId: number): void {
    this.dialogRef.close(colorId);
  }
}
