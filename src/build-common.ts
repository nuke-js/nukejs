/**
 * build-common.ts
 *
 * Shared build logic used by both build-vercel.ts and build-node.ts.
 *
 * Exports:
 *   — utility helpers   : walkFiles, analyzeFile, isServerComponent,
 *                         findPageLayouts, extractDefaultExportName
 *   — collection        : collectServerPages, collectGlobalClientRegistry
 *   — template codegen  : makeApiAdapterSource, makePageAdapterSource
 *   — bundle operations : bundleApiHandler, bundlePageHandler,
 *                         bundleClientComponents, buildCombinedBundle
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import { build } from 'esbuild';
import { findClientComponentsInTree } from './component-analyzer';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AnalyzedRoute {
  srcRegex: string;
  paramNames: string[];
  /** Path used as function namespace, e.g. '/api/users' or '/page/about'. */
  funcPath: string;
  specificity: number;
}

export interface ServerPage extends AnalyzedRoute {
  absPath: string;
}

/** A server page together with its fully bundled ESM text, ready to emit. */
export interface BuiltPage extends ServerPage {
  bundleText: string;
}

// ─── File walker ──────────────────────────────────────────────────────────────

export function walkFiles(dir: string, base: string = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, base));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      results.push(path.relative(base, full));
    }
  }
  return results;
}

// ─── Route analysis ───────────────────────────────────────────────────────────

/**
 * Parses dynamic-route segments from a relative file path and returns a regex,
 * captured param names, a function path, and a specificity score.
 *
 * @param relPath  Relative path from the dir root (e.g. 'users/[id].tsx').
 * @param prefix   Namespace for funcPath ('api' | 'page').
 */
export function analyzeFile(relPath: string, prefix = 'api'): AnalyzedRoute {
  const normalized = relPath.replace(/\\/g, '/').replace(/\.(tsx?)$/, '');
  let segments = normalized.split('/');
  if (segments.at(-1) === 'index') segments = segments.slice(0, -1);

  const paramNames: string[] = [];
  const regexParts: string[] = [];
  let specificity = 0;

  for (const seg of segments) {
    const optCatchAll = seg.match(/^\[\[\.\.\.(.+)\]\]$/);
    if (optCatchAll) { paramNames.push(optCatchAll[1]); regexParts.push('(.*)'); specificity += 1; continue; }
    const catchAll = seg.match(/^\[\.\.\.(.+)\]$/);
    if (catchAll) { paramNames.push(catchAll[1]); regexParts.push('(.+)'); specificity += 10; continue; }
    const dynamic = seg.match(/^\[(.+)\]$/);
    if (dynamic) { paramNames.push(dynamic[1]); regexParts.push('([^/]+)'); specificity += 100; continue; }
    regexParts.push(seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    specificity += 1000;
  }

  const srcRegex = segments.length === 0
    ? '^/$'
    : '^/' + regexParts.join('/') + '$';

  const funcSegments = normalized.split('/');
  if (funcSegments.at(-1) === 'index') funcSegments.pop();
  const funcPath = funcSegments.length === 0
    ? `/${prefix}/_index`
    : `/${prefix}/` + funcSegments.join('/');

  return { srcRegex, paramNames, funcPath, specificity };
}

// ─── Server-component detection ───────────────────────────────────────────────

/**
 * Returns true when a file does NOT begin with a "use client" directive —
 * i.e. it is a server component.
 */
export function isServerComponent(filePath: string): boolean {
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n').slice(0, 5)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    if (/^["']use client["'];?$/.test(trimmed)) return false;
    break;
  }
  return true;
}

// ─── Layout discovery ─────────────────────────────────────────────────────────

/**
 * Walks from the pages root to the directory containing `routeFilePath` and
 * returns every layout.tsx found, in outermost-first order.
 */
export function findPageLayouts(routeFilePath: string, pagesDir: string): string[] {
  const layouts: string[] = [];

  const rootLayout = path.join(pagesDir, 'layout.tsx');
  if (fs.existsSync(rootLayout)) layouts.push(rootLayout);

  const relativePath = path.relative(pagesDir, path.dirname(routeFilePath));
  if (!relativePath || relativePath === '.') return layouts;

  const segments = relativePath.split(path.sep).filter(Boolean);
  for (let i = 1; i <= segments.length; i++) {
    const layoutPath = path.join(pagesDir, ...segments.slice(0, i), 'layout.tsx');
    if (fs.existsSync(layoutPath)) layouts.push(layoutPath);
  }

  return layouts;
}

