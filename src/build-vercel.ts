import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { build } from 'esbuild';

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

const OUTPUT_DIR = path.resolve('.vercel/output');
const FUNCTIONS_DIR = path.join(OUTPUT_DIR, 'functions');
const STATIC_DIR = path.join(OUTPUT_DIR, 'static');

fs.mkdirSync(FUNCTIONS_DIR, { recursive: true });
fs.mkdirSync(STATIC_DIR, { recursive: true });

// ─── Config ───────────────────────────────────────────────────────────────────

const config = await loadConfig();
const SERVER_DIR = path.resolve(config.serverDir);
const PAGES_DIR = path.resolve('./app/pages');
const PUBLIC_DIR = path.resolve('./app/public');

// ─── Helpers ──────────────────────────────────────────────────────────────────

type VercelRoute = { src: string; dest: string };

/** Writes a bundled dispatcher into a Vercel .func directory. */
function emitVercelFunction(name: string, bundleText: string): void {
  const funcDir = path.join(FUNCTIONS_DIR, name + '.func');
  fs.mkdirSync(funcDir, { recursive: true });
  fs.writeFileSync(path.join(funcDir, 'index.mjs'), bundleText);
  fs.writeFileSync(
    path.join(funcDir, '.vc-config.json'),
    JSON.stringify({ runtime: 'nodejs20.x', handler: 'index.mjs', launcherType: 'Nodejs' }, null, 2),
  );
}

// ─── API dispatcher source ────────────────────────────────────────────────────

/**
 * Generates a single dispatcher that imports every API route module directly,
 * matches the incoming URL against each route's regex, injects captured params,
 * and calls the right HTTP-method export (GET, POST, …) or default export.
 *
 * enhance / parseBody helpers are included once rather than once per route.
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
 * Generates a dispatcher that imports each page's pre-generated adapter by its
 * temp file path, matches the incoming URL, injects captured dynamic params as
 * query-string values (page handlers read params from req.url searchParams),
 * then delegates to the matching handler.
 */
