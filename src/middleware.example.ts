/**
 * middleware.ts (place in project root)
 *
 * Runs before every request. Inspect/modify req, add headers, or send early
 * responses to halt further processing.
 */

import type { IncomingMessage, ServerResponse } from 'http';

export default async function middleware(req: IncomingMessage, res: ServerResponse): Promise<void> {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  if (req.url?.startsWith('/admin') && !isAuthenticated(req)) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'text/html');
    res.end('<h1>401 Unauthorized</h1><p>Please log in to access this page.</p>');
    return;
  }

  if (req.url === '/old-page') {
    req.url = '/new-page';
  }

  res.setHeader('X-Powered-By', 'nukejs-framework');
  res.setHeader('X-Request-Id', generateRequestId());

  if (req.url?.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
  }

  const clientIp = req.socket.remoteAddress || 'unknown';
  if (isRateLimited(clientIp)) {
    res.statusCode = 429;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Too many requests' }));
    return;
  }

  if (process.env.MAINTENANCE_MODE === 'true' && !req.url?.startsWith('/__')) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/html');
    res.end('<h1>503 Service Unavailable</h1><p>We are currently down for maintenance.</p>');
    return;
  }
}

function isAuthenticated(req: IncomingMessage): boolean {
  return req.headers.authorization === 'Bearer valid-token';
}

function generateRequestId(): string {
  return Math.random().toString(36).substring(2, 15);
}

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const limit = rateLimitMap.get(ip);

  if (!limit || now > limit.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 60000 });
    return false;
  }

  limit.count++;
  return limit.count > 100;
}