/**
 * Extracts the identifier used as the default export from a component file.
 * Returns null when no default export is found.
 */
export function extractDefaultExportName(filePath: string): string | null {
  const content = fs.readFileSync(filePath, 'utf-8');
  const match = content.match(/export\s+default\s+(?:function\s+)?(\w+)/);
  return match?.[1] ?? null;
}

// ─── Server page collection ───────────────────────────────────────────────────

/**
 * Returns all server-component pages inside `pagesDir`, sorted by specificity
 * (most-specific first so more-precise routes shadow catch-alls in routers).
 * layout.tsx files and "use client" files are excluded.
 */
export function collectServerPages(pagesDir: string): ServerPage[] {
  if (!fs.existsSync(pagesDir)) return [];
  return walkFiles(pagesDir)
    .filter(relPath => {
      const base = path.basename(relPath, path.extname(relPath));
      if (base === 'layout') return false;
      return isServerComponent(path.join(pagesDir, relPath));
    })
    .map(relPath => ({
      ...analyzeFile(relPath, 'page'),
      absPath: path.join(pagesDir, relPath),
    }))
    .sort((a, b) => b.specificity - a.specificity);
}

/**
 * Walks every server page and its layout chain to collect all client component
 * IDs reachable anywhere in the app.  Deduplication is automatic because the
 * Map key is the stable content-hash ID produced by component-analyzer.ts.
 */
export function collectGlobalClientRegistry(
  serverPages: ServerPage[],
  pagesDir: string,
): Map<string, string> {
  const registry = new Map<string, string>(); // id → absFilePath
  for (const { absPath } of serverPages) {
    for (const [id, p] of findClientComponentsInTree(absPath, pagesDir)) {
      registry.set(id, p);
    }
    for (const layoutPath of findPageLayouts(absPath, pagesDir)) {
      for (const [id, p] of findClientComponentsInTree(layoutPath, pagesDir)) {
        registry.set(id, p);
      }
    }
  }
  return registry;
}

// ─── Per-page registry helpers ────────────────────────────────────────────────

/**
 * Builds the per-page client component registry (page + its layout chain) and
 * returns both the id→path map and the name→id map needed by bundlePageHandler.
 *
 * Extracted here to eliminate the identical loop duplicated across
 * build-node.ts and build-vercel.ts.
 */
export function buildPerPageRegistry(
  absPath: string,
  layoutPaths: string[],
  pagesDir: string,
): { registry: Map<string, string>; clientComponentNames: Record<string, string> } {
  const registry = new Map<string, string>();

  for (const [id, p] of findClientComponentsInTree(absPath, pagesDir)) {
    registry.set(id, p);
  }
  for (const lp of layoutPaths) {
    for (const [id, p] of findClientComponentsInTree(lp, pagesDir)) {
      registry.set(id, p);
    }
  }

  const clientComponentNames: Record<string, string> = {};
  for (const [id, filePath] of registry) {
    const name = extractDefaultExportName(filePath);
    if (name) clientComponentNames[name] = id;
  }

  return { registry, clientComponentNames };
}

// ─── High-level page builder ──────────────────────────────────────────────────

/**
 * Runs both passes of the page build:
 *
 *   Pass 1 — bundles all client components to `staticDir/__client-component/`
 *             and collects pre-rendered HTML for each.
 *   Pass 2 — bundles every server-component page into a self-contained ESM
 *             handler and returns the results as `BuiltPage[]`.
 *
 * Callers (build-node, build-vercel) only need to write the bundled text to
 * their respective output destinations — the format-specific logic stays local.
 *
 * Returns an empty array when there are no server pages.
 */
