import fs from 'fs';
import path from 'path';

import { loadConfig } from './config';
import {
  analyzeFile,
  walkFiles,
  buildPages,
  bundleApiHandler,
  buildReactBundle,
  buildNukeBundle,
  copyPublicFiles,
} from './build-common';

// ─── Output directories ───────────────────────────────────────────────────────

const OUTPUT_DIR    = path.resolve('.vercel/output');
const FUNCTIONS_DIR = path.join(OUTPUT_DIR, 'functions');
const STATIC_DIR    = path.join(OUTPUT_DIR, 'static');

fs.mkdirSync(FUNCTIONS_DIR, { recursive: true });
fs.mkdirSync(STATIC_DIR,    { recursive: true });

// ─── Config ───────────────────────────────────────────────────────────────────

const config     = await loadConfig();
const SERVER_DIR = path.resolve(config.serverDir);
const PAGES_DIR  = path.resolve('./app/pages');
const PUBLIC_DIR = path.resolve('./app/public');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Writes a bundled handler into a Vercel .func directory. */
function emitVercelFunction(funcPath: string, bundleText: string): void {
  const funcDir = path.join(FUNCTIONS_DIR, funcPath.slice(1) + '.func');
  fs.mkdirSync(funcDir, { recursive: true });
  fs.writeFileSync(path.join(funcDir, 'index.mjs'), bundleText);
  fs.writeFileSync(
    path.join(funcDir, '.vc-config.json'),
    JSON.stringify({ runtime: 'nodejs20.x', handler: 'index.mjs', launcherType: 'Nodejs' }, null, 2),
  );
}

type VercelRoute = { src: string; dest: string };

function makeVercelRoute(srcRegex: string, paramNames: string[], funcPath: string): VercelRoute {
  let dest = funcPath;
  if (paramNames.length > 0) {
    dest += '?' + paramNames.map((name, i) => `${name}=$${i + 1}`).join('&');
  }
  return { src: srcRegex, dest };
}

// ─── API routes ───────────────────────────────────────────────────────────────

const apiFiles = walkFiles(SERVER_DIR);
if (apiFiles.length === 0) console.warn(`⚠  No server files found in ${SERVER_DIR}`);

const apiRoutes = apiFiles
  .map(relPath => ({ ...analyzeFile(relPath, 'api'), absPath: path.join(SERVER_DIR, relPath) }))
  .sort((a, b) => b.specificity - a.specificity);

const vercelRoutes: VercelRoute[] = [];

for (const { srcRegex, paramNames, funcPath, absPath } of apiRoutes) {
  console.log(`  building  ${path.relative(SERVER_DIR, absPath)}  →  ${funcPath}`);
  emitVercelFunction(funcPath, await bundleApiHandler(absPath));
  vercelRoutes.push(makeVercelRoute(srcRegex, paramNames, funcPath));
}

// ─── Page routes ──────────────────────────────────────────────────────────────

const builtPages = await buildPages(PAGES_DIR, STATIC_DIR);

for (const { srcRegex, paramNames, funcPath, bundleText } of builtPages) {
  emitVercelFunction(funcPath, bundleText);
  vercelRoutes.push(makeVercelRoute(srcRegex, paramNames, funcPath));
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

await buildReactBundle(STATIC_DIR);
await buildNukeBundle(STATIC_DIR);
copyPublicFiles(PUBLIC_DIR, STATIC_DIR);

console.log(`\n✓ Vercel build complete — ${vercelRoutes.length} function(s) → .vercel/output`);