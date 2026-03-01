import { Route } from '@angular/router';

export const appRoutes: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'parts', // Domyślne przekierowanie na listę zestawów
  },
  {
    path: 'parts/cart',
    loadComponent: () =>
      import('@lego-tracker/sets/feature-sets').then(
        (m) => m.PartOffersPageComponent,
      ),
  },
  {
    path: 'parts',
    loadComponent: () =>
      import('@lego-tracker/sets/feature-sets').then((m) => m.PartsComponent),
  },
  // Tu w przyszłości dodasz szczegóły konkretnego zestawu:
  // {
  //   path: 'sets/:id',
  //   loadComponent: () => import('@lego-tracker/sets/feature-details').then(m => m.DetailsComponent)
  // }
];
