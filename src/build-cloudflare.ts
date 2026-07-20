/**
 * build-cloudflare.ts — Cloudflare Workers / Pages Production Build
 *
 * Produces a .cloudflare/output/ directory compatible with both Cloudflare
 * Pages (recommended) and standalone Cloudflare Workers:
 *
 *   .cloudflare/output/
 *     _worker.mjs    ← Single ESM Cloudflare Worker (Fetch API handler)
 *     static/        ← Static assets served by the Cloudflare Pages CDN
 *
 * Also emits wrangler.toml at the project root for standalone Workers
 * deployments via `wrangler deploy`.
 *
 * ── Deployment models ──────────────────────────────────────────────────────
 *
 *   Cloudflare Pages (recommended):
 *     Place .cloudflare/output/ as your build output directory.
 *     Pages serves static/ via CDN automatically; _worker.mjs handles the
 *     rest.  The ASSETS binding lets the worker serve assets at runtime.
 *
 *   Standalone Workers:
 *     `wrangler deploy` uses the generated wrangler.toml.
 *     Static assets are inlined into the worker bundle as a virtual asset
 *     map.  Note: the 1 MB worker size limit (10 MB on paid plans) applies.
 *
 * ── Architecture notes ─────────────────────────────────────────────────────
 *
 *   • All API and page routes are bundled into ONE ESM worker file.
 *   • Node's IncomingMessage / ServerResponse are shimmed from Web Request /
 *     Response so existing handlers work without modification.
 *   • The body shim fires 'data'/'end' events from a pre-read ArrayBuffer,
 *     keeping stream-style handlers (req.on('data', …)) fully compatible.
 *   • npm packages are FULLY BUNDLED — no node_modules at runtime.
 *   • Node built-ins (fs, path, http, …) are NOT available in Workers.
 *     Handlers that import them will fail at bundle time.  Use Web APIs or
 *     CF-compatible npm packages instead.
 *   • process.env.NODE_ENV is statically replaced with "production".
 *     Access other env vars via the `env` binding (CF Workers convention).
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
  buildClientComponentTagImports,
  buildCombinedBundle,
  copyPublicFiles,
} from './build-common';

// ─── Output directories ───────────────────────────────────────────────────────

const OUTPUT_DIR = path.resolve('.cloudflare/output');
const STATIC_DIR = path.join(OUTPUT_DIR, 'static');

if (fs.existsSync(OUTPUT_DIR)) {
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  console.log('🗑️  Cleaned .cloudflare/output/');
}

fs.mkdirSync(STATIC_DIR, { recursive: true });

// ─── Config ───────────────────────────────────────────────────────────────────

const config     = await loadConfig();
const SERVER_DIR = path.resolve(config.serverDir);
const PAGES_DIR  = path.resolve('./app/pages');
const PUBLIC_DIR = path.resolve('./app/public');

// ─── esbuild shared config ────────────────────────────────────────────────────

/**
 * Cloudflare Workers run on V8 (workerd), not Node.js.
 * Only cloudflare:* internal modules and the optional asset-manifest binding
 * should be marked external.  Everything else (npm packages, etc.) must be
 * fully bundled.
 */
const CF_EXTERNALS = ['cloudflare:*', '__STATIC_CONTENT_MANIFEST'];

const CF_DEFINE: Record<string, string> = {
  'process.env.NODE_ENV': '"production"',
};

// ─── Node req/res shim ────────────────────────────────────────────────────────

/**
 * Minimal Node.js IncomingMessage / ServerResponse shim injected at the top
 * of every generated worker entry.
 *
 * IncomingMessage shim:
 *   - Exposes url, method, headers, body, query, params (standard NukeJS
 *     handler surface).
 *   - Simulates the Node stream interface (on('data', …) / on('end', …))
 *     using a pre-buffered ArrayBuffer so stream-style body readers work.
 *   - Attaches .json() / .text() / .buffer() convenience methods.
 *
 * ServerResponse shim:
 *   - Accumulates chunks written via write() / end() into a single body.
 *   - Exposes a toResponse() method that returns a Web Response once end()
 *     has been called.
 *   - Adds the .json() / .status() / .redirect() helpers that NukeJS
 *     dispatchers expect.
 */