export async function buildPages(
  pagesDir: string,
  staticDir: string,
): Promise<BuiltPage[]> {
  const serverPages = collectServerPages(pagesDir);

  if (fs.existsSync(pagesDir) && walkFiles(pagesDir).length > 0 && serverPages.length === 0) {
    console.warn(`⚠  Pages found in ${pagesDir} but none are server components`);
  }

  if (serverPages.length === 0) return [];

  // Pass 1 — bundle all client components to static files.
  const globalClientRegistry = collectGlobalClientRegistry(serverPages, pagesDir);
  const prerenderedHtml = await bundleClientComponents(globalClientRegistry, pagesDir, staticDir);
  const prerenderedHtmlRecord = Object.fromEntries(prerenderedHtml);

  // Pass 2 — bundle each server-component page.
  const builtPages: BuiltPage[] = [];

  for (const page of serverPages) {
    const { funcPath, absPath } = page;
    console.log(`  building  ${fs.existsSync(absPath) ? absPath : absPath}  →  ${funcPath}  [page]`);

    const layoutPaths = findPageLayouts(absPath, pagesDir);
    const { registry, clientComponentNames } = buildPerPageRegistry(absPath, layoutPaths, pagesDir);

    const bundleText = await bundlePageHandler({
      absPath,
      pagesDir,
      clientComponentNames,
      allClientIds: [...registry.keys()],
      layoutPaths,
      prerenderedHtml: prerenderedHtmlRecord,
    });

    builtPages.push({ ...page, bundleText });
  }

  return builtPages;
}

// ─── API adapter template ─────────────────────────────────────────────────────

/**
 * Returns the TypeScript source for a thin HTTP adapter that wraps an API
 * route module and exposes a single `handler(req, res)` default export.
 *
 * @param handlerFilename  Basename of the handler file relative to the adapter
 *                         (e.g. 'users.ts').  Must be in the same directory.
 */
export function makeApiAdapterSource(handlerFilename: string): string {
  return `
import type { IncomingMessage, ServerResponse } from 'http';
import * as mod from ${JSON.stringify('./' + handlerFilename)};

function enhance(res: ServerResponse) {
  (res as any).json = function (data: any, status = 200) {
    this.statusCode = status;
    this.setHeader('Content-Type', 'application/json');
    this.end(JSON.stringify(data));
  };
  (res as any).status = function (code: number) { this.statusCode = code; return this; };
  return res;
}

async function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body && req.headers['content-type']?.includes('application/json')
          ? JSON.parse(body) : body);
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const method = (req.method || 'GET').toUpperCase();
  const apiRes = enhance(res);
  const apiReq = req as any;

  apiReq.body   = await parseBody(req);
  apiReq.query  = Object.fromEntries(new URL(req.url || '/', 'http://localhost').searchParams);
  apiReq.params = apiReq.query;

  const fn = (mod as any)[method] ?? (mod as any).default;
  if (typeof fn !== 'function') {
    (apiRes as any).json({ error: \`Method \${method} not allowed\` }, 405);
    return;
  }
  await fn(apiReq, apiRes);
}
`.trimStart();
}

// ─── Page adapter template ────────────────────────────────────────────────────

export interface PageAdapterOptions {
  /** e.g. './home.tsx' — relative import for the page default export */
  pageImport: string;
  /** Newline-joined import statements for layout components */
  layoutImports: string;
  /** function-name → cc_id map, computed at build time */
  clientComponentNames: Record<string, string>;
  /** All client component IDs reachable from this page */
  allClientIds: string[];
  /** Comma-separated list of __layout_N__ identifiers */
  layoutArrayItems: string;
  /** Pre-rendered HTML per client component ID, computed at build time */
  prerenderedHtml: Record<string, string>;
}

/**
 * Returns the TypeScript source for a fully self-contained page handler.
 *
 * The adapter:
 *   • Inlines the html-store so useHtml() works without external deps.
 *   • Contains an async recursive renderer that handles server + client
 *     components without react-dom/server.
 *   • Client components are identified via the pre-computed CLIENT_COMPONENTS
 *     map (no fs.readFileSync at runtime).
 *   • Emits the same full HTML document structure as ssr.ts including the
 *     __n_data blob, importmap, and initRuntime bootstrap.
 */
