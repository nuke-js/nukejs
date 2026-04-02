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
 *   req.json()   — parse body as JSON (10 MB limit, prototype-pollution guard)
 *   req.text()   — read body as a UTF-8 string (10 MB limit)
 *   req.buffer() — read body as a raw Buffer (10 MB limit)
 *   req.params   — dynamic route segments (e.g. { id: '42' })
 *   req.query    — URL search params
 *
 *   For multipart/form-data (file uploads) pipe req directly into a parser:
 *     import busboy from 'busboy';
 *     const bb = busboy({ headers: req.headers });
 *     req.pipe(bb);
 *
 * Response augmentation:
 *   res.json(data, status?)  — JSON response shorthand
 *   res.status(code)         — sets statusCode, returns res for chaining
 */

import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';
import type { IncomingMessage, ServerResponse } from 'http';
import { log } from './logger';
import { matchRoute } from './router';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Describes a single API prefix discovered in serverDir. */
export interface ApiPrefixInfo {
  /** URL prefix this entry handles (e.g. '/users', ''). */
  prefix: string;
  /** Directory to scan for route files. */
  directory: string;
  /** Set when the prefix comes from a top-level file (not a directory). */
  filePath?: string;
}

/** Node's IncomingMessage with body helpers, params, and query. */
export interface ApiRequest extends IncomingMessage {
  params?: Record<string, string | string[]>;
  query?: Record<string, string>;
  /** Parse the request body as JSON. Rejects if the body exceeds 10 MB or is not valid JSON. */
  json<T = any>(): Promise<T>;
  /** Read the request body as a UTF-8 string. Rejects if the body exceeds 10 MB. */
  text(): Promise<string>;
  /** Read the request body as a raw Buffer. Rejects if the body exceeds 10 MB. */
  buffer(): Promise<Buffer>;
}

/** Node's ServerResponse with json() and status() convenience methods. */
export interface ApiResponse extends ServerResponse {
  json: (data: any, status?: number) => void;
  status: (code: number) => ApiResponse;
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS';
type ApiHandler = (req: ApiRequest, res: ApiResponse) => void | Promise<void>;

interface ApiModule {
  default?: ApiHandler;
  GET?: ApiHandler;
  POST?: ApiHandler;
  PUT?: ApiHandler;
  DELETE?: ApiHandler;
  PATCH?: ApiHandler;
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

  const entries = fs.readdirSync(serverDir, { withFileTypes: true });
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
        prefix: `/${stem}`,
        directory: serverDir,
        filePath: path.join(serverDir, e.name),
      });
    }
  }

  // index.ts/tsx at the root of serverDir handles unmatched paths (prefix '').
  if (fs.existsSync(path.join(serverDir, 'index.ts'))) {
    prefixes.push({ prefix: '', directory: serverDir });
  }

  return prefixes;
}

// ─── Request enhancement ──────────────────────────────────────────────────────

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Collects the raw request body into a Buffer, enforcing MAX_BODY_BYTES.
 * All higher-level helpers (json, text) are built on top of this.
 */
function collectBuffer(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;

    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        return reject(new Error('Request body too large'));
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Attaches lazy body-reading helpers to the request object.
 * Nothing is read from the stream until the handler calls one of them.
 *
 *   req.json()   — parse body as JSON (prototype-pollution guard included)
 *   req.text()   — body as a UTF-8 string
 *   req.buffer() — body as a raw Buffer (safe for binary / multipart)
 *
 * For multipart/form-data, skip these helpers entirely and pipe req into
 * a dedicated parser (busboy, formidable, etc.) — the stream is untouched.
 */
export function enhanceRequest(req: IncomingMessage): ApiRequest {
  const apiReq = req as ApiRequest;

  // Memoize: the stream can only be consumed once, so cache the Buffer
  // Promise and re-use it across multiple calls to json/text/buffer.
  let bufferPromise: Promise<Buffer> | null = null;
  const getBuffer = () => {
    if (!bufferPromise) bufferPromise = collectBuffer(req);
    return bufferPromise;
  };

  apiReq.buffer = () => getBuffer();

  apiReq.text = () => getBuffer().then(buf => buf.toString('utf8'));

  apiReq.json = () =>
    getBuffer().then(buf => {
      const parsed = JSON.parse(buf.toString('utf8'));
      // Guard against prototype pollution via __proto__ / constructor.
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        delete parsed.__proto__;
        delete parsed.constructor;
      }
      return parsed;
    });

  return apiReq;
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
  const apiRes = res as ApiResponse;
  apiRes.json = function (data, statusCode = 200) {
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

// ─── Dev-mode fresh importer ──────────────────────────────────────────────────

/**
 * Imports `filePath` fresh on every call using tsx's tsImport, which creates
 * an isolated module namespace that bypasses Node's ESM cache entirely.
 *
 * This is identical to how ssr.ts loads page and layout modules in dev mode.
 * tsx handles TypeScript and TSX natively, and bare specifiers (e.g.
 * "@orpc/server/node") resolve normally through the standard node_modules
 * chain — no bundling, no temp files, no watchers needed.
 */
async function importFreshInDev(filePath: string): Promise<ApiModule> {
  const { tsImport } = await import('tsx/esm/api');
  return await tsImport(
    pathToFileURL(filePath).href,
    { parentURL: import.meta.url },
  ) as ApiModule;
}

// ─── Request handler factory ──────────────────────────────────────────────────

interface ApiHandlerOptions {
  apiPrefixes: ApiPrefixInfo[];
  port: number;
  isDev: boolean;
}

export function createApiHandler({ apiPrefixes, port, isDev }: ApiHandlerOptions) {
  return async function handleApiRoute(
    url: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const apiRes = enhanceResponse(res);
    const apiMatch = matchApiPrefix(url, apiPrefixes);

    if (!apiMatch) {
      apiRes.json({ error: 'API endpoint not found' }, 404);
      return;
    }

    const { prefix, apiPath } = apiMatch;
    let filePath: string | null = null;
    let params: Record<string, string | string[]> = {};

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

      // Augment the request object with body helpers, params, and query.
      const apiReq = enhanceRequest(req);
      apiReq.params = params;
      apiReq.query = parseQuery(url, port);

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