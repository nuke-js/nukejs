/**
 * router.ts — File-System Based URL Router
 *
 * Maps incoming URL paths to handler files using Next.js-compatible conventions:
 *
 *   server/users/index.ts          → /users
 *   server/users/[id].ts           → /users/:id         (dynamic segment)
 *   server/blog/[...slug].ts       → /blog/*            (catch-all)
 *   server/files/[[...path]].ts    → /files or /files/* (optional catch-all)
 *
 * Route specificity (higher = wins over lower):
 *   static segment     +4   (e.g. 'about')
 *   dynamic segment    +3   (e.g. '[id]')
 *   catch-all          +2   (e.g. '[...slug]')
 *   optional catch-all +1   (e.g. '[[...path]]')
 *
 * Path traversal protection:
 *   matchRoute() rejects URL segments that contain '..' or '.' and verifies
 *   that the resolved file path stays inside the base directory before
 *   checking whether the file exists.
 */

import path from 'path';
import fs   from 'fs';

// ─── Route file discovery ─────────────────────────────────────────────────────

/**
 * Recursively collects all .ts/.tsx files in `dir`, returning paths relative to
 * `baseDir` without the file extension.
 *
 * Example output: ['index', 'users/index', 'users/[id]', 'blog/[...slug]']
 */
export function findAllRoutes(dir: string, baseDir: string = dir): string[] {
  if (!fs.existsSync(dir)) return [];

  const routes: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      routes.push(...findAllRoutes(fullPath, baseDir));
    } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
      routes.push(path.relative(baseDir, fullPath).replace(/\.(tsx|ts)$/, ''));
    }
  }
  return routes;
}

// ─── Dynamic segment matching ─────────────────────────────────────────────────

/**
 * Attempts to match `urlSegments` against a route that may contain dynamic
 * segments ([param]), catch-alls ([...slug]), and optional catch-alls ([[...path]]).
 *
 * Returns the captured params on success, or null if the route does not match.
 *
 * Param value types:
 *   [param]         → string
 *   [...slug]       → string[]  (at least one segment required)
 *   [[...path]]     → string[]  (zero or more segments)
 */
export function matchDynamicRoute(
  urlSegments:  string[],
  routePath:    string,
): { params: Record<string, string | string[]> } | null {
  const routeSegments = routePath.split(path.sep);

  // 'index' at the end of a route path means the route handles the parent directory URL.
  if (routeSegments.at(-1) === 'index') routeSegments.pop();

  const params: Record<string, string | string[]> = {};
  let ri = 0; // route segment index
  let ui = 0; // URL segment index

  while (ri < routeSegments.length) {
    const seg = routeSegments[ri];

    // [[...name]] — optional catch-all: consumes zero or more remaining URL segments.
    const optCatchAll = seg.match(/^\[\[\.\.\.(.+)\]\]$/);
    if (optCatchAll) {
      params[optCatchAll[1]] = urlSegments.slice(ui);
      return { params };
    }

    // [...name] — required catch-all: must consume at least one URL segment.
    const catchAll = seg.match(/^\[\.\.\.(.+)\]$/);
    if (catchAll) {
      const remaining = urlSegments.slice(ui);
      if (!remaining.length) return null;
      params[catchAll[1]] = remaining;
      return { params };
    }

    // [name] — single dynamic segment: consumes exactly one URL segment.
    const dynamic = seg.match(/^\[(.+)\]$/);
    if (dynamic) {
      if (ui >= urlSegments.length) return null;
      params[dynamic[1]] = urlSegments[ui++];
      ri++;
      continue;
    }

    // Static segment — must match exactly.
    if (ui >= urlSegments.length || seg !== urlSegments[ui]) return null;
    ui++; ri++;
  }

  // All route segments consumed — URL must be fully consumed too.
  return ui < urlSegments.length ? null : { params };
}

// ─── Specificity scoring ──────────────────────────────────────────────────────

/**
 * Computes a specificity score for a route path.
 * Used to sort candidate routes so more specific routes shadow catch-alls.
 *
 * Higher score = more specific:
 *   static segment      4
 *   [dynamic]           3
 *   [...catchAll]       2
 *   [[...optCatchAll]]  1
 */
