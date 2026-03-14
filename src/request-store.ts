/**
 * request-store.ts — Per-Request Server Context Store
 *
 * Provides a request-scoped store that server components can read via
 * `useRequest()` during SSR.  The store is populated by the SSR pipeline
 * before rendering and cleared in a `finally` block after — preventing any
 * cross-request contamination.
 *
 * Why globalThis?
 *   Node's module system may import this file multiple times when the page
 *   module and the nukejs package resolve to different copies (common in dev
 *   with tsx/tsImport).  Using a well-known Symbol on globalThis guarantees
 *   all copies share the same store instance, exactly like html-store.ts.
 *
 * Request isolation:
 *   runWithRequestStore() creates a fresh store before rendering and clears
 *   it in the `finally` block, so concurrent requests cannot bleed into each
 *   other even if rendering throws.
 *
 * Headers in __n_data:
 *   A safe subset of headers is embedded in the HTML `__n_data` blob so
 *   client components can read them after hydration.  Sensitive headers
 *   (cookie, authorization, proxy-authorization) are intentionally excluded
 *   from the client payload.  The server-side store always has ALL headers.
 */

// ─── Public types ─────────────────────────────────────────────────────────────

export interface RequestContext {
  /** Full URL with query string (e.g. '/blog/hello?lang=en'). */
  url: string;
  /** Pathname only, no query string (e.g. '/blog/hello'). */
  pathname: string;
  /**
   * Dynamic route segments matched by the file-system router.
   * e.g. for `/blog/[slug]` → `{ slug: 'hello' }`
   */
  params: Record<string, string | string[]>;
  /**
   * Query string parameters, parsed from the URL.
   * Multi-value params (e.g. `?tag=a&tag=b`) become arrays.
   * e.g. `{ lang: 'en', tag: ['a', 'b'] }`
   */
  query: Record<string, string | string[]>;
  /**
   * Incoming request headers.
   *
   * Server-side (SSR): all headers from IncomingMessage.headers.
   * Client-side: safe subset embedded in __n_data (cookie, authorization,
   *   proxy-authorization are stripped before serialisation).
   *
   * Multi-value headers are joined with ', '.
   */
  headers: Record<string, string>;
}

// ─── Headers that must never be serialised into the HTML document ─────────────

/**
 * These headers contain credentials or session tokens.  They must not appear
 * in the __n_data JSON blob because the HTML document may be cached by
 * intermediate proxies or logged by analytics tools.
 */
const SENSITIVE_HEADERS = new Set([
  'cookie',
  'authorization',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
]);

/**
 * Converts raw Node `IncomingMessage.headers` into a flat string map suitable
 * for embedding in __n_data.  Array values (multi-value headers) are joined
 * with a comma and space.  Sensitive headers are excluded.
 */
export function sanitiseHeaders(
  raw: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (SENSITIVE_HEADERS.has(k.toLowerCase())) continue;
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

// ─── GlobalThis storage ───────────────────────────────────────────────────────

/** Well-known Symbol shared across all copies of this module in the process. */
const KEY = Symbol.for('__nukejs_request_store__');

const getGlobal = (): RequestContext | null => (globalThis as any)[KEY] ?? null;
const setGlobal = (ctx: RequestContext | null): void => {
  (globalThis as any)[KEY] = ctx;
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Runs `fn` inside the context of the given request, then clears the store.
 *
 * Usage in the SSR pipeline:
 * ```ts
 * const store = await runWithRequestStore(ctx, async () => {
 *   appHtml = await renderElementToHtml(element, renderCtx);
 * });
 * ```
 */
export async function runWithRequestStore<T>(
  ctx: RequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  setGlobal(ctx);
  try {
    return await fn();
  } finally {
    // Always clear even on throw — prevents leakage into the next request.
    setGlobal(null);
  }
}

/**
 * Returns the current request context, or `null` when called outside of
 * an active `runWithRequestStore` scope (e.g. in the browser, in tests,
 * or in a client component).
 */
export function getRequestStore(): RequestContext | null {
  return getGlobal();
}