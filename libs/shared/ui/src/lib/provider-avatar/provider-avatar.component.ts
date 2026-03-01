import { Component, Input, signal } from '@angular/core';
import {
  buildProviderAvatarText,
  buildProviderLogoUrl,
} from '../provider-brand.util';

@Component({
  selector: 'offer-provider-avatar',
  standalone: true,
  templateUrl: './provider-avatar.component.html',
  styleUrl: './provider-avatar.component.scss',
})
export class ProviderAvatarComponent {
  private readonly broken = signal(false);
  private normalizedSourceId = '';

  @Input() label: string | null | undefined = '';
  @Input() size = 16;

  @Input()
  set sourceId(value: string | null | undefined) {
    this.normalizedSourceId = String(value || '').trim().toLowerCase();
    this.broken.set(false);
  }

  get sourceId(): string {
    return this.normalizedSourceId;
  }

  get imageSize(): number {
    return Math.max(10, this.size - 4);
  }

  get fallbackFontSize(): number {
    return Math.max(8, Math.floor(this.size * 0.56));
  }

  get logoUrl(): string {
    return buildProviderLogoUrl(this.normalizedSourceId);
  }

  get fallbackText(): string {
    return buildProviderAvatarText(this.label, this.normalizedSourceId);
  }

  get isBroken(): boolean {
    return this.broken();
  }

  onImageError(): void {
    this.broken.set(true);
  }
}
