/**
 * http-server.ts — API Route Dispatcher
 *
 * Handles discovery and dispatch of API routes inside `serverDir`.
 *
 * Directory conventions (mirrors Next.js):
 *   server/
 *     users/           → prefix /users  (directory)
 *       index.ts       →   GET /users   (method exports: GET, POST, …)
 *       [id].ts        →   GET /users/:id
 *     auth.ts          → prefix /auth   (top-level file)
 *     index.ts         → prefix /       (root handler)
 *
 * Route handler exports:
 *   export function GET(req, res) { … }
 *   export function POST(req, res) { … }
 *   export default function(req, res) { … }  // matches any method
 *
 * Request augmentation:
 *   req.body    — parsed JSON or raw string (10 MB limit)
 *   req.params  — dynamic route segments (e.g. { id: '42' })
 *   req.query   — URL search params
 *
 * Response augmentation:
 *   res.json(data, status?)  — JSON response shorthand
 *   res.status(code)         — sets statusCode, returns res for chaining
 */

import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';
import { build } from 'esbuild';
import type { IncomingMessage, ServerResponse } from 'http';
import { log } from './logger';
import { matchRoute } from './router';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Describes a single API prefix discovered in serverDir. */
export interface ApiPrefixInfo {
  /** URL prefix this entry handles (e.g. '/users', ''). */
  prefix:     string;
  /** Directory to scan for route files. */
  directory:  string;
  /** Set when the prefix comes from a top-level file (not a directory). */
  filePath?:  string;
}

/** Node's IncomingMessage with parsed body, params, and query. */
export interface ApiRequest extends IncomingMessage {
  params?: Record<string, string | string[]>;
  query?:  Record<string, string>;
  body?:   any;
}

/** Node's ServerResponse with json() and status() convenience methods. */
export interface ApiResponse extends ServerResponse {
  json:   (data: any, status?: number) => void;
  status: (code: number) => ApiResponse;
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS';
type ApiHandler = (req: ApiRequest, res: ApiResponse) => void | Promise<void>;

interface ApiModule {
  default?: ApiHandler;
  GET?:     ApiHandler;
  POST?:    ApiHandler;
  PUT?:     ApiHandler;
  DELETE?:  ApiHandler;
  PATCH?:   ApiHandler;
  OPTIONS?: ApiHandler;
}

// ─── Route discovery ──────────────────────────────────────────────────────────

/**
 * Scans `serverDir` and returns one ApiPrefixInfo per directory, top-level
 * file, and root index.ts.  Directories are returned before same-stem files
 * so `/a/b` routes resolve to the directory tree before any flat file.
 *
 * Called at startup and again whenever the server directory changes (in dev).
 */
export function discoverApiPrefixes(serverDir: string): ApiPrefixInfo[] {
  if (!fs.existsSync(serverDir)) {
    log.warn('Server directory not found:', serverDir);
    return [];
  }

  const entries  = fs.readdirSync(serverDir, { withFileTypes: true });
  const prefixes: ApiPrefixInfo[] = [];

  // Directories first (higher specificity than same-stem files).
  for (const e of entries) {
    if (e.isDirectory()) {
      prefixes.push({ prefix: `/${e.name}`, directory: path.join(serverDir, e.name) });
    }
  }

  // Top-level .ts/.tsx files (excluding index which is handled separately below).
  for (const e of entries) {
    if (
      e.isFile() &&
      (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) &&
      e.name !== 'index.ts' &&
      e.name !== 'index.tsx'
    ) {
      const stem = e.name.replace(/\.tsx?$/, '');
      prefixes.push({
        prefix:    `/${stem}`,
        directory: serverDir,
        filePath:  path.join(serverDir, e.name),
      });
    }
  }

  // index.ts/tsx at the root of serverDir handles unmatched paths (prefix '').
  if (fs.existsSync(path.join(serverDir, 'index.ts'))) {
    prefixes.push({ prefix: '', directory: serverDir });
  }

  return prefixes;
}

// ─── Body parsing ─────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Buffers the request body and returns:
 *   - Parsed JSON object if Content-Type is application/json.
 *   - Raw string otherwise.
 *
 * Rejects with an error if the body exceeds MAX_BODY_BYTES to prevent
 * memory exhaustion attacks.  Deletes __proto__ and constructor from parsed
 * JSON objects to guard against prototype pollution.
 */
export async function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body  = '';
    let bytes = 0;

    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        return reject(new Error('Request body too large'));
      }
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        if (body && req.headers['content-type']?.includes('application/json')) {
          const parsed = JSON.parse(body);
          // Guard against prototype pollution via __proto__ / constructor.
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            delete parsed.__proto__;
            delete parsed.constructor;
          }
          resolve(parsed);
        } else {
          resolve(body);
        }
      } catch (err) {
        reject(err);
      }
    });

    req.on('error', reject);
  });
}

// ─── Query parsing ────────────────────────────────────────────────────────────

/** Extracts URL search params into a plain string map. */
export function parseQuery(url: string, port: number): Record<string, string> {
  const query: Record<string, string> = {};
  new URL(url, `http://localhost:${port}`)
    .searchParams
    .forEach((v, k) => { query[k] = v; });
  return query;
}

// ─── Response enhancement ─────────────────────────────────────────────────────

/**
 * Adds `json()` and `status()` convenience methods to a raw ServerResponse,
 * mirroring the Express API surface that most API handlers expect.
 */