const NODE_SHIM = /* js */`
// ─── Node req/res shim ────────────────────────────────────────────────────────

class __NodeRequest__ {
  constructor(cfRequest, parsedUrl, bodyBytes) {
    this.url     = parsedUrl.pathname + parsedUrl.search;
    this.method  = cfRequest.method;
    this.headers = Object.fromEntries(cfRequest.headers.entries());
    this.body    = null;   // populated externally before handler call
    this.query   = Object.fromEntries(parsedUrl.searchParams.entries());
    this.params  = {};
    // Pre-read body bytes for stream emulation
    this._bodyBytes   = bodyBytes;   // Uint8Array | null
    this._dataFns     = [];
    this._endFns      = [];
    this._errorFns    = [];
    this._streamQueued = false;
  }

  // Stream interface — 'data' / 'end' / 'error' — used by body-parsing
  // middleware and req.json() / req.text() from the API adapter template.
  on(event, fn) {
    if      (event === 'data')  this._dataFns.push(fn);
    else if (event === 'end')   this._endFns.push(fn);
    else if (event === 'error') this._errorFns.push(fn);

    // Schedule a single microtask flush the first time a listener is added.
    // All listeners registered synchronously in the same tick will be ready
    // by the time the microtask fires.
    if (!this._streamQueued) {
      this._streamQueued = true;
      Promise.resolve().then(() => {
        if (this._bodyBytes && this._bodyBytes.length > 0) {
          for (const fn of this._dataFns) fn(this._bodyBytes);
        }
        for (const fn of this._endFns) fn();
      });
    }
    return this;
  }

  off(event, fn) {
    if      (event === 'data')  this._dataFns  = this._dataFns.filter(f => f !== fn);
    else if (event === 'end')   this._endFns   = this._endFns.filter(f => f !== fn);
    else if (event === 'error') this._errorFns = this._errorFns.filter(f => f !== fn);
    return this;
  }

  destroy() {}
  resume()  { return this; }
  pause()   { return this; }
}

class __NodeResponse__ {
  constructor() {
    this.statusCode = 200;
    this._headers   = new Headers();
    this._chunks    = [];
    this._resolve   = null;
    this._promise   = new Promise(r => { this._resolve = r; });
    // Attach NukeJS dispatcher helpers directly on construction so handlers
    // receive them regardless of which dispatcher path is used.
    this.json = (data, status = 200) => {
      this.statusCode = status;
      this.setHeader('content-type', 'application/json; charset=utf-8');
      this.end(JSON.stringify(data));
    };
    this.status = (code) => { this.statusCode = code; return this; };
    this.redirect = (location, code = 302) => {
      this.statusCode = code;
      this.setHeader('location', String(location));
      this.end();
    };
  }

  setHeader(name, value)  { this._headers.set(String(name), String(value)); }
  getHeader(name)         { return this._headers.get(String(name)) ?? undefined; }
  removeHeader(name)      { this._headers.delete(String(name)); }
  hasHeader(name)         { return this._headers.has(String(name)); }

  write(chunk) {
    if (chunk == null) return;
    this._chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
  }

  end(chunk) {
    if (chunk != null)
      this._chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    this._resolve(
      new Response(this._chunks.join(''), {
        status:  this.statusCode,
        headers: this._headers,
      }),
    );
  }

  // Await this inside the fetch handler to get the completed Web Response.
  toResponse() { return this._promise; }
}
`;

// ─── API dispatcher (CF-flavoured) ───────────────────────────────────────────

/**
 * Generates a single TypeScript module that:
 *   - Imports every API route module directly.
 *   - Matches the incoming URL against each route's regex.
 *   - Attaches body, query, params, and streaming helpers to the shim req.
 *   - Calls the matching HTTP-method export or default export.
 *
 * The dispatcher intentionally mirrors the Vercel variant but replaces the
 * stream-based parseBody with a simple pre-populated body reference, since
 * the CF worker entry pre-buffers the request body before calling this.
 */
