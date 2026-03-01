import { Component, input } from '@angular/core';

@Component({
  selector: 'brickomat-brand-logo',
  standalone: true,
  templateUrl: './brand-logo.component.html',
  styleUrl: './brand-logo.component.scss',
})
export class BrandLogoComponent {
  readonly name = input('brickomat.pl');
  readonly tagline = input('lepiej, szybciej, taniej..');
}
