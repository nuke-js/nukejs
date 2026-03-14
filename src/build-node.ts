/**
 * build-node.ts — Node.js Production Build
 *
 * Produces a self-contained dist/ directory that runs with:
 *   node dist/index.mjs
 *
 * Output layout:
 *   dist/
 *     index.mjs          ← HTTP server entry point (routing: static → framework → api → pages)
 *     manifest.json      ← Route → handler mapping
 *     api/<route>.mjs    ← Bundled API handlers
 *     pages/<route>.mjs  ← Bundled page handlers
 *     static/            ← __n.js, client components, public files
 */

import fs   from 'fs';
import path from 'path';

import { loadConfig } from './config';
import {
  analyzeFile,
  walkFiles,
  buildPages,
  bundleApiHandler,
  buildCombinedBundle,
  copyPublicFiles,
  type AnalyzedRoute,
} from './build-common';

// ─── Output directories ───────────────────────────────────────────────────────

const OUT_DIR    = path.resolve('dist');
const API_DIR    = path.join(OUT_DIR, 'api');
const PAGES_DIR_ = path.join(OUT_DIR, 'pages');
const STATIC_DIR = path.join(OUT_DIR, 'static');

// Clean the entire dist/ folder before building so stale bundles, removed
// routes, and renamed pages don't linger in the output.
if (fs.existsSync(OUT_DIR)) {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  console.log('🗑️  Cleaned dist/');
}

for (const dir of [API_DIR, PAGES_DIR_, STATIC_DIR])
  fs.mkdirSync(dir, { recursive: true });

// ─── Config ───────────────────────────────────────────────────────────────────

const config     = await loadConfig();
const SERVER_DIR = path.resolve(config.serverDir);
const PAGES_DIR  = path.resolve('./app/pages');
const PUBLIC_DIR = path.resolve('./app/public');

// ─── Route manifest ───────────────────────────────────────────────────────────

interface ManifestEntry {
  /** Regex string matching the URL path, e.g. '^/users/([^/]+)$' */
  srcRegex:      string;
  /** Names of captured groups in srcRegex order */
  paramNames:    string[];
  /** Subset of paramNames whose runtime values are string[] (catch-all params) */
  catchAllNames: string[];
  /** Path to the bundled handler relative to dist/, e.g. 'api/users/[id].mjs' */
  handler:       string;
  type:          'api' | 'page';
}

const manifest: ManifestEntry[] = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Converts a funcPath like '/api/users/[id]' to a filename 'users/[id].mjs'. */
function funcPathToFilename(funcPath: string, prefix: 'api' | 'page'): string {
  return funcPath.replace(new RegExp(`^\\/${prefix}\\/`), '') + '.mjs';
}

// ─── API routes ───────────────────────────────────────────────────────────────

const apiFiles = walkFiles(SERVER_DIR);
if (apiFiles.length === 0) console.warn(`⚠  No server files found in ${SERVER_DIR}`);

const apiRoutes = apiFiles
  .map(relPath => ({ ...analyzeFile(relPath, 'api'), absPath: path.join(SERVER_DIR, relPath) }))
  .sort((a, b) => b.specificity - a.specificity);

for (const { srcRegex, paramNames, catchAllNames, funcPath, absPath } of apiRoutes) {
  console.log(`  building  ${path.relative(SERVER_DIR, absPath)}  →  ${funcPath}`);

  const filename = funcPathToFilename(funcPath, 'api');
  const outPath  = path.join(API_DIR, filename);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, await bundleApiHandler(absPath));

  manifest.push({ srcRegex, paramNames, catchAllNames, handler: path.join('api', filename), type: 'api' });
}

// ─── Page routes ──────────────────────────────────────────────────────────────

const builtPages = await buildPages(PAGES_DIR, STATIC_DIR);

for (const { srcRegex, paramNames, catchAllNames, funcPath, bundleText } of builtPages) {
  const filename = funcPathToFilename(funcPath, 'page');
  const outPath  = path.join(PAGES_DIR_, filename);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, bundleText);

  manifest.push({ srcRegex, paramNames, catchAllNames, handler: path.join('pages', filename), type: 'page' });
}

// ─── Manifest ─────────────────────────────────────────────────────────────────

// Entries are already sorted most-specific first (both loops sort before
// iterating), so the runtime can match top-to-bottom.
fs.writeFileSync(
  path.join(OUT_DIR, 'manifest.json'),
  JSON.stringify({ routes: manifest }, null, 2),
);

// ─── Static assets ────────────────────────────────────────────────────────────

await buildCombinedBundle(STATIC_DIR);
copyPublicFiles(PUBLIC_DIR, STATIC_DIR);

// ─── Server entry ─────────────────────────────────────────────────────────────
// A thin HTTP server that reads manifest.json at startup and dispatches
// incoming requests to the correct pre-built handler module.

const MIME_MAP_ENTRIES = `
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.cjs':  'application/javascript; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.csv':  'text/csv; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.bmp':  'image/bmp',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  '.pdf':  'application/pdf',
  '.wasm': 'application/wasm',
`.trim();

const serverEntry = `\
import http from 'http';
import path from 'path';
import fs   from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { routes } = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf-8'));
const compiled   = routes.map(r => ({ ...r, regex: new RegExp(r.srcRegex) }));

const STATIC_DIR = path.join(__dirname, 'static');
const MIME_MAP   = { ${MIME_MAP_ENTRIES} };

const server = http.createServer(async (req, res) => {
  const url   = req.url || '/';
  const clean = url.split('?')[0];

  // 1. Static files — app/public/ files are copied into STATIC_DIR last at
  //    build time (after framework bundles), so they take priority over
  //    framework files on name collision.  path.join normalises '..' segments
  //    before the startsWith guard, preventing directory traversal.
  {
    const candidate  = path.join(STATIC_DIR, clean);
    const staticBase = STATIC_DIR.endsWith(path.sep) ? STATIC_DIR : STATIC_DIR + path.sep;
    if (
      candidate.startsWith(staticBase) &&
      candidate !== STATIC_DIR &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile()
    ) {
      res.setHeader('Content-Type', MIME_MAP[path.extname(candidate)] ?? 'application/octet-stream');
      res.end(fs.readFileSync(candidate));
      return;
    }
  }

  // 2. Route dispatch — API routes appear before page routes in the manifest
  //    (built in build-node.ts), so they are matched first.
  for (const { regex, paramNames, catchAllNames, handler } of compiled) {
    const m = clean.match(regex);
    if (!m) continue;

    const catchAllSet = new Set(catchAllNames);
    const qs = new URLSearchParams(Object.fromEntries(new URL(url, 'http://localhost').searchParams));
    paramNames.forEach((name, i) => {
      const raw = m[i + 1] ?? '';
      if (catchAllSet.has(name)) {
        raw.split('/').filter(Boolean).forEach(seg => qs.append(name, seg));
      } else {
        qs.set(name, raw);
      }
    });
    req.url = clean + (qs.toString() ? '?' + qs.toString() : '');

    const mod = await import(pathToFileURL(path.join(__dirname, handler)).href);
    await mod.default(req, res);
    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Not found');
});

const PORT = Number(process.env.PORT ?? 3000);
server.listen(PORT, () => console.log('nukejs built server listening on http://localhost:' + PORT));
`;

fs.writeFileSync(path.join(OUT_DIR, 'index.mjs'), serverEntry);

console.log(`\n✓ Node build complete — ${manifest.length} route(s) → dist/`);
console.log('  run with: node dist/index.mjs');