export function makePageAdapterSource(opts: PageAdapterOptions): string {
  const {
    pageImport,
    layoutImports,
    clientComponentNames,
    allClientIds,
    layoutArrayItems,
    prerenderedHtml,
  } = opts;

  return `
import type { IncomingMessage, ServerResponse } from 'http';
import * as __page__ from ${pageImport};
${layoutImports}

// ─── Pre-built client component registry ─────────────────────────────────────
// Computed at BUILD TIME from the import tree.  Source files are not deployed,
// so we must not read them with fs.readFileSync at runtime.
// Key: default-export function name  →  Value: stable content-hash ID
const CLIENT_COMPONENTS: Record<string, string> = ${JSON.stringify(clientComponentNames)};

// All client component IDs reachable from this page (page + layouts).
// Sent to initRuntime so the browser pre-loads all bundles for SPA navigation.
const ALL_CLIENT_IDS: string[] = ${JSON.stringify(allClientIds)};

// Pre-rendered HTML for each client component, produced at BUILD TIME by
// renderToString with default props.  Used directly in the span wrapper so
// the server response contains real markup and React hydration never sees a
// mismatch.  No react-dom/server is needed at runtime.
const PRERENDERED_HTML: Record<string, string> = ${JSON.stringify(prerenderedHtml)};

// ─── html-store (inlined — no external refs) ─────────────────────────────────
// Uses the same globalThis Symbol key as html-store.ts so any useHtml() call
// (however imported) writes into the same store that runWithHtmlStore reads.
type TitleValue = string | ((prev: string) => string);
interface HtmlStore {
  titleOps: TitleValue[];
  htmlAttrs: Record<string, string | undefined>;
  bodyAttrs: Record<string, string | undefined>;
  meta: Record<string, string | undefined>[];
  link: Record<string, string | undefined>[];
  script: Record<string, any>[];
  style: { content?: string; media?: string }[];
}
const __STORE_KEY__ = Symbol.for('__nukejs_html_store__');
function __getStore(): HtmlStore | null { return (globalThis as any)[__STORE_KEY__] ?? null; }
function __setStore(s: HtmlStore | null): void { (globalThis as any)[__STORE_KEY__] = s; }
function __emptyStore(): HtmlStore {
  return { titleOps: [], htmlAttrs: {}, bodyAttrs: {}, meta: [], link: [], script: [], style: [] };
}
async function runWithHtmlStore(fn: () => Promise<void>): Promise<HtmlStore> {
  __setStore(__emptyStore());
  try { await fn(); return { ...(__getStore() ?? __emptyStore()) }; }
  finally { __setStore(null); }
}
function resolveTitle(ops: TitleValue[], fallback = ''): string {
  let t = fallback;
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]; t = typeof op === 'string' ? op : op(t);
  }
  return t;
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function escapeAttr(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
function renderAttrs(attrs: Record<string, string | boolean | undefined>): string {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== false)
    .map(([k, v]) => v === true ? k : \`\${k}="\${escapeAttr(String(v))}"\`)
    .join(' ');
}
function openTag(tag: string, attrs: Record<string, string | undefined>): string {
  const s = renderAttrs(attrs as Record<string, string | boolean | undefined>);
  return s ? \`<\${tag} \${s}>\` : \`<\${tag}>\`;
}
function metaKey(k: string): string { return k === 'httpEquiv' ? 'http-equiv' : k; }
function linkKey(k: string): string {
  if (k === 'hrefLang') return 'hreflang';
  if (k === 'crossOrigin') return 'crossorigin';
  return k;
}
function renderMetaTag(tag: Record<string, string | undefined>): string {
  const attrs: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(tag)) if (v !== undefined) attrs[metaKey(k)] = v;
  return \`  <meta \${renderAttrs(attrs as any)} />\`;
}
function renderLinkTag(tag: Record<string, string | undefined>): string {
  const attrs: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(tag)) if (v !== undefined) attrs[linkKey(k)] = v;
  return \`  <link \${renderAttrs(attrs as any)} />\`;
}
function renderScriptTag(tag: any): string {
  const attrs: Record<string, any> = {
    src: tag.src, type: tag.type, crossorigin: tag.crossOrigin,
    integrity: tag.integrity, defer: tag.defer, async: tag.async, nomodule: tag.noModule,
  };
  const s = renderAttrs(attrs);
  const open = s ? \`<script \${s}>\` : '<script>';
  return \`  \${open}\${tag.src ? '' : (tag.content ?? '')}</script>\`;
}
function renderStyleTag(tag: any): string {
  const media = tag.media ? \` media="\${escapeAttr(tag.media)}"\` : '';
  return \`  <style\${media}>\${tag.content ?? ''}</style>\`;
}

// ─── Void element set ─────────────────────────────────────────────────────────
const VOID_TAGS = new Set([
  'area','base','br','col','embed','hr','img','input',
  'link','meta','param','source','track','wbr',
]);

// ─── Prop serialization ───────────────────────────────────────────────────────
// Converts React element trees in props to a JSON-safe format that
// bundle.ts / initRuntime can reconstruct on the client.
function serializeProps(value: any): any {
  if (value == null || typeof value !== 'object') return value;
  if (typeof value === 'function') return undefined;
  if (Array.isArray(value)) {
    return value.map(serializeProps).filter((v: any) => v !== undefined);
  }
  if ((value as any).$$typeof) {
    const { type, props: elProps } = value as any;
    if (typeof type === 'string') {
      return { __re: 'html', tag: type, props: serializeProps(elProps) };
    }
    if (typeof type === 'function') {
      const cid = CLIENT_COMPONENTS[type.name];
      if (cid) return { __re: 'client', componentId: cid, props: serializeProps(elProps) };
    }
    return undefined;
  }
  const out: any = {};
  for (const [k, v] of Object.entries(value as Record<string, any>)) {
    const s = serializeProps(v);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

// ─── Async recursive renderer ─────────────────────────────────────────────────
// Handles: null/undefined/boolean → '', strings/numbers → escaped text, arrays,
// Fragment, void/non-void HTML elements, class components, sync + async functions.
// Client components → <span data-hydrate-id="…"> markers for browser hydration.
async function renderNode(node: any, hydrated: Set<string>): Promise<string> {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string') return escapeHtml(node);
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) {
    return (await Promise.all(node.map(n => renderNode(n, hydrated)))).join('');
  }

  const { type, props } = node as { type: any; props: Record<string, any> };
  if (!type) return '';

  if (type === Symbol.for('react.fragment')) {
    return renderNode(props?.children ?? null, hydrated);
  }

  if (typeof type === 'string') {
    const { children, dangerouslySetInnerHTML, ...rest } = props || {};
    const attrParts: string[] = [];
    for (const [k, v] of Object.entries(rest as Record<string, any>)) {
      const name = k === 'className' ? 'class' : k === 'htmlFor' ? 'for' : k;
      if (typeof v === 'boolean') { if (v) attrParts.push(name); continue; }
      if (v == null) continue;
      if (k === 'style' && typeof v === 'object') {
        const css = Object.entries(v as Record<string, any>)
          .map(([p, val]) => \`\${p.replace(/[A-Z]/g, m => \`-\${m.toLowerCase()}\`)}:\${escapeHtml(String(val))}\`)
          .join(';');
        attrParts.push(\`style="\${css}"\`);
        continue;
      }
      attrParts.push(\`\${name}="\${escapeHtml(String(v))}"\`);
    }
    const attrStr = attrParts.length ? ' ' + attrParts.join(' ') : '';
    if (VOID_TAGS.has(type)) return \`<\${type}\${attrStr} />\`;
    const inner = dangerouslySetInnerHTML
      ? (dangerouslySetInnerHTML as any).__html
      : await renderNode(children ?? null, hydrated);
    return \`<\${type}\${attrStr}>\${inner}</\${type}>\`;
  }

  if (typeof type === 'function') {
    const clientId = CLIENT_COMPONENTS[type.name];
    if (clientId) {
      hydrated.add(clientId);
      const serializedProps = serializeProps(props ?? {});
      // Render with actual props so children/content appear in the SSR HTML.
      // Fall back to the build-time pre-rendered HTML if the component throws
      // (e.g. it references browser-only APIs during render).
      let ssrHtml: string;
      try {
        const result = await (type as Function)(props || {});
        ssrHtml = await renderNode(result, new Set());
      } catch {
        ssrHtml = PRERENDERED_HTML[clientId] ?? '';
      }
      return \`<span data-hydrate-id="\${clientId}" data-hydrate-props="\${escapeHtml(JSON.stringify(serializedProps))}">\${ssrHtml}</span>\`;
    }
    const instance = type.prototype?.isReactComponent ? new (type as any)(props) : null;
    const result = instance ? instance.render() : await (type as Function)(props || {});
    return renderNode(result, hydrated);
  }

  return '';
}

// ─── Layout wrapping ──────────────────────────────────────────────────────────
const LAYOUT_COMPONENTS: Array<(props: any) => any> = [${layoutArrayItems}];

function wrapWithLayouts(element: any): any {
  let el = element;
  for (let i = LAYOUT_COMPONENTS.length - 1; i >= 0; i--) {
    el = { type: LAYOUT_COMPONENTS[i], props: { children: el }, key: null, ref: null };
  }
  return el;
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const parsed = new URL(req.url || '/', 'http://localhost');
    const params: Record<string, string> = {};
    parsed.searchParams.forEach((v, k) => { params[k] = v; });
    const url = req.url || '/';

    const hydrated = new Set<string>();
    const pageElement = { type: __page__.default, props: params as any, key: null, ref: null };
    const wrapped     = wrapWithLayouts(pageElement);

    let appHtml = '';
    const store = await runWithHtmlStore(async () => {
      appHtml = await renderNode(wrapped, hydrated);
    });

    const pageTitle = resolveTitle(store.titleOps, 'SSR App');
    const headLines: string[] = [
      '  <meta charset="utf-8" />',
      '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
      \`  <title>\${escapeHtml(pageTitle)}</title>\`,
      ...(store.meta.length || store.link.length || store.style.length || store.script.length ? [
        '  <!--n-head-->',
        ...store.meta.map(renderMetaTag),
        ...store.link.map(renderLinkTag),
        ...store.style.map(renderStyleTag),
        ...store.script.map(renderScriptTag),
        '  <!--/n-head-->',
      ] : []),
    ];

    const runtimeData = JSON.stringify({
      hydrateIds: [...hydrated],
      allIds: ALL_CLIENT_IDS,
      url,
      params,
      debug: 'silent',
    }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

    const html = \`<!DOCTYPE html>
\${openTag('html', store.htmlAttrs)}
<head>
\${headLines.join('\\n')}
</head>
\${openTag('body', store.bodyAttrs)}
  <div id="app">\${appHtml}</div>

  <script id="__n_data" type="application/json">\${runtimeData}</script>

  <script type="importmap">
  {
    "imports": {
      "react":             "/__n.js",
      "react-dom/client":  "/__n.js",
      "react/jsx-runtime": "/__n.js",
      "nukejs":            "/__n.js"
    }
  }
  </script>

  <script type="module">
    const { initRuntime } = await import('nukejs');
    const data = JSON.parse(document.getElementById('__n_data').textContent);
    await initRuntime(data);
  </script>
</body>
</html>\`;

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  } catch (err: any) {
    console.error('[page render error]', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Internal Server Error');
  }
}
`.trimStart();
}