function makeApiDispatcherSource(
  routes: Array<{ absPath: string; srcRegex: string; paramNames: string[] }>,
  middlewarePath?: string,
): string {
  const middlewareImport = middlewarePath
    ? `import __userMiddleware__ from ${JSON.stringify(middlewarePath)};`
    : '';

  const middlewareRun = middlewarePath
    ? `
  // Run user middleware before routing.  If it ends the response, bail out.
  await __userMiddleware__(req, res);
  if ((res as any).writableEnded || (res as any).headersSent) return true;
`
    : '';

  const imports = routes
    .map((r, i) => `import * as __api_${i}__ from ${JSON.stringify(r.absPath)};`)
    .join('\n');

  const routeEntries = routes
    .map(
      (r, i) =>
        `  { regex: ${JSON.stringify(r.srcRegex)}, params: ${JSON.stringify(r.paramNames)}, mod: __api_${i}__ },`,
    )
    .join('\n');

  return /* ts */`\
import type { IncomingMessage, ServerResponse } from 'http';
${imports}
${middlewareImport}

const __CF_API_ROUTES__ = [
${routeEntries}
];

/**
 * Try to dispatch \`req\` to an API route.
 * Returns true if a route matched (even if the handler threw), false otherwise.
 */
export async function __dispatchApi__(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url      = new URL((req as any).url || '/', 'http://localhost');
  const pathname = url.pathname;
${middlewareRun}
  for (const route of __CF_API_ROUTES__) {
    const m = pathname.match(new RegExp(route.regex));
    if (!m) continue;

    const method  = ((req.method || 'GET')).toUpperCase();
    const apiReq  = req as any;
    const apiRes  = res as any;

    // Populate NukeJS API handler surface on the shim.
    apiReq.query  = Object.fromEntries(url.searchParams.entries());
    apiReq.params = {};
    route.params.forEach((name: string, i: number) => { apiReq.params[name] = m[i + 1]; });

    // Attach .json() / .text() / .buffer() that resolve from the pre-read body.
    const rawBytes: Uint8Array | null = apiReq._bodyBytes ?? null;
    apiReq.text   = () => Promise.resolve(rawBytes ? new TextDecoder().decode(rawBytes) : '');
    apiReq.json   = () => apiReq.text().then((t: string) => {
      const parsed = t ? JSON.parse(t) : null;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        delete parsed.__proto__;
        delete parsed.constructor;
      }
      return parsed;
    });
    apiReq.buffer = () => Promise.resolve(rawBytes ?? new Uint8Array(0));

    const fn = (route.mod as any)[method] ?? (route.mod as any)['default'];
    if (typeof fn !== 'function') {
      apiRes.json({ error: \`Method \${method} not allowed\` }, 405);
      return true;
    }
    await fn(apiReq, apiRes);
    return true;
  }
  return false;
}
`;
}

// ─── Pages dispatcher ─────────────────────────────────────────────────────────

/**
 * Mirrors the Vercel pages dispatcher but works with the CF worker's req/res
 * shims.  The handler signatures are identical so the same adapter sources
 * generated by makePageAdapterSource() can be reused without modification.
 */
