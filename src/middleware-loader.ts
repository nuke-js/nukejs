/**
 * middleware-loader.ts — Middleware Chain Manager
 *
 * Loads and runs the NukeJS middleware stack.  Two layers are supported:
 *
 *   1. Built-in middleware   — shipped with the nukejs package.
 *                              Currently handles the /__hmr and /__hmr.js
 *                              routes required by the HMR client.
 *                              Located next to this file as `middleware.ts`
 *                              (or `middleware.js` in the compiled dist/).
 *
 *   2. User middleware       — `middleware.ts` in the project root (cwd).
 *                              Runs after the built-in layer so it can inspect
 *                              or short-circuit every incoming request, including
 *                              API and page routes.
 *
 * Each middleware function receives (req, res) and may either:
 *   - End the response (res.end / res.json) to short-circuit further handling.
 *   - Return without touching res to pass control to the next layer.
 *
 * runMiddleware() returns `true` if any middleware ended the response,
 * allowing app.ts to skip its own routing logic.
 *
 * Restart behaviour:
 *   When nuke.config.ts or middleware.ts change in dev, app.ts restarts the
 *   process.  The new process calls loadMiddleware() fresh so stale module
 *   caches are not an issue.
 */

import path from 'path';
import fs from 'fs';
import { pathToFileURL, fileURLToPath } from 'url';
import type { IncomingMessage, ServerResponse } from 'http';
import { log } from './logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export type MiddlewareFunction = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void> | void;

// ─── Internal state ───────────────────────────────────────────────────────────

/** Ordered list of loaded middleware functions with their source paths. */
const middlewares: { fn: MiddlewareFunction; src: string }[] = [];

// ─── Loader helpers ───────────────────────────────────────────────────────────

/**
 * Attempts to import a middleware file and push its default export onto the
 * stack.  Skips silently if the file doesn't exist.  Logs a warning if the
 * file exists but doesn't export a default function.
 */
async function loadMiddlewareFromPath(middlewarePath: string): Promise<void> {
  if (!fs.existsSync(middlewarePath)) {
    log.verbose(`No middleware found at ${middlewarePath}, skipping`);
    return;
  }

  try {
    const mod = await import(pathToFileURL(middlewarePath).href);
    if (typeof mod.default === 'function') {
      middlewares.push({ fn: mod.default, src: middlewarePath });
      log.info(`Middleware loaded from ${middlewarePath}`);
    } else {
      log.warn(`${middlewarePath} does not export a default function`);
    }
  } catch (error) {
    log.error(`Error loading middleware from ${middlewarePath}:`, error);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Discovers and loads all middleware in priority order:
 *   1. Built-in (this package's own middleware.ts / middleware.js)
 *   2. User-supplied (cwd/middleware.ts)
 *
 * Duplicate paths (e.g. if cwd === package dir in a monorepo) are deduplicated
 * via a Set so the same file is never loaded twice.
 *
 * Should be called once at startup after the config is loaded.
 */
export async function loadMiddleware(): Promise<void> {
  // __dirname equivalent in ESM.
  const appDir = path.dirname(fileURLToPath(import.meta.url));

  // The built-in middleware handles /__hmr and /__hmr.js for the HMR client.
  const builtinPath = path.join(
    appDir,
    `middleware.${appDir.endsWith('dist') ? 'js' : 'ts'}`,
  );

  // In dev the user's file is .ts; after any build it's compiled to .js or
  // .mjs.  Try all variants and load the first one that exists so production
  // builds (where .ts no longer exists on disk) are handled correctly.
  const userCandidates = [
    path.join(process.cwd(), 'middleware.ts'),
    path.join(process.cwd(), 'middleware.js'),
    path.join(process.cwd(), 'middleware.mjs'),
  ];
  const userPath = userCandidates.find(p => fs.existsSync(p)) ?? userCandidates[0];

  // Deduplicate in case the two paths resolve to the same file.
  const paths = [...new Set([builtinPath, userPath])];

  for (const middlewarePath of paths) {
    await loadMiddlewareFromPath(middlewarePath);
  }
}

/**
 * Runs all loaded middleware in registration order.
 *
 * Stops and returns `true` as soon as any middleware ends or sends a response
 * (res.writableEnded or res.headersSent), allowing app.ts to skip routing.
 *
 * Returns `false` if no middleware handled the request.
 */
export async function runMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (middlewares.length === 0) return false;

  for (const { fn, src } of middlewares) {
    await fn(req, res);

    if (res.writableEnded || res.headersSent) {
      const method  = (req.method ?? 'GET').toUpperCase();
      const url     = req.url ?? '/';
      const status  = res.statusCode;
      const srcName = path.basename(src);
      log.verbose(`middleware  ${method} ${url}  ${status}  (${srcName})`);
      return true;
    }
  }

  return false;
}