export function getRouteSpecificity(routePath: string): number {
  return routePath.split(path.sep).reduce((score, seg) => {
    if (seg.match(/^\[\[\.\.\.(.+)\]\]$/)) return score + 1;
    if (seg.match(/^\[\.\.\.(.+)\]$/))     return score + 2;
    if (seg.match(/^\[(.+)\]$/))           return score + 3;
    return score + 4; // static segment
  }, 0);
}

// ─── Route match result ───────────────────────────────────────────────────────

export interface RouteMatch {
  filePath:     string;
  params:       Record<string, string | string[]>;
  routePattern: string;
}

// ─── Path traversal guard ─────────────────────────────────────────────────────

/**
 * Returns true only when `filePath` is a descendant of `baseDir`.
 * Used to prevent URL path traversal attacks (e.g. /../../etc/passwd).
 */
function isWithinBase(baseDir: string, filePath: string): boolean {
  const rel = path.relative(baseDir, filePath);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ─── Route matching ───────────────────────────────────────────────────────────

/**
 * Resolves a URL path to a route file inside `baseDir`.
 *
 * Steps:
 *   1. Reject '..' or '.' path segments (path traversal guard).
 *   2. Try an exact file match (e.g. /about → baseDir/about.tsx).
 *   3. Sort all discovered routes by specificity (most specific first).
 *   4. Return the first dynamic route that matches.
 *
 * @param urlPath   The URL path to match (e.g. '/users/42').
 * @param baseDir   Absolute path to the directory containing route files.
 * @param extension File extension to look for ('.tsx' or '.ts').
 */
export function matchRoute(
  urlPath:   string,
  baseDir:   string,
  extension = '.tsx',
): RouteMatch | null {
  // Split the URL path into segments, rejecting any that attempt path traversal.
  const rawSegments = urlPath === '/' ? [] : urlPath.slice(1).split('/');
  if (rawSegments.some(s => s === '..' || s === '.')) return null;

  // For the root URL, look for an index file.
  const segments = rawSegments.length === 0 ? ['index'] : rawSegments;

  // 1. Exact match: /about → about.tsx
  const exactPath = path.join(baseDir, ...segments) + extension;
  if (!isWithinBase(baseDir, exactPath)) return null;
  if (fs.existsSync(exactPath)) {
    return { filePath: exactPath, params: {}, routePattern: segments.join('/') };
  }

  // 2. Dynamic match — try routes sorted by specificity so '[id]' wins over '[...all]'.
  const sortedRoutes = findAllRoutes(baseDir).sort(
    (a, b) => getRouteSpecificity(b) - getRouteSpecificity(a),
  );

  for (const route of sortedRoutes) {
    const match = matchDynamicRoute(segments, route);
    if (!match) continue;
    const filePath = path.join(baseDir, route) + extension;
    if (!isWithinBase(baseDir, filePath)) continue;
    if (fs.existsSync(filePath)) {
      return { filePath, params: match.params, routePattern: route };
    }
  }

  return null;
}

// ─── Layout discovery ─────────────────────────────────────────────────────────

/**
 * Returns every layout.tsx file that wraps a given route file, in
 * outermost-first order (root layout first, nearest layout last).
 *
 * Layout chain example for app/pages/blog/[slug]/page.tsx:
 *   app/pages/layout.tsx          ← root layout
 *   app/pages/blog/layout.tsx     ← blog section layout
 *
 * The outermost-first order matches how wrapWithLayouts() nests them:
 * the last layout in the array is the innermost wrapper.
 */
export function findLayoutsForRoute(routeFilePath: string, pagesDir: string): string[] {
  const layouts: string[] = [];

  // Root layout wraps everything.
  const rootLayout = path.join(pagesDir, 'layout.tsx');
  if (fs.existsSync(rootLayout)) layouts.push(rootLayout);

  // Walk the directory hierarchy from pagesDir to the file's parent.
  const relativePath = path.relative(pagesDir, path.dirname(routeFilePath));
  if (!relativePath || relativePath === '.') return layouts;

  const segments = relativePath.split(path.sep).filter(s => s !== '.');
  for (let i = 1; i <= segments.length; i++) {
    const layoutPath = path.join(pagesDir, ...segments.slice(0, i), 'layout.tsx');
    if (fs.existsSync(layoutPath)) layouts.push(layoutPath);
  }

  return layouts;
}
