/**
 * build-vercel.ts — Vercel Production Build
 *
 * Produces a .vercel/output/ directory conforming to the Vercel Build Output
 * API v3.  Two serverless functions are emitted:
 *
 *   api.func/   ← single dispatcher bundling all API route handlers
 *   pages.func/ ← single dispatcher bundling all SSR page handlers
 *
 * Static assets (React runtime, client components, public files) go to
 * .vercel/output/static/ and are served by Vercel's CDN directly.
 *
 * Notes on bundling strategy:
 *   - npm packages are FULLY BUNDLED (no node_modules at Vercel runtime).
 *   - Node built-ins are kept external (available in the nodejs20.x runtime).
 *   - A createRequire banner lets CJS packages (mongoose, etc.) resolve Node
 *     built-ins correctly inside the ESM output bundle.
 */

import fs   from 'fs';
import path from 'path';
import { randomBytes } from 'node:crypto';
import { build }       from 'esbuild';

import { loadConfig } from './config';
import {
  walkFiles,
  analyzeFile,
  collectServerPages,
  collectGlobalClientRegistry,
  bundleClientComponents,
  findPageLayouts,
  buildPerPageRegistry,
  makePageAdapterSource,
  buildCombinedBundle,
  copyPublicFiles,
} from './build-common';

// ─── Output directories ───────────────────────────────────────────────────────

const OUTPUT_DIR    = path.resolve('.vercel/output');
const FUNCTIONS_DIR = path.join(OUTPUT_DIR, 'functions');
const STATIC_DIR    = path.join(OUTPUT_DIR, 'static');

// Clean the entire .vercel/output/ folder before building so stale function
// bundles, removed routes, and renamed pages don't linger in the output.
if (fs.existsSync(OUTPUT_DIR)) {
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  console.log('🗑️  Cleaned .vercel/output/');
}

for (const dir of [FUNCTIONS_DIR, STATIC_DIR])
  fs.mkdirSync(dir, { recursive: true });

// ─── Config ───────────────────────────────────────────────────────────────────

const config     = await loadConfig();
const SERVER_DIR = path.resolve(config.serverDir);
const PAGES_DIR  = path.resolve('./app/pages');
const PUBLIC_DIR = path.resolve('./app/public');

// ─── Shared esbuild config ────────────────────────────────────────────────────

/**
 * Node built-ins that should never be bundled.
 * npm packages are intentionally absent — they must be bundled because
 * Vercel serverless functions have no node_modules at runtime.
 */
const NODE_BUILTINS = [
  'node:*',
  'http', 'https', 'fs', 'path', 'url', 'crypto', 'stream', 'buffer',
  'events', 'util', 'os', 'net', 'tls', 'child_process', 'worker_threads',
  'cluster', 'dgram', 'dns', 'readline', 'zlib', 'assert', 'module',
  'perf_hooks', 'string_decoder', 'timers', 'async_hooks', 'v8', 'vm',
];

/**
 * Banner injected at the top of every Vercel function bundle.
 *
 * Why it's needed: esbuild bundles CJS packages (mongoose, etc.) into ESM
 * output and replaces their require() calls with a __require2 shim.  That
 * shim cannot resolve Node built-ins on its own inside an ESM module scope.
 * Injecting a real require (backed by createRequire) fixes the shim so that
 * dynamic require('crypto'), require('stream'), etc. work correctly.
 */
