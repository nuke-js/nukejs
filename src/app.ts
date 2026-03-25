/**
 * app.ts — NukeJS Dev Server Entry Point
 *
 * This is the runtime that powers `nuke dev`. It:
 *   1. Loads your nuke.config.ts (or uses sensible defaults)
 *   2. Discovers API route prefixes from your server directory
 *   3. Starts an HTTP server that handles:
 *        app/public/**          — static files (highest priority, via middleware)
 *        /__hmr_ping            — heartbeat for HMR reconnect polling
 *        /__react.js            — bundled React + ReactDOM (resolved via importmap)
 *        /__n.js                — NukeJS client runtime bundle
 *        /__client-component/*  — on-demand "use client" component bundles
 *        server/**              — API route handlers from serverDir
 *        /**                    — SSR pages from app/pages (lowest priority)
 *   4. Watches for file changes and broadcasts HMR events to connected browsers
 *
 * In production (ENVIRONMENT=production), HMR and all file watching are skipped.
 */

import http from 'http';
import path from 'path';
import { existsSync, watch } from 'fs';

import { ansi, c, log, setDebugLevel, getDebugLevel } from './logger';
import { loadConfig } from './config';
import { discoverApiPrefixes, matchApiPrefix, createApiHandler } from './http-server';
import { loadMiddleware, runMiddleware } from './middleware-loader';
import { serveReactBundle, serveNukeBundle, serveClientComponentBundle } from './bundler';
import { serverSideRender } from './ssr';
import { watchDir, broadcastRestart } from './hmr';

// ─── Environment ──────────────────────────────────────────────────────────────

const isDev   = process.env.ENVIRONMENT !== 'production';
const _startMs = Date.now();

// React must live on globalThis so dynamically-imported page modules can share
// the same React instance without each bundling their own copy.
if (isDev) {
  const React = await import('react');
  (global as any).React = React;
}

// ─── Config & paths ───────────────────────────────────────────────────────────

const config = await loadConfig();
setDebugLevel(config.debug ?? false);

const PAGES_DIR = path.resolve('./app/pages');
const SERVER_DIR = path.resolve(config.serverDir);
const PORT       = config.port;

log.info('Configuration loaded:');
log.info(`  - Pages directory: ${PAGES_DIR}`);
log.info(`  - Server directory: ${SERVER_DIR}`);
log.info(`  - Port: ${PORT}`);
log.info(`  - Debug level: ${String(getDebugLevel())}`);
log.info(`  - Dev mode: ${String(isDev)}`);

// ─── API route discovery ──────────────────────────────────────────────────────

// Start watching the app directory for HMR.
if (isDev) watchDir(path.resolve('./app'), 'App');

// apiPrefixes is a live, mutable array. In dev, we splice it in-place whenever
// the server directory changes so handlers always see the latest routes without
// a full restart.
const apiPrefixes    = discoverApiPrefixes(SERVER_DIR);
const handleApiRoute = createApiHandler({ apiPrefixes, port: PORT, isDev });

log.info(`API prefixes discovered: ${apiPrefixes.length === 0 ? 'none' : ''}`);
apiPrefixes.forEach(p => {
  log.info(`  - ${p.prefix || '/'} -> ${path.relative(process.cwd(), p.directory)}`);
});

// ─── Full-restart file watchers ───────────────────────────────────────────────