// ─── Bundle operations ────────────────────────────────────────────────────────

/**
 * Bundles an API route handler into a single self-contained ESM string.
 *
 * Writes a temporary adapter next to `absPath`, bundles them together with
 * esbuild (node_modules kept external), then removes the temp file.
 *
 * @returns The bundled ESM text ready to write to disk.
 */
export async function bundleApiHandler(absPath: string): Promise<string> {
  const adapterName = `_api_adapter_${crypto.randomBytes(4).toString('hex')}.ts`;
  const adapterPath = path.join(path.dirname(absPath), adapterName);

  fs.writeFileSync(adapterPath, makeApiAdapterSource(path.basename(absPath)));

  let text: string;
  try {
    const result = await build({
      entryPoints: [adapterPath],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      packages: 'external',
      write: false,
    });
    text = result.outputFiles[0].text;
  } finally {
    fs.unlinkSync(adapterPath);
  }
  return text;
}

export interface PageBundleOptions {
  absPath: string;
  pagesDir: string;
  clientComponentNames: Record<string, string>;
  allClientIds: string[];
  layoutPaths: string[];
  prerenderedHtml: Record<string, string>;
}

/**
 * Bundles a server-component page into a single self-contained ESM string.
 *
 * Writes a temporary adapter next to `absPath` (so relative imports inside
 * the component resolve from the correct base directory), bundles it with
 * esbuild (React and all npm deps inlined, only Node built-ins stay external),
 * then removes the temp file.
 *
 * @returns The bundled ESM text ready to write to disk.
 */
