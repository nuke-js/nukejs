/**
 * builder.ts — NukeJS Package Build Script
 *
 * Compiles the NukeJS source into dist/ via a single esbuild pass targeting
 * Node ESM, followed by processDist() which rewrites bare relative imports
 * (e.g. `from './utils'`) to include .js extensions as required by Node's
 * strict ESM resolver.
 *
 * Finally, `tsc --emitDeclarationOnly` generates .d.ts files for consumers.
 */

import { build } from 'esbuild';
import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, '');
const outDir = path.resolve(__dirname, '../dist');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cleanDist(dir: string): void {
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`🗑️  Cleared ${dir}`);
}

/** Collects all .ts/.tsx/.js/.jsx files under `dir`, skipping `exclude` dirs. */
function collectFiles(dir: string, exclude: string[] = []): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!exclude.includes(entry.name)) files.push(...collectFiles(full, exclude));
    } else if (/\.[tj]sx?$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

// ─── Post-process .js files ───────────────────────────────────────────────────

/** Rewrites bare relative imports to include .js extensions for Node ESM. */
function processDist(dir: string) {
  (function walk(currentDir: string) {
    fs.readdirSync(currentDir, { withFileTypes: true }).forEach((d) => {
      const fullPath = path.join(currentDir, d.name);
      if (d.isDirectory()) {
        walk(fullPath);
      } else if (fullPath.endsWith('.js')) {
        let content = fs.readFileSync(fullPath, 'utf-8');
        content = content.replace(/from\s+['"](\.\/.*?)['"]/g, 'from "$1.js"');
        content = content.replace(/import\(['"](\.\/.*?)['"]\)/g, 'import("$1.js")');
        fs.writeFileSync(fullPath, content, 'utf-8');
      }
    });
  })(dir);

  console.log('🔧 Post-processing done: relative imports → .js extensions.');
}

// ─── Declaration pruning ──────────────────────────────────────────────────────

/**
 * The public API surface: only these stems (relative to src/) get .d.ts files.
 * All other declarations emitted by tsc (internal / private modules) are deleted.
 */
const PUBLIC_STEMS = new Set([
  'index',
  'html-store',   // exported types (TitleValue, LinkTag, MetaTag, …) live here
  'use-html',
  'use-router',
  'use-request',
  'request-store',
  'Link',
  'bundle',
  'utils',
  'logger',
]);

/**
 * Walks dist/ and deletes every .d.ts (and .d.ts.map) whose base stem is not
 * in PUBLIC_STEMS.  tsc always emits declarations for transitively-imported
 * modules, so we prune the unwanted ones after the fact.
 */
function prunePrivateDeclarations(dir: string): void {
  (function walk(currentDir: string) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.d.ts.map')) {
        // Strip all declaration suffixes to get the bare stem
        const stem = entry.name.replace(/\.d\.ts(\.map)?$/, '');
        if (!PUBLIC_STEMS.has(stem)) {
          fs.rmSync(fullPath);
        }
      }
    }
  })(dir);

  console.log('✂️  Pruned private .d.ts files (kept public API only).');
}

// ─── Build ────────────────────────────────────────────────────────────────────

async function runBuild(): Promise<void> {
  try {
    cleanDist(outDir);

    console.log('🚀  Building sources…');
    await build({
      entryPoints: collectFiles(srcDir),
      outdir: outDir,
      platform: 'node',
      format: 'esm',
      target: ['node20'],
      packages: 'external',
    });
    console.log('✅  Build done.');

    processDist(outDir);

    console.log('📄  Generating TypeScript declarations…');
    execSync('tsc --emitDeclarationOnly --declaration --declarationMap false --outDir dist', { stdio: 'inherit' });

    prunePrivateDeclarations(outDir);

    console.log('\n🎉  Build complete → dist/');
  } catch (err) {
    console.error('❌  Build failed:', err);
    process.exit(1);
  }
}

runBuild();