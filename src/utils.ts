/**
 * utils.ts — Shared Utility Functions
 *
 * Small, dependency-free helpers used across both server and client code.
 */

/**
 * Escapes a string for safe inclusion in HTML content or attribute values.
 *
 * Replaces the five characters that have special meaning in HTML:
 *   &  → &amp;   (must come first to avoid double-escaping)
 *   <  → &lt;
 *   >  → &gt;
 *   "  → &quot;
 *   '  → &#039;
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Returns the correct Content-Type header value for a given file extension.
 *
 * Covers the full range of file types that are realistic in a public/ directory:
 * scripts, styles, images, fonts, media, documents, and data formats.
 *
 * Falls back to 'application/octet-stream' for unknown extensions so the
 * browser downloads rather than tries to render unknown binary content.
 */
export function getMimeType(ext: string): string {
  const map: Record<string, string> = {
    // ── Web ────────────────────────────────────────────────────────────────
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.cjs': 'application/javascript; charset=utf-8',
    '.map': 'application/json; charset=utf-8',

    // ── Data ──────────────────────────────────────────────────────────────
    '.json': 'application/json; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',

    // ── Images ────────────────────────────────────────────────────────────
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',

    // ── Fonts ─────────────────────────────────────────────────────────────
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.eot': 'application/vnd.ms-fontobject',

    // ── Video ─────────────────────────────────────────────────────────────
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogv': 'video/ogg',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',

    // ── Audio ─────────────────────────────────────────────────────────────
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',

    // ── Documents / archives ──────────────────────────────────────────────
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
    '.tar': 'application/x-tar',
    '.wasm': 'application/wasm',
  };
  return map[ext.toLowerCase()] ?? 'application/octet-stream';
}