export async function bundlePageHandler(opts: PageBundleOptions): Promise<string> {
  const { absPath, clientComponentNames, allClientIds, layoutPaths, prerenderedHtml } = opts;

  // The adapter is written next to the page file, so make every layout path
  // relative to that same directory.  Absolute Windows paths like "C:\..." in
  // import statements are not valid ESM URL schemes and throw
  // ERR_UNSUPPORTED_ESM_URL_SCHEME.  Relative paths work on all platforms.
  const adapterName = `_page_adapter_${crypto.randomBytes(4).toString('hex')}.ts`;
  const adapterDir = path.dirname(absPath);
  const adapterPath = path.join(adapterDir, adapterName);

  const layoutImports = layoutPaths
    .map((lp, i) => {
      const rel = path.relative(adapterDir, lp).replace(/\\/g, '/');
      const importPath = rel.startsWith('.') ? rel : './' + rel;
      return `import __layout_${i}__ from ${JSON.stringify(importPath)};`;
    })
    .join('\n');
  const layoutArrayItems = layoutPaths
    .map((_, i) => `__layout_${i}__`)
    .join(', ');

  fs.writeFileSync(adapterPath, makePageAdapterSource({
    pageImport: JSON.stringify('./' + path.basename(absPath)),
    layoutImports,
    clientComponentNames,
    allClientIds,
    layoutArrayItems,
    prerenderedHtml,
  }));

  let text: string;
  try {
    const result = await build({
      entryPoints: [adapterPath],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      jsx: 'automatic',
      external: [
        // Node built-ins only — all npm packages (react, nukejs, …) are inlined
        'node:*',
        'http', 'https', 'fs', 'path', 'url', 'crypto', 'stream', 'buffer',
        'events', 'util', 'os', 'net', 'tls', 'child_process', 'worker_threads',
        'cluster', 'dgram', 'dns', 'readline', 'zlib', 'assert', 'module',
        'perf_hooks', 'string_decoder', 'timers', 'async_hooks', 'v8', 'vm',
      ],
      define: { 'process.env.NODE_ENV': '"production"' },
      write: false,
    });
    text = result.outputFiles[0].text;
  } finally {
    fs.unlinkSync(adapterPath);
  }
  return text;
}

