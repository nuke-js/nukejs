import fs from 'fs';
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

fs.mkdirSync(API_DIR,    { recursive: true });
fs.mkdirSync(PAGES_DIR_, { recursive: true });
fs.mkdirSync(STATIC_DIR, { recursive: true });

// ─── Config ───────────────────────────────────────────────────────────────────

const config     = await loadConfig();
const SERVER_DIR = path.resolve(config.serverDir);
const PAGES_DIR  = path.resolve('./app/pages');
const PUBLIC_DIR = path.resolve('./app/public');

// ─── Route manifest ───────────────────────────────────────────────────────────
// Written to dist/manifest.json so the runtime HTTP server can dispatch
// incoming requests to the correct pre-built handler module.

interface ManifestEntry {
  /** Regex string matching the URL path, e.g. '^/users/([^/]+)$' */
  srcRegex: string;
  /** Names of captured groups in srcRegex order */
  paramNames: string[];
  /** Path to the bundled handler relative to dist/, e.g. 'api/users/[id].mjs' */
  handler: string;
  type: 'api' | 'page';
}

const manifest: ManifestEntry[] = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Converts a funcPath like '/api/users/[id]' to a safe filename 'users/[id].mjs'. */
function funcPathToFilename(funcPath: string, prefix: 'api' | 'page'): string {
  const rel = funcPath.replace(new RegExp(`^\/${prefix}\/`), '');
  return rel + '.mjs';
}

// ─── API routes ───────────────────────────────────────────────────────────────

const apiFiles = walkFiles(SERVER_DIR);
if (apiFiles.length === 0) console.warn(`⚠  No server files found in ${SERVER_DIR}`);

const apiRoutes = apiFiles
  .map(relPath => ({ ...analyzeFile(relPath, 'api'), absPath: path.join(SERVER_DIR, relPath) }))
  .sort((a, b) => b.specificity - a.specificity);

for (const { srcRegex, paramNames, funcPath, absPath } of apiRoutes) {
  console.log(`  building  ${path.relative(SERVER_DIR, absPath)}  →  ${funcPath}`);

  const filename = funcPathToFilename(funcPath, 'api');
  const outPath  = path.join(API_DIR, filename);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  fs.writeFileSync(outPath, await bundleApiHandler(absPath));

  manifest.push({ srcRegex, paramNames, handler: path.join('api', filename), type: 'api' });
}

// ─── Page routes ──────────────────────────────────────────────────────────────

const builtPages = await buildPages(PAGES_DIR, STATIC_DIR);

for (const { srcRegex, paramNames, funcPath, bundleText } of builtPages) {
  const filename = funcPathToFilename(funcPath, 'page');
  const outPath  = path.join(PAGES_DIR_, filename);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, bundleText);

  manifest.push({ srcRegex, paramNames, handler: path.join('pages', filename), type: 'page' });
}

// ─── Route manifest ───────────────────────────────────────────────────────────
// Entries are already sorted most-specific first (both apiRoutes and buildPages
// sort before their loops), so the server can match top-to-bottom.

fs.writeFileSync(
  path.join(OUT_DIR, 'manifest.json'),
  JSON.stringify({ routes: manifest }, null, 2),
);

// ─── Static assets ────────────────────────────────────────────────────────────

await buildCombinedBundle(STATIC_DIR);
copyPublicFiles(PUBLIC_DIR, STATIC_DIR);

// ─── Server entry ─────────────────────────────────────────────────────────────
// A thin HTTP server that reads manifest.json and dispatches requests to the
// pre-built handler modules.  Written to dist/index.mjs — run with:
//   node dist/index.mjs

const serverEntry = `
import http from 'http';
import path from 'path';
import fs   from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { routes } = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf-8'),
);

// Pre-compile all route regexes once at startup.
const compiled = routes.map(r => ({ ...r, regex: new RegExp(r.srcRegex) }));

const STATIC_DIR = path.join(__dirname, 'static');

const MIME_MAP = {
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
};

const server = http.createServer(async (req, res) => {
  const url   = req.url || '/';
  const clean = url.split('?')[0];

  // Internal __-prefixed static assets (/__n.js, /__client-component/*)
  if (
    clean === '/__n.js' ||
    clean.startsWith('/__client-component/')
  ) {
    const filePath = path.join(STATIC_DIR, clean);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      res.setHeader('Content-Type', MIME_MAP[ext] ?? 'application/javascript');
      res.end(fs.readFileSync(filePath));
      return;
    }
    res.statusCode = 404;
    res.end('Not found');
    return;
  }

  // User public files from app/public/.  path.join normalises '..' segments
  // before the startsWith guard, preventing directory traversal.
  {
    const candidate  = path.join(STATIC_DIR, clean);
    const staticBase = STATIC_DIR.endsWith(path.sep) ? STATIC_DIR : STATIC_DIR + path.sep;
    const safe = candidate.startsWith(staticBase) && candidate !== STATIC_DIR;
    if (safe && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const ext = path.extname(candidate);
      res.setHeader('Content-Type', MIME_MAP[ext] ?? 'application/octet-stream');
      res.end(fs.readFileSync(candidate));
      return;
    }
  }

  // Route manifest dispatch.
  for (const { regex, paramNames, handler } of compiled) {
    const m = clean.match(regex);
    if (!m) continue;

    const params = Object.fromEntries(paramNames.map((n, i) => [n, m[i + 1]]));
    const qs     = new URLSearchParams({ ...params, ...Object.fromEntries(new URL(url, 'http://localhost').searchParams) });
    req.url      = clean + (qs.toString() ? '?' + qs.toString() : '');

    const mod = await import(pathToFileURL(path.join(__dirname, handler)).href);
    await mod.default(req, res);
    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Not found');
});

const PORT = Number(process.env.PORT ?? 3000);
server.listen(PORT, () => {
  console.log('nukejs built server listening on http://localhost:' + PORT);
});
`.trimStart();

fs.writeFileSync(path.join(OUT_DIR, 'index.mjs'), serverEntry);

console.log(`\n✓ Node build complete — ${manifest.length} route(s) → dist/`);
console.log(`  run with: node dist/index.mjs`);