// Some changes can't be hot-patched: middleware exports change the request
// pipeline, and nuke.config.ts may change the port or serverDir.  On change we
// broadcast a 'restart' SSE event so browsers reconnect automatically, then
// exit with code 75 — the CLI watches for this to respawn the process.
if (isDev) {
  const RESTART_EXIT_CODE = 75;
  const restartFiles = [
    path.resolve('./middleware.ts'),
    path.resolve('./nuke.config.ts'),
  ];

  for (const filePath of restartFiles) {
    if (!existsSync(filePath)) continue;
    watch(filePath, async () => {
      log.info(`[Server] ${path.basename(filePath)} changed — restarting...`);
      await broadcastRestart();
      process.exit(RESTART_EXIT_CODE);
    });
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

// Loads built-in middleware (HMR SSE/JS endpoints) and the user-supplied
// middleware.ts from the project root (if it exists).
await loadMiddleware();

// ─── Request handler ──────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    // Middleware runs first.  If it calls res.end() the request is fully
    // handled and we bail out immediately.
    const middlewareHandled = await runMiddleware(req, res);
    if (middlewareHandled) return;

    const url = req.url || '/';

    // ── Internal NukeJS routes ──────────────────────────────────────────────
    // Framework files are checked before server routes so a user route can
    // never accidentally shadow /__n.js, /__react.js, etc.

    // Heartbeat polled by the HMR client to know when the server is back up.
    if (url === '/__hmr_ping') {
      res.setHeader('Content-Type', 'text/plain');
      res.end('ok');
      return;
    }

    // Unified React bundle (react + react-dom/client + react/jsx-runtime).
    // Resolved by the importmap injected into every SSR page, so client
    // components never bundle React themselves.
    if (url === '/__react.js')
      return await serveReactBundle(res);

    // NukeJS browser runtime: initRuntime, SPA navigation, partial hydration.
    if (url === '/__n.js')
      return await serveNukeBundle(res);

    // On-demand bundles for individual "use client" components.
    // Strip the prefix, the .js extension, and any query string (cache buster).
    if (url.startsWith('/__client-component/'))
      return await serveClientComponentBundle(
        url.slice(20).split('?')[0].replace('.js', ''),
        res,
      );

    // ── Server routes ───────────────────────────────────────────────────────
    // API routes from serverDir — checked after framework files, before pages.
    if (matchApiPrefix(url, apiPrefixes))
      return await handleApiRoute(url, req, res);

    // ── Page SSR ────────────────────────────────────────────────────────────
    // Nothing above matched — render a page from app/pages.
    return await serverSideRender(url, res, PAGES_DIR, isDev, req);

  } catch (error) {
    log.error('Server error:', error);
    res.statusCode = 500;
    res.end('Internal server error');
  }
});

// ─── Port binding ─────────────────────────────────────────────────────────────

/**
 * Tries to listen on `port`.  If the port is already in use (EADDRINUSE),
 * increments and tries the next port until one is free.
 *
 * Returns the port that was actually bound.
 */
function tryListen(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') resolve(tryListen(port + 1));
      else reject(err);
    });
    server.listen(port, () => resolve(port));
  });
}

// ─── Startup banner ───────────────────────────────────────────────────────────

/**
 * Prints a minimal, box-char-free startup banner to stdout.
 * Compatible with CMD, PowerShell, and all ANSI-capable terminals.
 */
function printStartupBanner(port: number, configuredPort: number, startMs: number): void {
  const url   = `http://localhost:${port}`;
  const level = getDebugLevel();
  const elapsed = Date.now() - startMs;
  const keyW  = 5; // width of widest key label

  /** Strips ANSI codes to measure visible length. */
  const visible = (s: string) => s.replace(/\x1b\[[\d;]*m/g, '').length;

  /** Prints one label/value row with aligned values. */
  const row = (key: string, val: string) => {
    const pad = ' '.repeat(Math.max(0, keyW - visible(key)));
    console.log(`  ${c('gray', key)}${pad}  ${val}`);
  };

  console.log('');
  console.log(`  ${c('orange', 'NukeJS', true)}  ${c('gray', `ready in ${elapsed}ms`)}`);
  console.log('');
  row('Local',
    port !== configuredPort
      ? `${c('cyan', url, true)}  ${c('yellow', `(${configuredPort} was in use)`)}`
      : c('cyan', url, true),
  );
  row('Debug',
    level === false ? c('gray',   'off')           :
    level === true  ? c('green',  'verbose')       :
                      c('yellow', String(level)));
  console.log('');
}

const actualPort = await tryListen(PORT);
printStartupBanner(actualPort, PORT, _startMs);