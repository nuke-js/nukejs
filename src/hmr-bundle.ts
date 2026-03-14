/**
 * hmr-bundle.ts — HMR Client Script
 *
 * This file is compiled on-demand by middleware.ts and served to the browser
 * as /__hmr.js (injected into every dev-mode page as a module script).
 *
 * It opens an EventSource connection to /__hmr and reacts to three message
 * types from the server:
 *
 *   'reload'   — A page or stylesheet changed.
 *                  url === '*'                → reload stylesheets in-place (no flicker)
 *                  url === window.location.pathname → soft-navigate the current page
 *
 *   'replace'  — A component/utility changed.
 *                Re-navigate the current page so SSR picks up the new code.
 *
 *   'restart'  — The server is restarting (config or middleware changed).
 *                Close the SSE connection and poll /__hmr_ping until the
 *                server is back, then hard-reload the page.
 *
 * The same reconnect polling is used when the SSE connection drops unexpectedly
 * (e.g. the dev server crashed).
 */

import { log } from './logger';

// ─── Entry point ──────────────────────────────────────────────────────────────

/** Opens the SSE connection and starts listening for HMR events. */
export default function hmr(): void {
  const es = new EventSource('/__hmr');

  es.onopen = () => {
    log.info('[HMR] Connected');
  };

  es.onerror = () => {
    // Connection dropped without a restart message (e.g. crash or network
    // blip).  Close cleanly and poll until the server is back.
    es.close();
    waitForReconnect();
  };

  es.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === 'restart') {
        log.info('[HMR] Server restarting — waiting to reconnect...');
        es.close();
        waitForReconnect();
        return;
      }

      if (msg.type === 'reload') {
        if (msg.url === '*') {
          // CSS / global style change — bust stylesheet hrefs in-place.
          // This avoids a full page reload and its associated FOUC.
          reloadStylesheets();
          return;
        }
        // A specific page changed — only navigate if we're on that page.
        if (patternMatchesPathname(msg.url, window.location.pathname)) {
          log.info('[HMR] Page changed:', msg.url);
          navigate(window.location.pathname + window.location.search);
        }
        return;
      }

      if (msg.type === 'replace') {
        // A shared component or utility changed.  The current page might use
        // it, so we re-navigate to pick up the latest server render.
        log.info('[HMR] Component changed:', msg.component);
        navigate(window.location.pathname + window.location.search);
        return;
      }
    } catch (err) {
      log.error('[HMR] Message parse error:', err);
    }
  };
}

// ─── Soft navigation helper ───────────────────────────────────────────────────

/**
 * Triggers a soft (SPA-style) navigation via the locationchange event that
 * bundle.ts listens to.  Adds `hmr: true` in the detail so the navigation
 * handler appends `?__hmr=1`, which tells SSR to skip client-component
 * renderToString (faster HMR round-trips).
 */
function navigate(href: string): void {
  window.dispatchEvent(new CustomEvent('locationchange', { detail: { href, hmr: true } }));
}

// ─── Dynamic route pattern matching ──────────────────────────────────────────

/**
 * Returns true when `pathname` matches the route `pattern` emitted by the
 * server.  Patterns use the file-system conventions:
 *   [param]     → any single non-slash segment
 *   [...slug]   → one or more segments
 *   [[...slug]] → zero or more segments
 *   [[param]]   → zero or one segment
 *
 * Each segment is classified before any escaping so that bracket characters
 * in param names are never mistaken for regex metacharacters.
 */
function patternMatchesPathname(pattern: string, pathname: string): boolean {
  // Normalise trailing slashes so /a/ matches pattern /a and vice versa.
  const normPattern  = pattern.length  > 1 ? pattern.replace(/\/+$/, '')  : pattern;
  const normPathname = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const segments   = normPattern.replace(/^\//, '').split('/');
  const regexParts = segments.map(seg => {
    if (/^\[\[\.\.\..+\]\]$/.test(seg)) return '(?:\/.*)?' ;  // [[...x]] optional catch-all
    if (/^\[\.\.\./.test(seg))            return '(?:\/.+)' ;   // [...x]   required catch-all
    if (/^\[\[/.test(seg))                  return '(?:\/[^/]*)?' ;// [[x]]    optional single
    if (/^\[/.test(seg))                    return '\/[^/]+' ;     // [x]      required single
    return '\/' + seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); // static — escape metacharacters
  });
  return new RegExp('^' + regexParts.join('') + '$').test(normPathname);
}

// ─── Reconnect polling ────────────────────────────────────────────────────────

/**
 * Polls /__hmr_ping at `intervalMs` until the server responds with a 200
 * (meaning it's back up), then triggers a full page reload to pick up any
 * changes that happened during the downtime.
 *
 * Gives up after `maxAttempts` (default ~30 seconds at 3000 ms intervals).
 */
function waitForReconnect(intervalMs = 3000, maxAttempts = 10): void {
  let attempts = 0;

  const id = setInterval(async () => {
    attempts++;
    try {
      const res = await fetch('/__hmr_ping', { cache: 'no-store' });
      if (res.ok) {
        clearInterval(id);
        log.info('[HMR] Server back — reloading');
        window.location.reload();
      }
    } catch {
      // Server still down — keep polling silently.
    }

    if (attempts >= maxAttempts) {
      clearInterval(id);
      log.error('[HMR] Server did not come back after restart');
    }
  }, intervalMs);
}

// ─── Stylesheet cache-buster ──────────────────────────────────────────────────

/**
 * Appends a `?t=<timestamp>` query to every `<link rel="stylesheet">` href.
 * The browser treats the new URL as a different resource and re-fetches it,
 * updating styles without a page reload or visible flash.
 */
function reloadStylesheets(): void {
  const links = document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]');
  log.info(`[HMR] CSS changed — reloading ${links.length} stylesheet(s)`);
  links.forEach(link => {
    const url = new URL(link.href);
    url.searchParams.set('t', String(Date.now()));
    link.href = url.toString();
  });
}

// Auto-start when this module is loaded.
hmr();