/**
 * router.ts — File-System Based URL Router
 *
 * Maps incoming URL paths to handler files using Next.js-compatible conventions:
 *
 *   server/users/index.ts          → /users
 *   server/users/[id].ts           → /users/:id          (dynamic segment)
 *   server/users/[[id]].ts         → /users or /users/42  (optional single)
 *   server/blog/[...slug].ts       → /blog/*              (required catch-all)
 *   server/files/[[...path]].ts    → /files or /files/*   (optional catch-all)
 *
 * Route specificity (higher score wins):
 *   static segment      +5   (e.g. 'about')
 *   [dynamic]           +4   (e.g. '[id]')
 *   [[optional]]        +3   (e.g. '[[id]]')
 *   [...catchAll]       +2   (e.g. '[...slug]')
 *   [[...optCatchAll]]  +1   (e.g. '[[...path]]')
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
 * Recursively collects all routable .ts/.tsx files in `dir`, returning paths
 * relative to `baseDir` without the file extension.
 *
 * layout.tsx files are excluded — they wrap pages but are never routes
 * themselves.  This mirrors the filter in collectServerPages() so dev-mode
 * route matching behaves identically to the production build.
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
      const stem = entry.name.replace(/\.(tsx|ts)$/, '');
      if (stem === 'layout') continue;
      routes.push(path.relative(baseDir, fullPath).replace(/\.(tsx|ts)$/, ''));
    }
  }
  return routes;
}

// ─── Dynamic segment matching ─────────────────────────────────────────────────

/**
 * Attempts to match `urlSegments` against a route that may contain dynamic
 * segments ([param]), optional single segments ([[param]]), catch-alls
 * ([...slug]), and optional catch-alls ([[...path]]).
 *
 * Returns the captured params on success, or null if the route does not match.
 *
 * Param value types:
 *   [param]       → string          (required)
 *   [[param]]     → string          (optional, '' when absent)
 *   [...slug]     → string[]        (required, ≥1 segment)
 *   [[...path]]   → string[]        (optional, may be empty)
 */
export function matchDynamicRoute(
  urlSegments: string[],
  routePath:   string,
): { params: Record<string, string | string[]> } | null {
  const routeSegments = routePath.split(path.sep);

  // 'index' at the end means the route handles the parent directory URL.
  if (routeSegments.at(-1) === 'index') routeSegments.pop();

  const params: Record<string, string | string[]> = {};
  let ri = 0; // route segment index
  let ui = 0; // URL segment index

  while (ri < routeSegments.length) {
    const seg = routeSegments[ri];

    // [[...name]] — optional catch-all: consumes zero or more remaining segments.
    const optCatchAll = seg.match(/^\[\[\.\.\.(.+)\]\]$/);
    if (optCatchAll) {
      params[optCatchAll[1]] = urlSegments.slice(ui);
      return { params };
    }

    // [[name]] — optional single: consumes zero or one segment.
    const optDynamic = seg.match(/^\[\[([^.][^\]]*)\]\]$/);
    if (optDynamic) {
      params[optDynamic[1]] = ui < urlSegments.length ? urlSegments[ui++] : '';
      ri++;
      continue;
    }

    // [...name] — required catch-all: must consume at least one segment.
    const catchAll = seg.match(/^\[\.\.\.(.+)\]$/);
    if (catchAll) {
      const remaining = urlSegments.slice(ui);
      if (!remaining.length) return null;
      params[catchAll[1]] = remaining;
      return { params };
    }

    // [name] — required single: consumes exactly one segment.
    const dynamic = seg.match(/^\[(.+)\]$/);
    if (dynamic) {
      if (ui >= urlSegments.length) return null;
      params[dynamic[1]] = urlSegments[ui++];
      ri++;
      continue;
    }

    // Static — must match exactly.
    if (ui >= urlSegments.length || seg !== urlSegments[ui]) return null;
    ui++; ri++;
  }

  // All route segments consumed — URL must also be fully consumed.
  return ui < urlSegments.length ? null : { params };
}

// ─── Specificity scoring ──────────────────────────────────────────────────────

/**
 * Computes a specificity score for a route path.
 * Used to sort candidate routes so more specific routes shadow less specific ones.
 * Higher score = more specific.
 */
export function getRouteSpecificity(routePath: string): number {
  return routePath.split(path.sep).reduce((score, seg) => {
    if (seg.match(/^\[\[\.\.\.(.+)\]\]$/))   return score + 1; // [[...a]] optional catch-all
    if (seg.match(/^\[\.\.\.(.+)\]$/))        return score + 2; // [...a]   required catch-all
    if (seg.match(/^\[\[([^.][^\]]*)\]\]$/))  return score + 3; // [[a]]    optional single
    if (seg.match(/^\[(.+)\]$/))              return score + 4; // [a]      required single
    return score + 5;                                           // static segment
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
 *      layout.tsx is explicitly excluded from exact matching.
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
  const rawSegments = urlPath === '/' ? [] : urlPath.slice(1).split('/');
  if (rawSegments.some(s => s === '..' || s === '.')) return null;

  const segments = rawSegments.length === 0 ? ['index'] : rawSegments;

  // 1. Exact match: /about → about.tsx — never resolve to a layout file.
  const exactPath = path.join(baseDir, ...segments) + extension;
  if (
    isWithinBase(baseDir, exactPath) &&
    path.basename(exactPath, extension) !== 'layout' &&
    fs.existsSync(exactPath)
  ) {
    return { filePath: exactPath, params: {}, routePattern: segments.join('/') };
  }

  // 2. Dynamic match — try routes sorted by specificity.
  const sortedRoutes = findAllRoutes(baseDir).sort(
    (a, b) => getRouteSpecificity(b) - getRouteSpecificity(a),
  );

  for (const route of sortedRoutes) {
    const match = matchDynamicRoute(segments, route);
    if (!match) continue;
    const filePath = path.join(baseDir, route) + extension;
    if (isWithinBase(baseDir, filePath) && fs.existsSync(filePath)) {
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
 * Outermost-first order matches how wrapWithLayouts() nests them:
 * the last layout in the array is the innermost wrapper.
 */
export function findLayoutsForRoute(routeFilePath: string, pagesDir: string): string[] {
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