/**
 * Bundles every client component in `globalRegistry` to
 * `<staticDir>/__client-component/<id>.js`.
 *
 * Mirrors bundleClientComponent() in bundler.ts:
 *   • browser ESM, JSX automatic
 *   • react / react-dom/client / react/jsx-runtime kept external so the
 *     importmap can resolve them to the already-loaded /__react.js bundle.
 */
export async function bundleClientComponents(
  globalRegistry: Map<string, string>,
  pagesDir: string,
  staticDir: string,
): Promise<Map<string, string>> {
  if (globalRegistry.size === 0) return new Map();

  const outDir = path.join(staticDir, '__client-component');
  fs.mkdirSync(outDir, { recursive: true });

  const prerendered = new Map<string, string>(); // id → pre-rendered HTML

  for (const [id, filePath] of globalRegistry) {
    console.log(`  bundling  client  ${id}  (${path.relative(pagesDir, filePath)})`);

    // 1. Browser bundle — served to the client for hydration
    const browserResult = await build({
      entryPoints: [filePath],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      jsx: 'automatic',
      minify: true,
      external: ['react', 'react-dom/client', 'react/jsx-runtime'],
      define: { 'process.env.NODE_ENV': '"production"' },
      write: false,
    });
    fs.writeFileSync(path.join(outDir, `${id}.js`), browserResult.outputFiles[0].text);

    // 2. SSR pre-render — bundle for Node, import, renderToString, discard
    const ssrTmp = path.join(
      path.dirname(filePath),
      `_ssr_${id}_${crypto.randomBytes(4).toString('hex')}.mjs`,
    );
    try {
      const ssrResult = await build({
        entryPoints: [filePath],
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        jsx: 'automatic',
        packages: 'external',
        define: { 'process.env.NODE_ENV': '"production"' },
        write: false,
      });
      fs.writeFileSync(ssrTmp, ssrResult.outputFiles[0].text);

      const { default: Component } = await import(pathToFileURL(ssrTmp).href);
      const { createElement } = await import('react');
      const { renderToString } = await import('react-dom/server');

      prerendered.set(id, renderToString(createElement(Component, {})));
      console.log(`  prerendered       ${id}`);
    } catch (e) {
      //console.warn(`  [SSR prerender failed for ${id}]`, e);
      prerendered.set(id, '');
    } finally {
      if (fs.existsSync(ssrTmp)) fs.unlinkSync(ssrTmp);
    }
  }

  console.log(`  bundled   ${globalRegistry.size} client component(s) → ${path.relative(process.cwd(), outDir)}/`);
  return prerendered;
}

