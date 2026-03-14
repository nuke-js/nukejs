/**
 * use-request.ts — useRequest() Hook
 *
 * Universal hook that exposes the current request's URL parameters, query
 * string, and headers to any React component — server or client, dev or prod.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │  Environment    │  Data source                                            │
 * ├─────────────────┼─────────────────────────────────────────────────────────┤
 * │  SSR (server)   │  request-store, populated by ssr.ts before rendering   │
 * │  Client         │  __n_data JSON blob + window.location (reactive)        │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * The hook stays reactive on the client: it listens to 'locationchange' events
 * fired by NukeJS's SPA router so values update on soft navigation without a
 * full page reload.
 *
 * --- Usage ---
 *
 * Basic:
 * ```tsx
 * // Works in server components (SSR) and client components ("use client")
 * const { params, query, headers, pathname } = useRequest();
 * const slug    = params.slug as string;
 * const lang    = query.lang as string;
 * const locale  = headers['accept-language'];
 * ```
 *
 * Building useI18n on top:
 * ```tsx
 * // hooks/useI18n.ts
 * import { useRequest } from 'nukejs';
 *
 * const translations = {
 *   en: { welcome: 'Welcome' },
 *   fr: { welcome: 'Bienvenue' },
 * } as const;
 * type Locale = keyof typeof translations;
 *
 * function parseLocale(header = ''): Locale {
 *   const tag = header.split(',')[0]?.split('-')[0]?.trim().toLowerCase();
 *   return (tag in translations ? tag : 'en') as Locale;
 * }
 *
 * export function useI18n() {
 *   const { query, headers } = useRequest();
 *   // ?lang=fr wins over Accept-Language header
 *   const locale = ((query.lang as string) ?? parseLocale(headers['accept-language'])) as Locale;
 *   return { t: translations[locale] ?? translations.en, locale };
 * }
 *
 * // Page.tsx
 * const { t } = useI18n();
 * return <h1>{t.welcome}</h1>;
 * ```
 *
 * --- Notes ---
 * - `headers` on the client never contains `cookie`, `authorization`, or
 *   `proxy-authorization` — these are stripped by the SSR pipeline before
 *   embedding in __n_data. See request-store.ts for the full exclusion list.
 * - In a "use client" component, `params` always reflects the __n_data blob
 *   written at the time of the most recent SSR/navigation.  For the freshest
 *   pathname use `useRouter().path` instead.
 */

import { useState, useEffect } from 'react';
import { getRequestStore } from './request-store';
import type { RequestContext } from './request-store';

export type { RequestContext };

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Fallback context used when data is unavailable. */
const EMPTY_CTX: RequestContext = {
  url: '',
  pathname: '',
  params: {},
  query: {},
  headers: {},
};

/**
 * Reads the current request context from the `__n_data` script tag embedded
 * by the SSR renderer, merged with `window.location` for live accuracy.
 *
 * Called on initial render and on every 'locationchange' event so the hook
 * stays fresh across SPA navigation.
 */
function readClientContext(): RequestContext {
  try {
    // __n_data is a JSON blob with { url, params, query, headers, … }.
    const raw = document.getElementById('__n_data')?.textContent ?? '{}';
    const data = JSON.parse(raw) as Partial<RequestContext & { params: Record<string, any> }>;

    // Always re-parse the query string from the live URL so navigation
    // to ?lang=fr is reflected immediately without waiting for a new SSR.
    const search = window.location.search;
    const query: Record<string, string | string[]> = {};
    if (search) {
      const sp = new URLSearchParams(search);
      sp.forEach((_, k) => {
        const all = sp.getAll(k);
        query[k] = all.length > 1 ? all : all[0];
      });
    }

    return {
      url: window.location.pathname + window.location.search,
      pathname: window.location.pathname,
      params: data.params ?? {},
      query,
      headers: data.headers ?? {},
    };
  } catch {
    return EMPTY_CTX;
  }
}

// ─── Universal hook ───────────────────────────────────────────────────────────

/**
 * Returns the current request context: URL params, query string, and headers.
 *
 * Automatically detects SSR vs browser and returns the correct data for
 * each environment.  On the client it is reactive — values update on SPA
 * navigation without a page reload.
 */
export function useRequest(): RequestContext {
  // ── Server path (SSR) ─────────────────────────────────────────────────────
  // typeof document === 'undefined' is the standard SSR guard in NukeJS
  // (mirrors the pattern used in use-html.ts and use-router.ts).
  if (typeof document === 'undefined') {
    return getRequestStore() ?? EMPTY_CTX;
  }

  // ── Client path (browser) ─────────────────────────────────────────────────
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const [ctx, setCtx] = useState<RequestContext>(readClientContext);

  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    // 'locationchange' is fired by NukeJS's history patch (setupLocationChangeMonitor)
    // on every pushState / replaceState / popstate so this handler covers both
    // Link-driven navigation and programmatic useRouter().push() calls.
    const handleLocationChange = () => setCtx(readClientContext());

    window.addEventListener('locationchange', handleLocationChange);
    return () => window.removeEventListener('locationchange', handleLocationChange);
  }, []);

  return ctx;
}