function makePagesDispatcherSource(
  routes: Array<{
    adapterPath:   string;
    srcRegex:      string;
    paramNames:    string[];
    catchAllNames: string[];
  }>,
  errorAdapters: { adapter404?: string; adapter500?: string } = {},
  middlewarePath?: string,
): string {
  const middlewareImport = middlewarePath
    ? `import __userMiddleware__ from ${JSON.stringify(middlewarePath)};`
    : '';

  const middlewareRun = middlewarePath
    ? `
  // Run user middleware before routing.  If it ends the response, bail out.
  await __userMiddleware__(req, res);
  if ((res as any).writableEnded || (res as any).headersSent) return true;
`
    : '';

  const imports = routes
    .map((r, i) => `import __page_${i}__ from ${JSON.stringify(r.adapterPath)};`)
    .join('\n');

  const routeEntries = routes
    .map(
      (r, i) =>
        `  { regex: ${JSON.stringify(r.srcRegex)}, params: ${JSON.stringify(r.paramNames)}, catchAll: ${JSON.stringify(r.catchAllNames)}, handler: __page_${i}__ },`,
    )
    .join('\n');

  const error404Import = errorAdapters.adapter404
    ? `import __error_404__ from ${JSON.stringify(errorAdapters.adapter404)};`
    : '';
  const error500Import = errorAdapters.adapter500
    ? `import __error_500__ from ${JSON.stringify(errorAdapters.adapter500)};`
    : '';

  const notFoundFallback = errorAdapters.adapter404
    ? `  try { await __error_404__(req, res); return true; } catch(e) { console.error('[_404 error]', e); }`
    : `  (res as any).statusCode = 404;\n  res.setHeader('content-type', 'text/plain; charset=utf-8');\n  res.end('Not Found');`;

  const clientErrHandler = errorAdapters.adapter500
    ? /* ts */`    try {
      const eq = new URLSearchParams();
      eq.set('__errorMessage', url.searchParams.get('__clientError') || 'Client error');
      const stack = url.searchParams.get('__clientStack');
      if (stack) eq.set('__errorStack', stack);
      (req as any).url = '/_500?' + eq.toString();
      await __error_500__(req, res);
      return true;
    } catch(e) { console.error('[_500 client error]', e); }`
    : `    (res as any).statusCode = 500; res.end('Internal Server Error'); return true;`;

  const errHandler = errorAdapters.adapter500
    ? /* ts */`    try {
      const errMsg   = err instanceof Error ? err.message : String(err);
      const errStack = err instanceof Error ? err.stack   : undefined;
      const eq = new URLSearchParams();
      eq.set('__errorMessage', errMsg);
      if (errStack) eq.set('__errorStack', errStack);
      (req as any).url = '/_500?' + eq.toString();
      await __error_500__(req, res);
      return true;
    } catch(e) { console.error('[_500 error]', e); }`
    : `    (res as any).statusCode = 500; res.end('Internal Server Error'); return true;`;

  return /* ts */`\
import type { IncomingMessage, ServerResponse } from 'http';
${imports}
${error404Import}
${error500Import}
${middlewareImport}

const __CF_PAGE_ROUTES__: Array<{
  regex:    string;
  params:   string[];
  catchAll: string[];
  handler:  (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}> = [
${routeEntries}
];

/**
 * Try to dispatch \`req\` to a page route.
 * Returns true if a route matched (even if the handler threw), false otherwise.
 */
export async function __dispatchPages__(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url      = new URL((req as any).url || '/', 'http://localhost');
  const pathname = url.pathname;
${middlewareRun}
  // Client-side error — forward to _500 page if available.
  if (url.searchParams.has('__clientError')) {
${clientErrHandler}
  }

  for (const route of __CF_PAGE_ROUTES__) {
    const m = pathname.match(new RegExp(route.regex));
    if (!m) continue;

    const catchAllSet = new Set(route.catchAll);
    route.params.forEach((name, i) => {
      const raw = m[i + 1] ?? '';
      if (catchAllSet.has(name)) {
        raw.split('/').filter(Boolean).forEach(seg => url.searchParams.append(name, seg));
      } else {
        url.searchParams.set(name, raw);
      }
    });
    (req as any).url = pathname + (url.search || '');

    try {
      await route.handler(req, res);
      return true;
    } catch (err) {
      console.error('[page handler error]', err);
${errHandler}
      return true;
    }
  }

${notFoundFallback}
  return false;
}
`;
}

// ─── Worker entry ─────────────────────────────────────────────────────────────

/**
 * Generates the top-level Cloudflare Worker module.
 *
 * The entry:
 *   1. Inlines the Node req/res shim classes.
 *   2. Imports the API and/or pages dispatcher modules (bundled by esbuild).
 *   3. Pre-buffers the request body into a Uint8Array (stream compatibility).
 *   4. Checks the Cloudflare Pages ASSETS binding for static files first.
 *   5. Dispatches dynamic requests through the API then the pages pipeline.
 */
