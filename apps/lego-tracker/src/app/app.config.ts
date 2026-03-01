import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { appRoutes } from './app.routes';
import {
  provideClientHydration,
  withEventReplay,
} from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';

export const appConfig: ApplicationConfig = {
  providers: [
    //provideClientHydration(withEventReplay()),
    provideRouter(appRoutes, withComponentInputBinding()),
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(),
  ],
};