/**
 * Builds a single combined browser bundle to `<staticDir>/__n.js`.
 *
 * Inlines the full React + ReactDOM runtime together with the NukeJS client
 * runtime (bundle.ts) so the browser only needs one file instead of two.
 * The importmap in every page points 'react', 'react-dom/client',
 * 'react/jsx-runtime', and 'nukejs' all to /__n.js, so dynamic imports
 * inside the runtime (e.g. `await import('react')`) hit the module cache
 * and return the same singleton that was already loaded.
 *
 * Dev mode (bundler.ts) keeps separate /__react.js and /__n.js files for
 * easier debugging — this function is production-only.
 */
export async function buildCombinedBundle(staticDir: string): Promise<void> {
  const nukeDir = path.dirname(fileURLToPath(import.meta.url));
  // In the dist/ directory the compiled file is bundle.js; in source it is bundle.ts.
  // Omit the .js extension when pointing at the compiled bundle — esbuild
  // resolves it correctly and avoids the double-extension chunk name (bundle.js.js)
  // that occurs when the import specifier already carries a .js suffix.
  const bundleFile = nukeDir.endsWith('dist') ? 'bundle' : 'bundle.ts';

  const result = await build({
    stdin: {
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
export { initRuntime, setupLocationChangeMonitor } from './${bundleFile}';

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
      resolveDir: nukeDir,
    },
    bundle: true,
    write: false,
    treeShaking: true,
    minify: true,
    format: 'esm',
    jsx: 'automatic',
    alias: {
      react: path.dirname(fileURLToPath(import.meta.resolve('react/package.json'))),
      'react-dom': path.dirname(fileURLToPath(import.meta.resolve('react-dom/package.json'))),
    },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  fs.writeFileSync(path.join(staticDir, '__n.js'), result.outputFiles[0].text);
  console.log('  built     __n.js  (react + runtime)');
}

// ─── Public static file copying ───────────────────────────────────────────────

/**
 * Recursively copies every file from `app/public/` into `destDir`,
 * preserving the directory structure.
 *
 * Called by both build-vercel.ts (dest = .vercel/output/static/) and
 * build-node.ts (dest = dist/static/) so that:
 *
 *   app/public/favicon.ico        → <destDir>/favicon.ico
 *   app/public/images/logo.png    → <destDir>/images/logo.png
 *
 * On Vercel, the Build Output API v3 serves everything in .vercel/output/static/
 * directly — no route entry needed, same as __react.js and __n.js.
 *
 * On Node, the serverEntry template serves files from dist/static/ with the
 * same MIME-type logic as the dev middleware.
 *
 * Skips silently when the public directory does not exist so projects without
 * one don't need any special configuration.
 */
export function copyPublicFiles(publicDir: string, destDir: string): void {
  if (!fs.existsSync(publicDir)) return;

  let count = 0;

  (function walk(src: string, dest: string) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        walk(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
        count++;
      }
    }
  })(publicDir, destDir);

  if (count > 0) {
    console.log(`  copied    ${count} public file(s) → ${path.relative(process.cwd(), destDir)}/`);
  }
}