function makeWorkerEntrySource(hasApi: boolean, hasPages: boolean, inlineStaticMap: string, middlewarePath?: string): string {
  const apiImport   = hasApi
    ? `import { __dispatchApi__   } from './cf-api-dispatcher';`
    : '';
  const pagesImport = hasPages
    ? `import { __dispatchPages__ } from './cf-pages-dispatcher';`
    : '';

  const middlewareImport = middlewarePath
    ? `import __userMiddleware__ from ${JSON.stringify(middlewarePath)};`
    : '';

  // Runs once per request, before any routing.  Mutates nodeReq.url in place
  // (e.g. locale-prefix rewrites) so both dispatchers see the rewritten URL.
  // If middleware ends the response, return immediately.
  const middlewareRun = middlewarePath
    ? `
      await __userMiddleware__(nodeReq as any, nodeRes as any);
      if ((nodeRes as any).writableEnded || (nodeRes as any).headersSent) return nodeRes.toResponse();
`
    : '';

  const apiDispatch = hasApi
    ? `if (await __dispatchApi__(nodeReq as any, nodeRes as any))   return nodeRes.toResponse();`
    : '';
  const pagesDispatch = hasPages
    ? `if (await __dispatchPages__(nodeReq as any, nodeRes as any)) return nodeRes.toResponse();`
    : '';

  return /* ts */`\
${NODE_SHIM}

${apiImport}
${pagesImport}
${middlewareImport}

/**
 * Pre-buffer the request body into a Uint8Array so we can both:
 *   a) inject it into req.body (parsed), and
 *   b) expose a fake stream interface on the shim (on('data', …)).
 * Returns null for requests without bodies (GET, HEAD, OPTIONS).
 */
const __INLINE_STATIC_MAP__ = new Map<string, { ct: string; body: string; text: boolean }>([
${inlineStaticMap}
]);

async function readBodyBytes(request: Request): Promise<Uint8Array | null> {
  const noBody = ['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase());
  if (noBody) return null;
  try {
    const buf = await request.arrayBuffer();
    return buf.byteLength > 0 ? new Uint8Array(buf) : null;
  } catch {
    return null;
  }
}

/**
 * Attempt to parse the raw body bytes according to the Content-Type header.
 * Returns the parsed body (object, string, or null).
 */
function parseBodyBytes(bodyBytes: Uint8Array | null, contentType: string): unknown {
  if (!bodyBytes || bodyBytes.length === 0) return null;
  const text = new TextDecoder().decode(bodyBytes);
  try {
    if (contentType.includes('application/json')) {
      const parsed = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        delete (parsed as any).__proto__;
        delete (parsed as any).constructor;
      }
      return parsed;
    }
    if (contentType.includes('application/x-www-form-urlencoded')) {
      return Object.fromEntries(new URLSearchParams(text).entries());
    }
    return text;
  } catch {
    return text;
  }
}

export default {
  async fetch(request: Request, env: Record<string, any>, ctx: ExecutionContext): Promise<Response> {
    const parsedUrl = new URL(request.url);

    // ── 1. Static assets via Cloudflare Pages ASSETS binding ──────────────
    // When deployed with Cloudflare Pages, \`env.ASSETS\` is a fetcher that
    // serves files from the static/ output directory via the CDN.  We issue a
    // GET probe (no body) so we never accidentally consume the request body.
    if (env && env.ASSETS) {
      try {
        const probe       = new Request(request.url, { method: 'GET', headers: request.headers });
        const staticResp  = await (env.ASSETS as Fetcher).fetch(probe);
        if (staticResp.status !== 404) return staticResp;
      } catch (_) {
        // ASSETS binding unavailable or errored — fall through to inline map.
      }
    }

    // ── 1b. Inline static asset map (standalone Workers fallback) ──────
    // When deployed via wrangler deploy (not Cloudflare Pages), there is
    // no ASSETS binding.  Static files are inlined at build time into this map.
    {
      const __inlineAsset__ = __INLINE_STATIC_MAP__.get(parsedUrl.pathname);
      if (__inlineAsset__) {
        const body = __inlineAsset__.text
          ? __inlineAsset__.body
          : Uint8Array.from(atob(__inlineAsset__.body), c => c.charCodeAt(0));
        return new Response(body, {
          status: 200,
          headers: { 'content-type': __inlineAsset__.ct },
        });
      }
    }

    // ── 2. Pre-buffer the request body ────────────────────────────────────
    const bodyBytes   = await readBodyBytes(request);
    const contentType = request.headers.get('content-type') || '';
    const parsedBody  = parseBodyBytes(bodyBytes, contentType);

    // ── 3. Build Node-compatible req / res shims ───────────────────────────
    const nodeReq         = new ((__NodeRequest__ as any))(request, parsedUrl, bodyBytes);
    nodeReq.body          = parsedBody;
    const nodeRes         = new ((__NodeResponse__ as any))();

    try {
      // ── User middleware — runs once, before any routing ─────────────────
${middlewareRun}
      // ── 4. API routes ──────────────────────────────────────────────────
      ${apiDispatch}

      // ── 5. Page routes ─────────────────────────────────────────────────
      ${pagesDispatch}

      // ── 6. No route matched ────────────────────────────────────────────
      return new Response('Not Found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });

    } catch (err) {
      console.error('[worker unhandled error]', err);
      return new Response('Internal Server Error', {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  },
};
`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Writes a temp TypeScript source file and bundles it with esbuild for CF. */
async function bundleForWorker(
  entryPath: string,
  outPath:   string,
  extraDefine: Record<string, string> = {},
): Promise<void> {
  const result = await build({
    entryPoints:      [entryPath],
    bundle:           true,
    format:           'esm',
    platform:         'browser',
    target:           'es2022',
    external:         CF_EXTERNALS,
    define:           { ...CF_DEFINE, ...extraDefine },
    jsx:              'automatic',
    write:            false,
    resolveExtensions: ['.js', '.mjs', '.ts', '.tsx', '.jsx', '.json'],
    // Do NOT set `banner` — the Node shim is inline in the worker entry source.
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, result.outputFiles[0].text);
}

// ─── API routes ───────────────────────────────────────────────────────────────

const apiFiles = walkFiles(SERVER_DIR);
if (apiFiles.length === 0) console.warn(`⚠  No server files found in ${SERVER_DIR}`);

const apiRoutes = apiFiles
  .map(relPath => ({
    ...analyzeFile(relPath, 'api'),
    absPath: path.join(SERVER_DIR, relPath),
  }))
  .sort((a, b) => b.specificity - a.specificity);

// ─── Page routes ──────────────────────────────────────────────────────────────

const serverPages = collectServerPages(PAGES_DIR);

// ─── Build static assets ──────────────────────────────────────────────────────

await buildCombinedBundle(STATIC_DIR);
copyPublicFiles(PUBLIC_DIR, STATIC_DIR);

// ─── Inline static assets for standalone Workers deployment ──────────────────

/**
 * Read the built static directory and generate a Map<path, { body, ct }> that
 * can be embedded in the worker bundle for pure-Worker (non-Pages) deployments.
 * Files are base64-encoded; text files are stored as UTF-8 strings.
 */
const TEXT_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx',
  '.css', '.html', '.htm', '.json', '.xml', '.txt', '.csv', '.svg', '.map',
]);

