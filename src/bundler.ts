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
 *   /__client-component/<id>   — Individual "use client" component bundles.
 *                                Built on-demand the first time they're requested.
 *                                Re-built on every request in dev (no disk cache).
 *
 * In production (`nuke build`), equivalent bundles are written to dist/static/
 * by build-common.ts instead of being served dynamically.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import type { ServerResponse } from 'http';
import { log } from './logger';
import { getComponentById } from './component-analyzer';

// ─── Client component bundle ──────────────────────────────────────────────────

/**
 * Bundles a single "use client" file for the browser.
 *
 * React and react-dom/client are kept external so the importmap can resolve
 * them to the already-loaded /__react.js bundle (avoids shipping React twice).
 *
 * @param filePath  Absolute path to the source file.
 * @returns         ESM string ready to serve as application/javascript.
 */
export async function bundleClientComponent(filePath: string): Promise<string> {
  const result = await build({
    entryPoints: [filePath],
    bundle:      true,
    format:      'esm',
    platform:    'browser',
    write:       false,
    jsx:         'automatic',
    // Keep React external — resolved by the importmap to /__react.js
    external:    ['react', 'react-dom/client', 'react/jsx-runtime'],
  });
  return result.outputFiles[0].text;
}

/**
 * Looks up a client component by its content-hash ID (e.g. `cc_a1b2c3d4`),
 * bundles it on-demand, and writes the result to the HTTP response.
 *
 * The ID→path mapping comes from the component analyzer cache, which is
 * populated during SSR as pages and their layouts are rendered.
 */
export async function serveClientComponentBundle(
  componentId: string,
  res: ServerResponse,
): Promise<void> {
  const filePath = getComponentById(componentId);
  if (filePath) {
    log.verbose(`Bundling client component: ${componentId} (${path.basename(filePath)})`);
    res.setHeader('Content-Type', 'application/javascript');
    res.end(await bundleClientComponent(filePath));
    return;
  }

  // ID not found — either the page hasn't been visited yet (cache is empty)
  // or the ID is stale.
  log.error(`Client component not found: ${componentId}`);
  res.statusCode = 404;
  res.end('Client component not found');
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

  const result = await build({
    stdin: {
      // Re-export every public hook and ReactDOM entrypoint so client code can
      // import from 'react' or 'react-dom/client' and get the same object.
      contents: `
        import React, {
          useState, useEffect, useContext, useReducer, useCallback, useMemo,
          useRef, useImperativeHandle, useLayoutEffect, useDebugValue,
          useDeferredValue, useTransition, useId, useSyncExternalStore,
          useInsertionEffect, createContext, forwardRef, memo, lazy,
          Suspense, Fragment, StrictMode, Component, PureComponent
        } from 'react';
        import { jsx, jsxs } from 'react/jsx-runtime';
        import { hydrateRoot, createRoot } from 'react-dom/client';

        export {
          useState, useEffect, useContext, useReducer, useCallback, useMemo,
          useRef, useImperativeHandle, useLayoutEffect, useDebugValue,
          useDeferredValue, useTransition, useId, useSyncExternalStore,
          useInsertionEffect, createContext, forwardRef, memo, lazy,
          Suspense, Fragment, StrictMode, Component, PureComponent,
          hydrateRoot, createRoot, jsx, jsxs
        };
        export default React;
      `,
      loader: 'ts',
    },
    bundle:      true,
    write:       false,
    treeShaking: true,
    minify:      false,
    format:      'esm',
    jsx:         'automatic',
    // Resolve 'react' and 'react-dom' to the project's installed copies,
    // not to whatever esbuild would find relative to its own location.
    alias: {
      react:       path.dirname(fileURLToPath(import.meta.resolve('react/package.json'))),
      'react-dom': path.dirname(fileURLToPath(import.meta.resolve('react-dom/package.json'))),
    },
    define: { 'process.env.NODE_ENV': '"development"' },
  });

  res.setHeader('Content-Type', 'application/javascript');
  res.end(result.outputFiles[0].text);
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
  log.verbose('Bundling nuke runtime');

  const dir    = path.dirname(fileURLToPath(import.meta.url));
  // In the compiled dist/ directory the file is .js; in dev source it is .ts.
  const entry  = path.join(dir, `bundle.${dir.endsWith('dist') ? 'js' : 'ts'}`);

  const result = await build({
    entryPoints: [entry],
    write:       false,
    format:      'esm',
    minify:      true,
    bundle:      true,
    external:    ['react', 'react-dom/client'],
  });

  res.setHeader('Content-Type', 'application/javascript');
  res.end(result.outputFiles[0].text);
}