/**
 * config.ts — NukeJS Configuration Loader
 *
 * Loads `nuke.config.ts` from the project root at startup.
 * If no config file exists, sensible defaults are returned so most projects
 * work with zero configuration.
 *
 * Config file example (nuke.config.ts):
 *
 * ```ts
 * export default {
 *   serverDir: './server',   // where API route files live
 *   port: 3000,              // HTTP port for the dev server
 *   debug: 'info',           // false | 'error' | 'info' | true (verbose)
 * };
 * ```
 */

import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';
import { log } from './logger';
import type { DebugLevel } from './logger';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface Config {
  /** Path to the API server directory, relative to project root. */
  serverDir: string;
  /** TCP port for the dev server. Increments automatically if in use. */
  port:      number;
  /** Logging verbosity. false = silent, true = verbose. */
  debug?:    DebugLevel;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Dynamically imports `nuke.config.ts` from process.cwd() and merges it with
 * the defaults.  Falls back to defaults silently when no config file exists.
 *
 * Throws if the config file exists but cannot be imported (syntax error, etc.)
 * so the developer sees the problem immediately rather than running on stale
 * defaults.
 */
export async function loadConfig(): Promise<Config> {
  const configPath = path.join(process.cwd(), 'nuke.config.ts');

  if (!fs.existsSync(configPath)) {
    // No config file — use defaults.  This is expected for new projects.
    return {
      serverDir: './server',
      port:      3000,
      debug:     false,
    };
  }

  try {
    // pathToFileURL ensures the import works correctly on Windows (absolute
    // paths with drive letters are not valid ESM specifiers without file://).
    const mod    = await import(pathToFileURL(configPath).href);
    const config = mod.default;

    return {
      serverDir: config.serverDir || './server',
      port:      config.port      || 3000,
      debug:     config.debug ?? false,
    };
  } catch (error) {
    log.error('Error loading config:', error);
    throw error;
  }
}