const MIME_MAP: Record<string, string> = {
  '.html':  'text/html; charset=utf-8',
  '.htm':   'text/html; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.js':    'application/javascript; charset=utf-8',
  '.mjs':   'application/javascript; charset=utf-8',
  '.cjs':   'application/javascript; charset=utf-8',
  '.map':   'application/json; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
  '.xml':   'application/xml; charset=utf-8',
  '.txt':   'text/plain; charset=utf-8',
  '.csv':   'text/csv; charset=utf-8',
  '.svg':   'image/svg+xml',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.gif':   'image/gif',
  '.webp':  'image/webp',
  '.avif':  'image/avif',
  '.ico':   'image/x-icon',
  '.bmp':   'image/bmp',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.otf':   'font/otf',
  '.mp4':   'video/mp4',
  '.webm':  'video/webm',
  '.mp3':   'audio/mpeg',
  '.wav':   'audio/wav',
  '.ogg':   'audio/ogg',
  '.pdf':   'application/pdf',
  '.wasm':  'application/wasm',
};

function walkStaticDir(dir: string, base: string = dir): Array<{ rel: string; abs: string }> {
  const results: Array<{ rel: string; abs: string }> = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkStaticDir(abs, base));
    } else {
      results.push({ rel: '/' + path.relative(base, abs).replace(/\\/g, '/'), abs });
    }
  }
  return results;
}

// ─── Middleware ───────────────────────────────────────────────────────────────

// Resolve user middleware once; pass it to both dispatcher generators so it
// gets bundled into the single CF worker.
const cfUserMiddlewareSrc  = path.resolve('middleware.ts');
const cfMiddlewarePath     = fs.existsSync(cfUserMiddlewareSrc) ? cfUserMiddlewareSrc : undefined;
if (cfMiddlewarePath) console.log('  found     middleware.ts  (will be bundled into worker)');

// ─── Bundle API dispatcher ────────────────────────────────────────────────────

let hasApi   = false;
let hasPages = false;

if (apiRoutes.length > 0) {
  hasApi = true;
  const dispSrc  = makeApiDispatcherSource(apiRoutes);
  const dispPath = path.join(SERVER_DIR, `_cf_api_dispatcher_${randomBytes(4).toString('hex')}.ts`);
  fs.writeFileSync(dispPath, dispSrc);
  try {
    const outPath = path.join(OUTPUT_DIR, 'cf-api-dispatcher.js');
    await bundleForWorker(dispPath, outPath);
    console.log(`  built     API dispatcher → cf-api-dispatcher.js  (${apiRoutes.length} route(s))`);
  } finally {
    fs.unlinkSync(dispPath);
  }
}

