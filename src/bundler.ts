/**
 * bundler.ts — Dev-Mode On-Demand Bundler
 *
 * Handles the three internal JS routes served only in `nuke dev`:
 *
 *   /__react.js                — Full React + ReactDOM browser bundle.
 *                                All hooks, jsx-runtime, hydrateRoot, createRoot.
 *                                Served once and cached by the browser.
 *
 *   /__n.js                    — NukeJS client runtime (bundle.ts compiled to ESM).
 *                                Provides initRuntime and SPA navigation.
 *
 *   /__client-component/<id>   — Client component bundles, served from a shared
 *                                split build so dependencies like shadcn / radix-ui
 *                                are only bundled once.
 *
 *   /__client-component/__chunks/<hash>  — Shared chunk files extracted by esbuild
 *                                          code splitting. Served automatically
 *                                          from the same split output directory.
 *
 * Code splitting (dev mode):
 *   Instead of building each component in isolation (which duplicates every shared
 *   dependency), all known components are built together in a single esbuild pass
 *   with `splitting: true`.  esbuild extracts any module imported by 2+ entry
 *   points into a shared chunk file.  When the browser loads Button.js and
 *   Dialog.js, they both import from the same __chunks/ABCDEF.js — one fetch,
 *   one cache entry.
 *
 *   The split build is triggered lazily on the first component request (by which
 *   time SSR has already run and populated the component cache).  It is
 *   invalidated and rebuilt whenever a source file changes (via HMR) or when a
 *   component is requested that is not yet in the output (new page visited).
 *
 * In production (`nuke build`), equivalent bundles are written to dist/static/
 * by build-common.ts instead of being served dynamically.
 */

import path from 'path';
import fs   from 'fs';
import os   from 'os';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import type { ServerResponse } from 'http';
import { log } from './logger';
import { getComponentCache } from './component-analyzer';

// ─── Bundle caches ────────────────────────────────────────────────────────────

// Cache Promises (not just results) so concurrent requests share one build
// instead of each spawning their own esbuild process.
let reactBundlePromise: Promise<string> | null = null;
let nukeBundlePromise:  Promise<string> | null = null;

// ─── Split build state ────────────────────────────────────────────────────────

/**
 * Temporary output directory for the dev-mode split build.
 * Lives in the OS temp dir so it is cleaned up on reboot and never
 * committed to version control.
 */
const SPLIT_OUT_DIR = path.join(os.tmpdir(), 'nukejs-dev-components');

/** True when the split build is current and its output can be served. */
let splitBuildValid = false;

/**
 * In-flight split build promise. Shared across concurrent requests so only
 * one esbuild process runs at a time even when multiple components are
 * requested simultaneously on first load.
 */
let splitBuildPromise: Promise<void> | null = null;

// ─── Split build ──────────────────────────────────────────────────────────────

/**
 * Runs a single esbuild pass over all currently known client components with
 * `splitting: true`. esbuild extracts shared modules (radix-ui, clsx, etc.)
 * into __chunks/ files that are fetched once and reused by every component.
 *
 * Called lazily — only after SSR has populated the component cache so all
 * components for the current page are known.
 */
async function buildAllComponentsSplit(): Promise<void> {
  // Collect every client component currently in the cache.
  const cache = getComponentCache();
  const clientComponents = new Map<string, string>(); // id → filePath
  for (const [filePath, info] of cache) {
    if (info.isClientComponent && info.clientComponentId) {
      clientComponents.set(info.clientComponentId, filePath);
    }
  }

  if (clientComponents.size === 0) {
    splitBuildValid = true;
    return;
  }

  const entryPoints: Record<string, string> = {};
  for (const [id, filePath] of clientComponents) {
    entryPoints[id] = filePath;
  }

  fs.mkdirSync(SPLIT_OUT_DIR, { recursive: true });

  log.verbose(`[bundler] Split build: ${clientComponents.size} component(s) → ${SPLIT_OUT_DIR}`);

  await build({
    entryPoints,
    bundle:      true,
    splitting:   true,              // ← shared deps extracted into chunks
    format:      'esm',             // splitting requires ESM
    platform:    'browser',
    jsx:         'automatic',
    minify:      false,             // keep readable in dev
    write:       true,              // splitting requires write:true + outdir
    outdir:      SPLIT_OUT_DIR,
    conditions:  ['module', 'browser', 'import'],
    // Shim require() for CJS packages that call require('react') at runtime.
    banner:      { js: 'const require=(m)=>{if(m===\'react\')return window.__nukejs_react__;if(m===\'react/jsx-runtime\')return window.__nukejs_jsx__;throw new Error(\'Dynamic require of "\'+m+\'" is not supported\');};' },
    external:    ['react', 'react-dom/client', 'react/jsx-runtime'],
    define:      { 'process.env.NODE_ENV': '"development"' },
    entryNames:  '[name]',          // cc_abc123.js (stable, no hash)
    chunkNames:  '__chunks/[hash]', // __chunks/ABCDEF.js
  });

  splitBuildValid = true;
  log.verbose('[bundler] Split build complete');
}

/**
 * Ensures a valid split build exists, kicking one off if needed.
 * Concurrent callers share a single in-flight build promise.
 */
async function ensureSplitBuild(): Promise<void> {
  if (splitBuildValid) return;
  if (!splitBuildPromise) {
    splitBuildPromise = buildAllComponentsSplit().finally(() => {
      splitBuildPromise = null;
    });
  }
  await splitBuildPromise;
}

