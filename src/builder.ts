/**
 * builder.ts — NukeJS Package Build Script
 *
 * Compiles the NukeJS source into dist/ with two separate esbuild passes:
 *
 *   Pass 1 (main):  All src/ files excluding as-is/, compiled to Node ESM.
 *   Pass 2 (as-is): Link.tsx + useRouter.ts compiled to browser-neutral ESM,
 *                   then the original .ts/.tsx sources are also copied into
 *                   dist/as-is/ so end-users can reference them directly.
 *
 * After both passes, processDist() rewrites bare relative imports
 * (e.g. `from './utils'`) to include .js extensions, which is required for
 * Node's strict ESM resolver.
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
const AS_IS = 'as-is';

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

/**
 * Copies a directory recursively, preserving structure.
 * Used to place the original as-is .ts/.tsx sources into dist/as-is/
 * so end-users can read and copy them.
 */
function copyDir(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    entry.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

// --- Post-process .js files ---
function processDist(dir: string) {
  const excludeFolder = "as-is";

  (function walk(currentDir: string) {
    fs.readdirSync(currentDir, { withFileTypes: true }).forEach((d) => {
      const fullPath = path.join(currentDir, d.name);

      if (d.isDirectory()) {
        if (d.name !== excludeFolder) walk(fullPath);
      } else if (fullPath.endsWith(".js")) {
        let content = fs.readFileSync(fullPath, "utf-8");

        // Replace import/export paths ending with .ts → .js, skip paths containing excludeFolder
        content = content.replace(
          /from\s+['"](\.\/(?!as-is\/).*?)['"]/g,
          'from "$1.js"'
        );
        content = content.replace(
          /import\(['"](\.\/(?!as-is\/).*?)['"]\)/g,
          'import("$1.js")'
        );

        fs.writeFileSync(fullPath, content, "utf-8");
      }
    });
  })(dir);

  console.log("🔧 Post-processing done: .ts imports → .js (excluding as-is folder).");
}

// ─── Build ────────────────────────────────────────────────────────────────────

async function runBuild(): Promise<void> {
  try {
    cleanDist(outDir);

    // Pass 1: main source (Node platform, no JSX needed)
    console.log('🚀  Building main sources…');
    await build({
      entryPoints: collectFiles(srcDir, [AS_IS]),
      outdir: outDir,
      platform: 'node',
      format: 'esm',
      target: ['node20'],
      packages: 'external',
      sourcemap: true,
    });
    console.log('✅  Main build done.');

    // Pass 2: as-is sources (browser-neutral, needs JSX)
    console.log('🚀  Building as-is sources…');
    await build({
      entryPoints: collectFiles(path.join(srcDir, AS_IS)),
      outdir: path.join(outDir, AS_IS),
      platform: 'neutral',
      format: 'esm',
      target: ['node20'],
      packages: 'external',
      jsx: 'automatic',
      sourcemap: true,
    });
    console.log('✅  as-is build done.');

    // Copy original .ts/.tsx sources into dist/as-is/ for end-user reference
    copyDir(path.join(srcDir, AS_IS), path.join(outDir, AS_IS));
    console.log(`📁  Copied as-is sources → dist/${AS_IS}/`);

    // Fix ESM import extensions across all compiled output
    processDist(outDir);

    // Emit .d.ts declaration files
    console.log('📄  Generating TypeScript declarations…');
    execSync('tsc --emitDeclarationOnly --declaration --outDir dist', { stdio: 'inherit' });

    console.log('\n🎉  Build complete → dist/');
  } catch (err) {
    console.error('❌  Build failed:', err);
    process.exit(1);
  }
}

runBuild();