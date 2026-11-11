import type { HelmetOptions } from 'helmet';

/**
 * Helmet configuration for the API, kept out of `main.ts` so it can be asserted in a unit test.
 *
 * This API answers with JSON and media bytes, never HTML. That lets the production policy be the
 * strictest one that exists: nothing may be loaded, framed, or submitted anywhere. Swagger UI is the
 * single HTML surface; it is mounted only outside production (or when `API_DOCS_ENABLED=true`), so
 * it gets a relaxed policy of its own rather than weakening the default for every response.
 *
 * Deliberate choices:
 *  - `crossOriginResourcePolicy: same-site` instead of helmet's `same-origin`: API responses are
 *    JSON/bytes, and a same-site <img>/<video> embed is a feature, not a leak — media routes are
 *    authorised by session cookie or signed key, not by origin.
 *  - HSTS only in production. It is ignored on http anyway, but sending it from a local dev server
 *    would make a browser pin `localhost` to https if it ever chose to honour it.
 *  - `frameguard: deny` tightens helmet's default `SAMEORIGIN`; CSP `frame-ancestors 'none'` covers
 *    modern browsers, the header covers the rest.
 */
export function buildHelmetOptions(isProduction: boolean): HelmetOptions {
  return {
    contentSecurityPolicy: isProduction
      ? {
          useDefaults: false,
          directives: {
            'default-src': ["'none'"],
            'frame-ancestors': ["'none'"],
            'base-uri': ["'none'"],
            'form-action': ["'none'"],
            sandbox: [],
          },
        }
      : false, // dev only: lets /api/docs (Swagger UI) render its own assets
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
  };
}
