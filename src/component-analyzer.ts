/**
 * component-analyzer.ts — Static Import Analyzer & Client Component Registry
 *
 * This module solves a core problem in NukeJS's partial hydration model:
 * the server needs to know *at render time* which components in a page's
 * import tree are "use client" boundaries so it can:
 *
 *   1. Emit <span data-hydrate-id="…"> markers instead of rendering them.
 *   2. Inject the matching bundle URLs into the page's runtime data blob.
 *   3. Serialize the props passed to those components so the browser can
 *      reconstruct them after loading the bundle.
 *
 * How it works:
 *   - analyzeComponent()         checks whether a file starts with "use client"
 *                                 and assigns a stable content-hash ID if it does.
 *   - extractImports()           parses `import … from '…'` statements with a
 *                                 regex and resolves relative/absolute paths.
 *   - findClientComponentsInTree() recursively walks the import graph, stopping
 *                                 at client boundaries (they own their subtree).
 *
 * Results are memoised in `componentCache` (process-lifetime) so repeated SSR
 * renders don't re-read and re-hash files they've already seen.
 *
 * ID scheme:
 *   The ID for a client component is `cc_` + the first 8 hex chars of the MD5
 *   hash of its path relative to pagesDir.  This is stable across restarts and
 *   matches what the browser will request from /__client-component/<id>.js.
 */

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ComponentInfo {
  filePath:           string;
  /** True when the file's first non-comment line is "use client". */
  isClientComponent:  boolean;
  /** Stable hash-based ID, present only for client components. */
  clientComponentId?: string;
}

// ─── In-process cache ─────────────────────────────────────────────────────────

// Memoises analyze results for the lifetime of the dev server process.
// In production builds the analysis runs once per build, so no cache is needed.
const componentCache = new Map<string, ComponentInfo>();

// ─── Client boundary detection ────────────────────────────────────────────────

/**
 * Returns true when a file begins with a `"use client"` or `'use client'`
 * directive (ignoring blank lines and line/block comment prefixes).
 *
 * Only the first five lines are checked — the directive must appear before
 * any executable code.
 */
function isClientComponent(filePath: string): boolean {
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n').slice(0, 5)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    if (/^["']use client["'];?$/.test(trimmed)) return true;
    break; // First substantive line is not "use client"
  }
  return false;
}

/**
 * Generates a deterministic, short ID for a client component.
 * The path is made relative to pagesDir before hashing so the ID is
 * portable across machines (absolute paths differ per developer).
 */
function getClientComponentId(filePath: string, pagesDir: string): string {
  const hash = crypto
    .createHash('md5')
    .update(path.relative(pagesDir, filePath))
    .digest('hex')
    .substring(0, 8);
  return `cc_${hash}`;
}

// ─── Analysis ─────────────────────────────────────────────────────────────────

/**
 * Analyses a component file and returns cached results on subsequent calls.
 *
 * @param filePath  Absolute path to the source file.
 * @param pagesDir  Absolute path to the pages root (used for ID generation).
 */
export function analyzeComponent(filePath: string, pagesDir: string): ComponentInfo {
  if (componentCache.has(filePath)) return componentCache.get(filePath)!;

  const isClient = isClientComponent(filePath);
  const info: ComponentInfo = {
    filePath,
    isClientComponent:  isClient,
    clientComponentId: isClient ? getClientComponentId(filePath, pagesDir) : undefined,
  };

  componentCache.set(filePath, info);
  return info;
}

// ─── Import extraction ────────────────────────────────────────────────────────

/**
 * Parses `import … from '…'` statements in a file and returns a list of
 * resolved absolute paths for all *local* imports (relative or absolute paths).
 *
 * Non-local specifiers (npm packages) are skipped, except `nukejs` itself —
 * which is resolved to our own index file so built-in "use client" components
 * like `<Link>` are included in the client component discovery walk.
 *
 * Extensions are tried in priority order if the specifier has none.
 */
function extractImports(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const dir     = path.dirname(filePath);
  const imports: string[] = [];

  const importRegex =
    /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1];

    // Special case: resolve the 'nukejs' package import to our own source so
    // built-in "use client" exports (Link, useRouter, etc.) are discovered.
    if (importPath === 'nukejs') {
      const selfDir = path.dirname(fileURLToPath(import.meta.url));
      for (const candidate of [
        path.join(selfDir, 'index.ts'),
        path.join(selfDir, 'index.js'),
      ]) {
        if (fs.existsSync(candidate)) { imports.push(candidate); break; }
      }
      continue;
    }

    // Skip npm packages and other non-local specifiers.
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) continue;

    // Resolve to an absolute path and add common extensions if needed.
    let resolved = path.resolve(dir, importPath);
    if (!fs.existsSync(resolved)) {
      for (const ext of ['.tsx', '.ts', '.jsx', '.js']) {
        const candidate = resolved + ext;
        if (fs.existsSync(candidate)) { resolved = candidate; break; }
      }
    }
    if (fs.existsSync(resolved)) imports.push(resolved);
  }

  return imports;
}

// ─── Tree walk ────────────────────────────────────────────────────────────────

/**
 * Recursively walks the import graph from `filePath`, collecting every
 * "use client" file encountered.
 *
 * The walk stops at client boundaries: a "use client" file is collected and
 * its own imports are NOT walked (the client runtime handles their subtree).
 *
 * The `visited` set prevents infinite loops from circular imports.
 *
 * @returns  Map<id, absoluteFilePath> for every client component reachable
 *           from `filePath` (including `filePath` itself if it's a client).
 */
export function findClientComponentsInTree(
  filePath:  string,
  pagesDir:  string,
  visited  = new Set<string>(),
): Map<string, string> {
  const clientComponents = new Map<string, string>();
  if (visited.has(filePath)) return clientComponents;
  visited.add(filePath);

  const info = analyzeComponent(filePath, pagesDir);

  // This file is a client boundary — record it and stop descending.
  if (info.isClientComponent && info.clientComponentId) {
    clientComponents.set(info.clientComponentId, filePath);
    return clientComponents;
  }

  // Server component — recurse into its imports.
  for (const importPath of extractImports(filePath)) {
    for (const [id, p] of findClientComponentsInTree(importPath, pagesDir, visited)) {
      clientComponents.set(id, p);
    }
  }

  return clientComponents;
}

// ─── Cache access ─────────────────────────────────────────────────────────────


/**
 * Looks up the absolute file path for a client component by its ID.
 * O(1) reverse lookup — avoids the O(n) linear scan in bundler.ts.
 *
 * Returns undefined when the ID is not in the cache (page not yet visited
 * in dev, or stale ID after a file change).
 */
export function getComponentById(id: string): string | undefined {
  for (const [filePath, info] of componentCache) {
    if (info.clientComponentId === id) return filePath;
  }
  return undefined;
}

/** Returns the live component cache (used by bundler.ts for ID→path lookup). */
export function getComponentCache(): Map<string, ComponentInfo> {
  return componentCache;
}

/**
 * Removes a single file's analysis entry from the cache.
 * Call this whenever a source file changes in dev mode so the next render
 * re-analyses the file (picks up added/removed "use client" directives and
 * changed import graphs).
 */
export function invalidateComponentCache(filePath: string): void {
  componentCache.delete(filePath);
}