// ─── Bundle pages dispatcher ──────────────────────────────────────────────────

const tempAdapterPaths: string[] = [];
const errorAdapterPaths: string[] = [];
const errorAdapters: { adapter404?: string; adapter500?: string } = {};

if (serverPages.length > 0 || ['_404.tsx', '_500.tsx'].some(f => fs.existsSync(path.join(PAGES_DIR, f)))) {
  hasPages = true;

  // Pass 1 — bundle all client components to static files.
  const globalRegistry   = collectGlobalClientRegistry(serverPages, PAGES_DIR);
  const prerenderedHtml  = await bundleClientComponents(globalRegistry, PAGES_DIR, STATIC_DIR);
  const prerenderedRecord = Object.fromEntries(prerenderedHtml);

  // Pass 2 — write per-page adapters and collect dispatcher routes.
  const dispatcherRoutes: Array<{
    adapterPath:   string;
    srcRegex:      string;
    paramNames:    string[];
    catchAllNames: string[];
  }> = [];

  for (const page of serverPages) {
    const adapterDir  = path.dirname(page.absPath);
    const adapterPath = path.join(
      adapterDir,
      `_cf_page_adapter_${randomBytes(4).toString('hex')}.ts`,
    );

    const layoutPaths               = findPageLayouts(page.absPath, PAGES_DIR);
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
        pageImport:                JSON.stringify('./' + path.basename(page.absPath)),
        layoutImports,
        clientComponentNames,
        clientComponentTagImports: buildClientComponentTagImports(registry, adapterDir),
        allClientIds:              [...registry.keys()],
        layoutArrayItems:          layoutPaths.map((_, i) => `__layout_${i}__`).join(', '),
        prerenderedHtml:           prerenderedRecord,
        routeParamNames:           page.paramNames,
        catchAllNames:             page.catchAllNames,
      }),
    );

    tempAdapterPaths.push(adapterPath);
    dispatcherRoutes.push({
      adapterPath,
      srcRegex:      page.srcRegex,
      paramNames:    page.paramNames,
      catchAllNames: page.catchAllNames,
    });
    console.log(`  prepared  ${path.relative(PAGES_DIR, page.absPath)}  →  ${page.funcPath}  [page]`);
  }

  // Error page adapters.
  for (const [statusCode, key] of [[404, 'adapter404'], [500, 'adapter500']] as const) {
    const src = path.join(PAGES_DIR, `_${statusCode}.tsx`);
    if (!fs.existsSync(src)) continue;

    console.log(`  building  _${statusCode}.tsx  →  pages dispatcher  [error page]`);
    const adapterDir  = path.dirname(src);
    const adapterPath = path.join(
      adapterDir,
      `_cf_error_adapter_${randomBytes(4).toString('hex')}.ts`,
    );

    const layoutPaths               = findPageLayouts(src, PAGES_DIR);
    const { registry, clientComponentNames } = buildPerPageRegistry(src, layoutPaths, PAGES_DIR);
    const layoutImports = layoutPaths
      .map((lp, i) => {
        const rel = path.relative(adapterDir, lp).replace(/\\/g, '/');
        return `import __layout_${i}__ from ${JSON.stringify(rel.startsWith('.') ? rel : './' + rel)};`;
      })
      .join('\n');

    fs.writeFileSync(
      adapterPath,
      makePageAdapterSource({
        pageImport:                JSON.stringify('./' + path.basename(src)),
        layoutImports,
        clientComponentNames,
        clientComponentTagImports: buildClientComponentTagImports(registry, adapterDir),
        allClientIds:              [...registry.keys()],
        layoutArrayItems:          layoutPaths.map((_, i) => `__layout_${i}__`).join(', '),
        prerenderedHtml:           prerenderedRecord,
        routeParamNames:           [],
        catchAllNames:             [],
        statusCode,
      }),
    );

    errorAdapters[key]  = adapterPath;
    errorAdapterPaths.push(adapterPath);
  }

  // Bundle pages dispatcher.
  const pageDispSrc  = makePagesDispatcherSource(dispatcherRoutes, errorAdapters);
  const pageDispPath = path.join(
    PAGES_DIR,
    `_cf_pages_dispatcher_${randomBytes(4).toString('hex')}.ts`,
  );
  fs.writeFileSync(pageDispPath, pageDispSrc);

  try {
    const outPath = path.join(OUTPUT_DIR, 'cf-pages-dispatcher.js');
    await bundleForWorker(pageDispPath, outPath);
    console.log(`  built     Pages dispatcher → cf-pages-dispatcher.js  (${serverPages.length} page(s))`);
  } finally {
    fs.unlinkSync(pageDispPath);
    for (const p of tempAdapterPaths)  if (fs.existsSync(p)) fs.unlinkSync(p);
    for (const p of errorAdapterPaths) if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

// ─── Bundle worker entry ──────────────────────────────────────────────────────

// Walk STATIC_DIR only now — after buildCombinedBundle, copyPublicFiles, AND
// bundleClientComponents have all run — so __client-component/ files are included
// in the inline asset map used by standalone Workers deployments.
const staticEntries = walkStaticDir(STATIC_DIR);
const inlineStaticMap: string = staticEntries
  .map(({ rel, abs }) => {
    const ext         = path.extname(rel).toLowerCase();
    const contentType = MIME_MAP[ext] ?? 'application/octet-stream';
    const isText      = TEXT_EXTS.has(ext);
    const raw         = fs.readFileSync(abs);
    if (isText) {
      const escaped = JSON.stringify(raw.toString('utf-8'));
      return `  [${JSON.stringify(rel)}, { ct: ${JSON.stringify(contentType)}, body: ${escaped}, text: true }],`;
    } else {
      const b64 = raw.toString('base64');
      return `  [${JSON.stringify(rel)}, { ct: ${JSON.stringify(contentType)}, body: ${JSON.stringify(b64)}, text: false }],`;
    }
  })
  .join('\n');

// The worker entry imports the pre-bundled dispatcher modules via their output
// paths, then wraps everything with the Node shim + fetch handler.
const workerSrc     = makeWorkerEntrySource(hasApi, hasPages, inlineStaticMap, cfMiddlewarePath);
const workerSrcPath = path.join(
  OUTPUT_DIR,
  `_cf_worker_entry_${randomBytes(4).toString('hex')}.ts`,
);
fs.writeFileSync(workerSrcPath, workerSrc);

try {
  // Resolve dispatcher imports relative to OUTPUT_DIR (where the entry lives).
  await bundleForWorker(workerSrcPath, path.join(OUTPUT_DIR, '_worker.mjs'));
  console.log(`  built     Worker entry     → .cloudflare/output/_worker.mjs`);
} finally {
  fs.unlinkSync(workerSrcPath);
  // Clean up intermediate dispatcher bundles — everything is now in _worker.mjs.
  for (const disp of ['cf-api-dispatcher.js', 'cf-pages-dispatcher.js']) {
    const p = path.join(OUTPUT_DIR, disp);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

// ─── wrangler.toml ────────────────────────────────────────────────────────────

/**
 * Emit a wrangler.toml for standalone Workers deployment via `wrangler deploy`.
 *
 * For Cloudflare Pages, this file is not required — Pages uses its own
 * dashboard / wrangler pages deploy configuration instead.
 */
const projectName = path.basename(process.cwd()).replace(/[^a-z0-9-]/gi, '-').toLowerCase();

const wranglerToml = `\
# Generated by NukeJS build-cloudflare — edit as needed.
# This file is used by \`wrangler deploy\` for standalone Workers deployment.
# For Cloudflare Pages, configure the build output directory in the Pages
# dashboard instead (.cloudflare/output).

name         = "${projectName}"
main         = ".cloudflare/output/_worker.mjs"
compatibility_date = "${new Date().toISOString().slice(0, 10)}"

[build]
command = "nuke build --cloudflare"

# Uncomment to add KV, R2, D1, or other bindings:
# [[kv_namespaces]]
# binding = "KV"
# id      = "YOUR_KV_NAMESPACE_ID"
`;

fs.writeFileSync(path.resolve('wrangler.toml'), wranglerToml);

// ─── Summary ──────────────────────────────────────────────────────────────────

const routeCount = apiRoutes.length + serverPages.length;
const assetCount = staticEntries.length;

console.log(`
✓ Cloudflare build complete — ${routeCount} route(s), ${assetCount} static asset(s)
  Worker:  .cloudflare/output/_worker.mjs
  Static:  .cloudflare/output/static/
  Config:  wrangler.toml

Deploy options:
  Pages    → wrangler pages deploy .cloudflare/output
  Workers  → wrangler deploy
`);