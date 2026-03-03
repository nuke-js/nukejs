/**
 * middleware.ts — Built-In NukeJS Middleware
 *
 * This is the internal middleware loaded before any user-defined middleware.
 * It handles three responsibilities:
 *
 *   1. Static public files  (app/public/**)
 *      Any file placed in app/public/ is served at its path relative to
 *      that directory.  E.g. app/public/favicon.ico → GET /favicon.ico.
 *      The correct Content-Type is set automatically.  Path traversal attempts
 *      are rejected with 400.
 *
 *   2. HMR client script    (/__hmr.js)
 *      Builds and serves hmr-bundle.ts on demand.  Injected into every dev
 *      page as <script type="module" src="/__hmr.js">.
 *
 *   3. HMR SSE stream       (/__hmr)
 *      Long-lived Server-Sent Events connection used by the browser to receive
 *      reload/replace/restart events when source files change.
 */

import { build } from 'esbuild';
import type { IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { hmrClients } from './hmr';
import { getMimeType } from './utils';

// Absolute path to the static public directory.
// Files here are served at their path relative to this directory.
const PUBLIC_DIR = path.resolve('./app/public');

export default async function middleware(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {

  // ── Static public files ─────────────────────────────────────────────────────
  // Checked first so /favicon.ico, /main.css, etc. are never accidentally
  // routed to the SSR or API layers.
  const rawUrl = req.url ?? '/';
  const pathname = rawUrl.split('?')[0]; // strip query string

  if (fs.existsSync(PUBLIC_DIR)) {
    // path.join handles the leading '/' in pathname naturally and normalises
    // any '..' segments, making it safe to use directly with a startsWith guard.
    // Using path.join (not path.resolve) ensures an absolute second argument
    // cannot silently escape PUBLIC_DIR the way path.resolve would allow.
    const candidate = path.join(PUBLIC_DIR, pathname);

    // Path traversal guard: the resolved path must be inside PUBLIC_DIR.
    // We normalise PUBLIC_DIR with a trailing separator so that a directory
    // whose name is a prefix of another cannot pass (e.g. /public2 vs /public).
    const publicBase = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : PUBLIC_DIR + path.sep;
    const safe = candidate.startsWith(publicBase) || candidate === PUBLIC_DIR;

    if (!safe) {
      res.statusCode = 400;
      res.end('Bad request');
      return;
    }

    // Serve the file if it exists at any depth inside PUBLIC_DIR.
    // Directories are intentionally skipped (no directory listings).
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const ext = path.extname(candidate);
      res.setHeader('Content-Type', getMimeType(ext));
      res.end(fs.readFileSync(candidate));
      return;
    }
  }

  // ── HMR client script ───────────────────────────────────────────────────────
  // Builds hmr-bundle.ts on demand so the browser always gets the latest version.
  if (rawUrl === '/__hmr.js') {
    const dir   = path.dirname(fileURLToPath(import.meta.url));
    // Resolve to .js in dist/ or .ts when running from source.
    const entry = path.join(dir, `hmr-bundle.${dir.endsWith('dist') ? 'js' : 'ts'}`);

    const result = await build({
      entryPoints: [entry],
      write:       false,
      format:      'esm',
      minify:      true,
      bundle:      true,
      // React is not used in the HMR client, but excluding it prevents esbuild
      // from inlining it if any transitive import references react.
      external:    ['react', 'react-dom/client', 'react/jsx-runtime'],
    });

    res.setHeader('Content-Type', 'application/javascript');
    res.end(result.outputFiles[0].text);
    return; // Prevent fall-through to the SSE block below.
  }

  // ── HMR SSE stream ──────────────────────────────────────────────────────────
  // Long-lived connection tracked in hmrClients so hmr.ts can broadcast events
  // to all connected browsers when a file changes.
  if (rawUrl === '/__hmr') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    // Send an immediate 'connected' event so the client knows the stream is live.
    res.write('data: {"type":"connected"}\n\n');

    hmrClients.add(res);
    req.on('close', () => hmrClients.delete(res));
    return;
  }
}