/**
 * Marks the split build as stale so the next request triggers a rebuild.
 * Called by hmr.ts whenever a source file changes.
 */
export function invalidateSplitBundle(): void {
  splitBuildValid = false;
  log.verbose('[bundler] Split bundle invalidated');
}

// ─── Client component bundle ──────────────────────────────────────────────────

/**
 * Serves a client component bundle (or a shared chunk) from the split build
 * output directory.
 *
 * `componentId` can be either:
 *   'cc_abc123'          → entry file: SPLIT_OUT_DIR/cc_abc123.js
 *   '__chunks/ABCDEF'    → chunk file: SPLIT_OUT_DIR/__chunks/ABCDEF.js
 *
 * If the requested file is missing after a valid build (e.g. a new page was
 * visited and its components were not in the previous build), the build is
 * invalidated and retried once before returning 404.
 */
export async function serveClientComponentBundle(
  componentId: string,
  res: ServerResponse,
): Promise<void> {
  // Ensure we have a current split build.
  await ensureSplitBuild();

  const outPath = path.join(SPLIT_OUT_DIR, `${componentId}.js`);

  // If the file is missing, it may be a newly discovered component (e.g. the
  // user navigated to a page we hadn't seen before). Invalidate and rebuild.
  if (!fs.existsSync(outPath)) {
    log.verbose(`[bundler] ${componentId} not in split build — rebuilding`);
    invalidateSplitBundle();
    await ensureSplitBuild();

    if (!fs.existsSync(outPath)) {
      log.error(`Client component not found: ${componentId}`);
      res.statusCode = 404;
      res.end('Client component not found');
      return;
    }
  }

  res.setHeader('Content-Type', 'application/javascript');
  res.end(fs.readFileSync(outPath));
}

// ─── React bundle ─────────────────────────────────────────────────────────────

/**
 * Builds and serves the unified React browser bundle to /__react.js.
 *
 * Exports every public React API so client components can import from 'react'
 * or 'react-dom/client' and have them resolve via the importmap to this single
 * pre-loaded bundle — no duplicate copies of React in the browser.
 *
 * esbuild aliases point at the project's installed React version so the bundle
 * always matches what the server is actually running.
 */
export async function serveReactBundle(res: ServerResponse): Promise<void> {
  log.verbose('Bundling React runtime');

  if (!reactBundlePromise) {
    reactBundlePromise = build({
      stdin: {
        contents: `
        import React, {
          createElement, cloneElement, createRef, isValidElement, Children,
          useState, useEffect, useContext, useReducer, useCallback, useMemo,
          useRef, useImperativeHandle, useLayoutEffect, useDebugValue,
          useDeferredValue, useTransition, useId, useSyncExternalStore,
          useInsertionEffect, createContext, forwardRef, memo, lazy,
          Suspense, Fragment, StrictMode, Component, PureComponent,
          createPortal
        } from 'react';
        import { jsx, jsxs } from 'react/jsx-runtime';
        import { hydrateRoot, createRoot } from 'react-dom/client';

        export {
          createElement, cloneElement, createRef, isValidElement, Children,
          useState, useEffect, useContext, useReducer, useCallback, useMemo,
          useRef, useImperativeHandle, useLayoutEffect, useDebugValue,
          useDeferredValue, useTransition, useId, useSyncExternalStore,
          useInsertionEffect, createContext, forwardRef, memo, lazy,
          Suspense, Fragment, StrictMode, Component, PureComponent,
          hydrateRoot, createRoot, jsx, jsxs
        };
        export default React;
        // Expose React on window so CJS packages that call require('react')
        // at runtime can resolve it via the __nukejs_require__ shim.
        window.__nukejs_react__ = React;
        window.__nukejs_jsx__   = { jsx, jsxs };
      `,
        loader: 'ts',
      },
      bundle:      true,
      write:       false,
      treeShaking: true,
      minify:      false,
      format:      'esm',
      jsx:         'automatic',
      alias: {
        react:       path.dirname(fileURLToPath(import.meta.resolve('react/package.json'))),
        'react-dom': path.dirname(fileURLToPath(import.meta.resolve('react-dom/package.json'))),
      },
      define: { 'process.env.NODE_ENV': '"development"' },
    }).then(r => r.outputFiles[0].text);
  }

  res.setHeader('Content-Type', 'application/javascript');
  res.end(await reactBundlePromise);
}

// ─── NukeJS runtime bundle ────────────────────────────────────────────────────

/**
 * Bundles and serves the NukeJS client runtime to /__n.js.
 *
 * The entry point is bundle.ts (or bundle.js in production dist/).
 * React is kept external so it resolves via the importmap to /__react.js.
 *
 * Minified because this script is loaded on every page request.
 */
export async function serveNukeBundle(res: ServerResponse): Promise<void> {
  log.verbose('Bundling NukeJS runtime');

  if (!nukeBundlePromise) {
    const dir   = path.dirname(fileURLToPath(import.meta.url));
    const entry = path.join(dir, `bundle.${dir.endsWith('dist') ? 'js' : 'ts'}`);
    nukeBundlePromise = build({
      entryPoints: [entry],
      write:       false,
      format:      'esm',
      minify:      true,
      bundle:      true,
      external:    ['react', 'react-dom/client', 'react/jsx-runtime'],
    }).then(r => r.outputFiles[0].text);
  }

  res.setHeader('Content-Type', 'application/javascript');
  res.end(await nukeBundlePromise);
}