export function enhanceResponse(res: ServerResponse): ApiResponse {
  const apiRes    = res as ApiResponse;
  apiRes.json   = function (data, statusCode = 200) {
    this.statusCode = statusCode;
    this.setHeader('Content-Type', 'application/json');
    this.end(JSON.stringify(data));
  };
  apiRes.status = function (code) {
    this.statusCode = code;
    return this;
  };
  return apiRes;
}

/** Responds to an OPTIONS preflight with permissive CORS headers. */
function respondOptions(res: ApiResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.statusCode = 204;
  res.end();
}

// ─── Prefix matching ──────────────────────────────────────────────────────────

/**
 * Finds the first ApiPrefixInfo whose prefix is a prefix of `url`.
 *
 * The empty-string prefix ('') acts as a catch-all and only matches when no
 * other prefix claims the URL.
 *
 * Returns `null` when no prefix matches (request should fall through to SSR).
 */
export function matchApiPrefix(
  url: string,
  apiPrefixes: ApiPrefixInfo[],
): { prefix: ApiPrefixInfo; apiPath: string } | null {
  for (const prefix of apiPrefixes) {
    if (prefix.prefix === '') {
      // Empty prefix — only match if no other prefix has claimed this URL.
      const claimedByOther = apiPrefixes.some(
        p => p.prefix !== '' && url.startsWith(p.prefix),
      );
      if (!claimedByOther) return { prefix, apiPath: url || '/' };
    } else if (url.startsWith(prefix.prefix)) {
      return { prefix, apiPath: url.slice(prefix.prefix.length) || '/' };
    }
  }
  return null;
}

// ─── Dev-mode handler importer ────────────────────────────────────────────────

// ─── Dev-mode fresh importer ──────────────────────────────────────────────────

/**
 * Bundles `filePath` + all its local transitive imports into a single ESM
 * string via esbuild on every call, writes it to a unique temp file, imports
 * it, then deletes the temp file.
 *
 * Why esbuild bundling and not ?t=timestamp:
 *   Node's ESM cache is keyed on the full URL string. ?t=timestamp busts only
 *   the entry file — every `import './other'` inside it resolves from cache as
 *   normal. Bundling inlines all local deps so there are no transitive cache
 *   hits at all. npm packages are kept external (packages: 'external') because
 *   they live in node_modules and never change between requests.
 */
async function importFreshInDev(filePath: string): Promise<ApiModule> {
  const result = await build({
    entryPoints: [filePath],
    bundle:      true,
    format:      'esm',
    platform:    'node',
    target:      'node20',
    packages:    'external',
    write:       false,
  });

  const dataUrl = `data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`;
  return await import(dataUrl) as ApiModule;
}

// ─── Request handler factory ──────────────────────────────────────────────────

interface ApiHandlerOptions {
  apiPrefixes: ApiPrefixInfo[];
  port:        number;
  isDev:       boolean;
}

export function createApiHandler({ apiPrefixes, port, isDev }: ApiHandlerOptions) {
  return async function handleApiRoute(
    url: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const apiRes    = enhanceResponse(res);
    const apiMatch  = matchApiPrefix(url, apiPrefixes);

    if (!apiMatch) {
      apiRes.json({ error: 'API endpoint not found' }, 404);
      return;
    }

    const { prefix, apiPath } = apiMatch;
    let filePath: string | null = null;
    let params:   Record<string, string | string[]> = {};

    // 1. Direct file match (top-level file prefix, e.g. server/auth.ts → /auth).
    if (prefix.filePath) {
      filePath = prefix.filePath;
    }

    // 2. Root index.ts (prefix === '' and path === '/').
    if (!filePath && prefix.prefix === '' && apiPath === '/') {
      const indexPath = path.join(prefix.directory, 'index.ts');
      if (fs.existsSync(indexPath)) filePath = indexPath;
    }

    // 3. Dynamic route matching inside the prefix directory.
    if (!filePath) {
      const routeMatch =
        matchRoute(apiPath, prefix.directory, '.ts') ??
        matchRoute(apiPath, prefix.directory, '.tsx');
      if (routeMatch) { filePath = routeMatch.filePath; params = routeMatch.params; }
    }

    if (!filePath) {
      apiRes.json({ error: 'API endpoint not found' }, 404);
      return;
    }

    try {
      const method = (req.method || 'GET').toUpperCase() as HttpMethod;
      log.verbose(`API ${method} ${url} -> ${path.relative(process.cwd(), filePath)}`);

      // OPTIONS preflight — respond immediately with CORS headers.
      if (method === 'OPTIONS') { respondOptions(apiRes); return; }

      // Augment the request object with parsed body, params, and query.
      const apiReq    = req as ApiRequest;
      apiReq.body   = await parseBody(req);
      apiReq.params = params;
      apiReq.query  = parseQuery(url, port);

      const apiModule: ApiModule = isDev
        ? await importFreshInDev(filePath)
        : await import(pathToFileURL(filePath).href);
      const handler = apiModule[method] ?? apiModule.default;

      if (!handler) {
        apiRes.json({ error: `Method ${method} not allowed` }, 405);
        return;
      }

      await handler(apiReq, apiRes);
    } catch (error) {
      log.error('API Error:', error);
      apiRes.json({ error: 'Internal server error' }, 500);
    }
  };
}