import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const serverDistFolder = dirname(fileURLToPath(import.meta.url));
const browserDistFolder = resolve(serverDistFolder, '../browser');
const defaultStagingApiTarget = 'https://api-staging-6148.up.railway.app';
const fallbackStagingHosts = new Set([
  'web-staging-19b6.up.railway.app',
  'dev.brickomat.pl',
]);

const app = express();
const angularApp = new AngularNodeAppEngine();
const configuredApiProxyTarget = String(process.env['API_PROXY_TARGET'] || '')
  .trim()
  .replace(/\/+$/, '');

function resolveApiProxyTarget(req: express.Request): string {
  if (configuredApiProxyTarget) {
    return configuredApiProxyTarget;
  }

  const hostHeader = String(req.headers.host || '')
    .trim()
    .toLowerCase()
    .split(':')[0];

  if (fallbackStagingHosts.has(hostHeader)) {
    return defaultStagingApiTarget;
  }

  return '';
}

/**
 * Reverse proxy for API calls when frontend and backend run on separate services.
 * Set API_PROXY_TARGET, e.g. https://api-staging-xxxx.up.railway.app
 */
app.use('/api/**', async (req, res, next) => {
  const apiProxyTarget = resolveApiProxyTarget(req);
  if (!apiProxyTarget) {
    return next();
  }

  try {
    const targetUrl = new URL(req.originalUrl, `${apiProxyTarget}/`).toString();
    const headers = new Headers();

    Object.entries(req.headers).forEach(([key, value]) => {
      if (!value) return;
      if (key.toLowerCase() === 'host') return;
      if (Array.isArray(value)) {
        value.forEach((entry) => headers.append(key, entry));
        return;
      }
      headers.set(key, value);
    });

    const requestInit: RequestInit & { duplex?: 'half' } = {
      method: req.method,
      headers,
      redirect: 'manual',
    };

    if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) {
      requestInit.body = req as any;
      requestInit.duplex = 'half';
    }

    const response = await fetch(targetUrl, requestInit);
    res.status(response.status);

    response.headers.forEach((value, key) => {
      const normalized = key.toLowerCase();
      if (['connection', 'keep-alive', 'transfer-encoding'].includes(normalized)) {
        return;
      }
      res.setHeader(key, value);
    });

    if (!response.body) {
      res.end();
      return;
    }

    Readable.fromWeb(response.body as any).pipe(res);
  } catch (error) {
    next(error);
  }
});

/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * Handle all other requests by rendering the Angular application.
 */
app.use('/**', (req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, () => {
    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);