function makePagesDispatcherSource(
  routes: Array<{ adapterPath: string; srcRegex: string; paramNames: string[] }>,
): string {
  const imports = routes
    .map((r, i) => `import __page_${i}__ from ${JSON.stringify(r.adapterPath)};`)
    .join('\n');

  const routeEntries = routes
    .map((r, i) =>
      `  { regex: ${JSON.stringify(r.srcRegex)}, params: ${JSON.stringify(r.paramNames)}, handler: __page_${i}__ },`,
    )
    .join('\n');

  return `\
import type { IncomingMessage, ServerResponse } from 'http';
${imports}

const ROUTES: Array<{
  regex: string;
  params: string[];
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}> = [
${routeEntries}
];

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const url      = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;

  for (const route of ROUTES) {
    const m = pathname.match(new RegExp(route.regex));
    if (!m) continue;

    // Inject dynamic params as query-string values so page handlers can read
    // them via new URL(req.url).searchParams — the same way they always have.
    route.params.forEach((name, i) => url.searchParams.set(name, m[i + 1]));
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
  const dispatcherSource = makeApiDispatcherSource(apiRoutes);
  const dispatcherPath = path.join(SERVER_DIR, `_api_dispatcher_${crypto.randomBytes(4).toString('hex')}.ts`);
  fs.writeFileSync(dispatcherPath, dispatcherSource);

  try {
    const result = await build({
      entryPoints: [dispatcherPath],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      packages: 'external',
      write: false,
    });
    emitVercelFunction('api', result.outputFiles[0].text);
    console.log(`  built     API dispatcher → api.func  (${apiRoutes.length} route(s))`);
  } finally {
    fs.unlinkSync(dispatcherPath);
  }

  // API routes are listed first — they win on any URL collision with pages.
  for (const { srcRegex } of apiRoutes) {
    vercelRoutes.push({ src: srcRegex, dest: '/api' });
  }
}

// ─── Build Pages function ─────────────────────────────────────────────────────

const serverPages = collectServerPages(PAGES_DIR);

if (serverPages.length > 0) {
  // Pass 1 — bundle all client components to static files.
  const globalClientRegistry = collectGlobalClientRegistry(serverPages, PAGES_DIR);
  const prerenderedHtml = await bundleClientComponents(globalClientRegistry, PAGES_DIR, STATIC_DIR);
  const prerenderedHtmlRecord = Object.fromEntries(prerenderedHtml);

  // Pass 2 — write one temp adapter per page next to its source file (so
  //           relative imports inside the component resolve correctly), then
  //           bundle everything in one esbuild pass via the dispatcher.
  const tempAdapterPaths: string[] = [];

  for (const page of serverPages) {
    const { absPath } = page;
    const adapterDir = path.dirname(absPath);
    const adapterPath = path.join(adapterDir, `_page_adapter_${crypto.randomBytes(4).toString('hex')}.ts`);

    const layoutPaths = findPageLayouts(absPath, PAGES_DIR);
    const { registry, clientComponentNames } = buildPerPageRegistry(absPath, layoutPaths, PAGES_DIR);

    const layoutImports = layoutPaths
      .map((lp, i) => {
        const rel = path.relative(adapterDir, lp).replace(/\\/g, '/');
        return `import __layout_${i}__ from ${JSON.stringify(rel.startsWith('.') ? rel : './' + rel)};`;
      })
      .join('\n');

    fs.writeFileSync(
      adapterPath,
      makePageAdapterSource({
        pageImport: JSON.stringify('./' + path.basename(absPath)),
        layoutImports,
        clientComponentNames,
        allClientIds: [...registry.keys()],
        layoutArrayItems: layoutPaths.map((_, i) => `__layout_${i}__`).join(', '),
        prerenderedHtml: prerenderedHtmlRecord,
      }),
    );

    tempAdapterPaths.push(adapterPath);
    console.log(`  prepared  ${path.relative(PAGES_DIR, absPath)}  →  ${page.funcPath}  [page]`);
  }

  // Write the dispatcher and let esbuild bundle all adapters in one pass.
  const dispatcherRoutes = serverPages.map((page, i) => ({
    adapterPath: tempAdapterPaths[i],
    srcRegex: page.srcRegex,
    paramNames: page.paramNames,
  }));

  const dispatcherPath = path.join(PAGES_DIR, `_pages_dispatcher_${crypto.randomBytes(4).toString('hex')}.ts`);
  fs.writeFileSync(dispatcherPath, makePagesDispatcherSource(dispatcherRoutes));

  try {
    const result = await build({
      entryPoints: [dispatcherPath],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      jsx: 'automatic',
      external: [
        'node:*',
        'http', 'https', 'fs', 'path', 'url', 'crypto', 'stream', 'buffer',
        'events', 'util', 'os', 'net', 'tls', 'child_process', 'worker_threads',
        'cluster', 'dgram', 'dns', 'readline', 'zlib', 'assert', 'module',
        'perf_hooks', 'string_decoder', 'timers', 'async_hooks', 'v8', 'vm',
      ],
      define: { 'process.env.NODE_ENV': '"production"' },
      write: false,
    });
    emitVercelFunction('pages', result.outputFiles[0].text);
    console.log(`  built     Pages dispatcher → pages.func  (${serverPages.length} page(s))`);
  } finally {
    fs.unlinkSync(dispatcherPath);
    for (const p of tempAdapterPaths) if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  for (const { srcRegex } of serverPages) {
    vercelRoutes.push({ src: srcRegex, dest: '/pages' });
  }
}

// ─── Vercel config ────────────────────────────────────────────────────────────

fs.writeFileSync(
  path.join(OUTPUT_DIR, 'config.json'),
  JSON.stringify({ version: 3, routes: vercelRoutes }, null, 2),
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