const CJS_COMPAT_BANNER = {
  js: `import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);`,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

type VercelRoute = { src: string; dest: string } | { handle: 'filesystem' };

/** Writes a bundled dispatcher into a Vercel .func directory. */
function emitVercelFunction(name: string, bundleText: string): void {
  const funcDir = path.join(FUNCTIONS_DIR, `${name}.func`);
  fs.mkdirSync(funcDir, { recursive: true });
  fs.writeFileSync(path.join(funcDir, 'index.mjs'), bundleText);
  fs.writeFileSync(
    path.join(funcDir, '.vc-config.json'),
    JSON.stringify({ runtime: 'nodejs20.x', handler: 'index.mjs', launcherType: 'Nodejs' }, null, 2),
  );
}

// ─── API dispatcher source ────────────────────────────────────────────────────

/**
 * Generates a single TypeScript dispatcher that imports every API route module,
 * matches the incoming URL against each route's regex, injects captured params,
 * and calls the right HTTP-method export (GET, POST, …) or default export.
 */
function makeApiDispatcherSource(
  routes: Array<{ absPath: string; srcRegex: string; paramNames: string[] }>,
): string {
  const imports = routes
    .map((r, i) => `import * as __api_${i}__ from ${JSON.stringify(r.absPath)};`)
    .join('\n');

  const routeEntries = routes
    .map((r, i) =>
      `  { regex: ${JSON.stringify(r.srcRegex)}, params: ${JSON.stringify(r.paramNames)}, mod: __api_${i}__ },`,
    )
    .join('\n');

  return `\
import type { IncomingMessage, ServerResponse } from 'http';
${imports}

function enhance(res: ServerResponse) {
  (res as any).json = function(data: any, status = 200) {
    this.statusCode = status;
    this.setHeader('Content-Type', 'application/json');
    this.end(JSON.stringify(data));
  };
  (res as any).status = function(code: number) { this.statusCode = code; return this; };
  return res;
}

async function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: any) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(
          body && req.headers['content-type']?.includes('application/json')
            ? JSON.parse(body)
            : body,
        );
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const ROUTES = [
${routeEntries}
];

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const url      = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;

  for (const route of ROUTES) {
    const m = pathname.match(new RegExp(route.regex));
    if (!m) continue;

    const method = (req.method || 'GET').toUpperCase();
    const apiRes = enhance(res);
    const apiReq = req as any;

    apiReq.body   = await parseBody(req);
    apiReq.query  = Object.fromEntries(url.searchParams);
    apiReq.params = {};
    route.params.forEach((name: string, i: number) => { apiReq.params[name] = m[i + 1]; });

    const fn = (route.mod as any)[method] ?? (route.mod as any)['default'];
    if (typeof fn !== 'function') {
      (apiRes as any).json({ error: \`Method \${method} not allowed\` }, 405);
      return;
    }
    await fn(apiReq, apiRes);
    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Not Found' }));
}
`;
}

// ─── Pages dispatcher source ──────────────────────────────────────────────────

/**
 * Generates a TypeScript dispatcher that imports each page's pre-generated
 * adapter, matches the incoming URL, encodes captured dynamic params as
 * query-string values (catch-all params use repeated keys), then delegates
 * to the matching handler.
 */
function makePagesDispatcherSource(
  routes: Array<{
    adapterPath:   string;
    srcRegex:      string;
    paramNames:    string[];
    catchAllNames: string[];
  }>,
): string {
  const imports = routes
    .map((r, i) => `import __page_${i}__ from ${JSON.stringify(r.adapterPath)};`)
    .join('\n');

  const routeEntries = routes
    .map((r, i) =>
      `  { regex: ${JSON.stringify(r.srcRegex)}, params: ${JSON.stringify(r.paramNames)}, catchAll: ${JSON.stringify(r.catchAllNames)}, handler: __page_${i}__ },`,
    )
    .join('\n');

  return `\
import type { IncomingMessage, ServerResponse } from 'http';
${imports}

const ROUTES: Array<{
  regex:    string;
  params:   string[];
  catchAll: string[];
  handler:  (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}> = [
${routeEntries}
];

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const url      = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;

  for (const route of ROUTES) {
    const m = pathname.match(new RegExp(route.regex));
    if (!m) continue;

    const catchAllSet = new Set(route.catchAll);
    route.params.forEach((name, i) => {
      const raw = m[i + 1] ?? '';
      if (catchAllSet.has(name)) {
        // Encode catch-all as repeated keys so the handler can getAll() → string[]
        raw.split('/').filter(Boolean).forEach(seg => url.searchParams.append(name, seg));
      } else {
        url.searchParams.set(name, raw);
      }
    });
    req.url = pathname + (url.search || '');

    return route.handler(req, res);
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Not Found');
}
`;
}

// ─── Build API function ───────────────────────────────────────────────────────

const vercelRoutes: VercelRoute[] = [];

const apiFiles = walkFiles(SERVER_DIR);
if (apiFiles.length === 0) console.warn(`⚠  No server files found in ${SERVER_DIR}`);

const apiRoutes = apiFiles
  .map(relPath => ({ ...analyzeFile(relPath, 'api'), absPath: path.join(SERVER_DIR, relPath) }))
  .sort((a, b) => b.specificity - a.specificity);

if (apiRoutes.length > 0) {
  const dispatcherPath = path.join(SERVER_DIR, `_api_dispatcher_${randomBytes(4).toString('hex')}.ts`);
  fs.writeFileSync(dispatcherPath, makeApiDispatcherSource(apiRoutes));

  try {
    const result = await build({
      entryPoints: [dispatcherPath],
      bundle:      true,
      format:      'esm',
      platform:    'node',
      target:      'node20',
      banner:      CJS_COMPAT_BANNER,
      external:    NODE_BUILTINS,
      write:       false,
    });
    emitVercelFunction('api', result.outputFiles[0].text);
    console.log(`  built     API dispatcher → api.func  (${apiRoutes.length} route(s))`);
  } finally {
    fs.unlinkSync(dispatcherPath);
  }

  // API routes are listed before pages in config.json so they win on any
  // URL collision.  Static files in .vercel/output/static/ (app/public +
  // framework bundles) are served by Vercel's CDN before any route is checked.
  for (const { srcRegex } of apiRoutes)
    vercelRoutes.push({ src: srcRegex, dest: '/api' });
}

// ─── Build Pages function ─────────────────────────────────────────────────────

const serverPages = collectServerPages(PAGES_DIR);

if (serverPages.length > 0) {
  // Pass 1 — bundle all client components to static files.
  const globalRegistry  = collectGlobalClientRegistry(serverPages, PAGES_DIR);
  const prerenderedHtml = await bundleClientComponents(globalRegistry, PAGES_DIR, STATIC_DIR);
  const prerenderedRecord = Object.fromEntries(prerenderedHtml);

  // Pass 2 — write one temp adapter per page next to its source file (so
  //           relative imports resolve correctly), then bundle everything in
  //           one esbuild pass via the dispatcher.
  const tempAdapterPaths: string[] = [];

  for (const page of serverPages) {
    const adapterDir  = path.dirname(page.absPath);
    const adapterPath = path.join(adapterDir, `_page_adapter_${randomBytes(4).toString('hex')}.ts`);

    const layoutPaths = findPageLayouts(page.absPath, PAGES_DIR);
    const { registry, clientComponentNames } = buildPerPageRegistry(page.absPath, layoutPaths, PAGES_DIR);

    const layoutImports = layoutPaths
      .map((lp, i) => {
        const rel = path.relative(adapterDir, lp).replace(/\\/g, '/');
        return `import __layout_${i}__ from ${JSON.stringify(rel.startsWith('.') ? rel : './' + rel)};`;
      })
      .join('\n');

    fs.writeFileSync(
      adapterPath,
      makePageAdapterSource({
        pageImport:           JSON.stringify('./' + path.basename(page.absPath)),
        layoutImports,
        clientComponentNames,
        allClientIds:         [...registry.keys()],
        layoutArrayItems:     layoutPaths.map((_, i) => `__layout_${i}__`).join(', '),
        prerenderedHtml:      prerenderedRecord,
        catchAllNames:        page.catchAllNames,
      }),
    );

    tempAdapterPaths.push(adapterPath);
    console.log(`  prepared  ${path.relative(PAGES_DIR, page.absPath)}  →  ${page.funcPath}  [page]`);
  }

  const dispatcherRoutes = serverPages.map((page, i) => ({
    adapterPath:   tempAdapterPaths[i],
    srcRegex:      page.srcRegex,
    paramNames:    page.paramNames,
    catchAllNames: page.catchAllNames,
  }));

  const dispatcherPath = path.join(PAGES_DIR, `_pages_dispatcher_${randomBytes(4).toString('hex')}.ts`);
  fs.writeFileSync(dispatcherPath, makePagesDispatcherSource(dispatcherRoutes));

  try {
    const result = await build({
      entryPoints: [dispatcherPath],
      bundle:      true,
      format:      'esm',
      platform:    'node',
      target:      'node20',
      jsx:         'automatic',
      banner:      CJS_COMPAT_BANNER,
      external:    NODE_BUILTINS,
      define:      { 'process.env.NODE_ENV': '"production"' },
      write:       false,
    });
    emitVercelFunction('pages', result.outputFiles[0].text);
    console.log(`  built     Pages dispatcher → pages.func  (${serverPages.length} page(s))`);
  } finally {
    fs.unlinkSync(dispatcherPath);
    for (const p of tempAdapterPaths) if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  for (const { srcRegex } of serverPages)
    vercelRoutes.push({ src: srcRegex, dest: '/pages' });
}

// ─── Vercel config ────────────────────────────────────────────────────────────

// `{ handle: 'filesystem' }` instructs Vercel's routing layer to check
// .vercel/output/static/ BEFORE evaluating any of our dynamic route rules.
// Without this, an optional catch-all like [[page]].tsx would intercept
// /__n.js, /__react.js, and app/public/* before the CDN can serve them.
fs.writeFileSync(
  path.join(OUTPUT_DIR, 'config.json'),
  JSON.stringify({ version: 3, routes: [{ handle: 'filesystem' }, ...vercelRoutes] }, null, 2),
);
fs.writeFileSync(
  path.resolve('vercel.json'),
  JSON.stringify({ runtime: 'nodejs20.x' }, null, 2),
);

// ─── Static assets ────────────────────────────────────────────────────────────

await buildCombinedBundle(STATIC_DIR);
copyPublicFiles(PUBLIC_DIR, STATIC_DIR);

const fnCount = (apiRoutes.length > 0 ? 1 : 0) + (serverPages.length > 0 ? 1 : 0);
console.log(`\n✓ Vercel build complete — ${fnCount} function(s) → .vercel/output`);