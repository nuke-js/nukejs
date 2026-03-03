/**
 * hmr.ts — Server-Side HMR (Hot Module Replacement) Engine
 *
 * Manages the set of connected SSE clients and broadcasts change payloads to
 * them when source files are modified.
 *
 * The HMR protocol uses three message types:
 *
 *   { type: 'reload',   url: '/path' }  — A page file changed.  The browser
 *                                          re-fetches and swaps that URL if it
 *                                          is currently active.
 *                                          url: '*' means CSS changed — only
 *                                          stylesheets are reloaded in-place.
 *
 *   { type: 'replace',  component: 'X' } — A non-page file changed (shared
 *                                          component, util, etc.).  The browser
 *                                          re-fetches the current page to pick
 *                                          up the new version.
 *
 *   { type: 'restart' }                 — The server is about to restart
 *                                          (middleware.ts or nuke.config.ts
 *                                          changed).  The client polls
 *                                          /__hmr_ping until it gets a 200.
 *
 * File change → payload mapping:
 *   pages/**          → reload  (URL derived from the file path)
 *   *.css / *.scss …  → reload  (url: '*' triggers stylesheet cache-bust)
 *   anything else     → replace (component name used for logging only)
 *
 * Debouncing:
 *   Editors often emit multiple fs events for a single save.  Changes are
 *   debounced per filename with a 100 ms window so each save produces exactly
 *   one broadcast.
 */

import { ServerResponse } from 'http';
import { existsSync, watch } from 'fs';
import path from 'path';
import { log } from './logger';
import { invalidateComponentCache } from './component-analyzer';

// ─── SSE client registry ──────────────────────────────────────────────────────

/**
 * All currently connected SSE clients (long-lived ServerResponse objects).
 * Exported so middleware.ts can register new connections.
 */
export const hmrClients = new Set<ServerResponse>();

// ─── Broadcast ────────────────────────────────────────────────────────────────

/**
 * Sends a JSON payload to every connected SSE client.
 * Clients that have disconnected are silently removed from the set.
 */
function broadcastHmr(payload: object): void {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of hmrClients) {
    try {
      client.write(data);
    } catch {
      // Write failed — client disconnected without closing cleanly.
      hmrClients.delete(client);
    }
  }
}

// ─── Payload builder ──────────────────────────────────────────────────────────

/**
 * Converts a relative filename (as emitted by fs.watch) to the URL the browser
 * should re-fetch.
 *
 * Input examples:
 *   'pages/index.tsx'         → '/'
 *   'pages/about/index.tsx'   → '/about'
 *   'pages/blog/[slug].tsx'   → '/blog/[slug]'  (dynamic segment preserved)
 */
function pageFileToUrl(filename: string): string {
  // Strip the leading 'pages/' prefix that watchDir was called with.
  const withoutPages = filename.slice('pages/'.length);
  const withoutExt   = withoutPages.replace(/\.(tsx|ts)$/, '');

  // 'index' and 'layout' at any level map to the directory URL.
  // e.g. 'users/layout' → '/users', 'layout' → '/', 'users/index' → '/users'
  const url = withoutExt === 'index' || withoutExt === 'layout'
    ? '/'
    : '/' + withoutExt
        .replace(/\/index$/, '')
        .replace(/\/layout$/, '')
        .replace(/\\/g, '/');

  return url;
}

/**
 * Determines the appropriate HMR message for a changed file.
 *
 * Routing logic:
 *   - Paths under pages/  → `reload` with the derived URL
 *   - CSS/Sass/Less files → `reload` with url='*' (stylesheet cache-bust)
 *   - Everything else     → `replace` with the component base name
 */
function buildPayload(filename: string): object {
  const normalized = filename.replace(/\\/g, '/');

  if (normalized.startsWith('pages/')) {
    const url = pageFileToUrl(normalized);
    return { type: 'reload', url };
  }

  const ext = path.extname(filename).toLowerCase();
  if (ext === '.css' || ext === '.scss' || ext === '.sass' || ext === '.less') {
    return { type: 'reload', url: '*' };
  }

  // Generic component/util change — browser re-renders the current page.
  const componentName = path.basename(filename, path.extname(filename));
  return { type: 'replace', component: componentName };
}

// ─── File watcher ─────────────────────────────────────────────────────────────

/** Per-filename debounce timers. */
const pending = new Map<string, NodeJS.Timeout>();

/**
 * Recursively watches `dir` and broadcasts an HMR message whenever a file
 * changes.  Changes are debounced per file with a 100 ms window.
 *
 * @param dir    Absolute path to watch.
 * @param label  Short label for log messages (e.g. 'App', 'Server').
 */
export function watchDir(dir: string, label: string): void {
  if (!existsSync(dir)) return;

  watch(dir, { recursive: true }, (_event, filename) => {
    if (!filename) return;

    // Debounce: cancel any pending timer for this file and restart it.
    if (pending.has(filename)) clearTimeout(pending.get(filename)!);

    const timeout = setTimeout(() => {
      const payload = buildPayload(filename);
      log.info(`[HMR] ${label} changed: ${filename}`, JSON.stringify(payload));

      // Evict this file from the component-analysis cache so the next SSR
      // render re-analyses it (catches "use client" or import graph changes).
      if (dir) invalidateComponentCache(path.resolve(dir, filename));

      broadcastHmr(payload);
      pending.delete(filename);
    }, 100);

    pending.set(filename, timeout);
  });
}

// ─── Restart broadcast ────────────────────────────────────────────────────────

/**
 * Sends a 'restart' message to all SSE clients, then waits 120 ms to give
 * them time to receive it before the process exits.
 *
 * Called by app.ts before `process.exit(75)` when a config file changes.
 */
export function broadcastRestart(): Promise<void> {
  broadcastHmr({ type: 'restart' });
  return new Promise<void>(resolve => setTimeout(resolve, 120));
}