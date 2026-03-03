/**
 * logger.ts — ANSI-Coloured Levelled Logger
 *
 * Provides a small set of server-side logging utilities used throughout NukeJS.
 *
 * Debug levels (set via nuke.config.ts `debug` field):
 *   false      — silent, nothing printed
 *   'error'    — error() only
 *   'info'     — info(), warn(), error()
 *   true       — verbose: all of the above plus verbose()
 *
 * The level can be read back with `getDebugLevel()` and is also forwarded to
 * the browser client (as a string) so server and client log at the same level.
 */

// ─── ANSI escape codes ────────────────────────────────────────────────────────

/** Map of named ANSI colour/style escape codes. */
export const ansi = {
  reset:     '\x1b[0m',
  bold:      '\x1b[1m',
  dim:       '\x1b[2m',
  black:     '\x1b[30m',
  red:       '\x1b[31m',
  green:     '\x1b[32m',
  yellow:    '\x1b[33m',
  blue:      '\x1b[34m',
  magenta:   '\x1b[35m',
  cyan:      '\x1b[36m',
  white:     '\x1b[37m',
  gray:      '\x1b[90m',
  bgBlue:    '\x1b[44m',
  bgGreen:   '\x1b[42m',
  bgMagenta: '\x1b[45m',
} as const;

/**
 * Wraps `text` in the ANSI sequence for `color`, optionally bold.
 * Always appends the reset sequence so colour does not bleed into surrounding
 * terminal output.
 */
export function c(color: keyof typeof ansi, text: string, bold = false): string {
  return `${bold ? ansi.bold : ''}${ansi[color]}${text}${ansi.reset}`;
}

// ─── Debug level ──────────────────────────────────────────────────────────────

/** false = silent | 'error' = errors only | 'info' = startup + errors | true = verbose */
export type DebugLevel = false | 'error' | 'info' | true;

let _level: DebugLevel = false;

/** Sets the active log level.  Called once after the config is loaded. */
export function setDebugLevel(level: DebugLevel): void { _level = level; }

/** Returns the currently active log level. */
export function getDebugLevel(): DebugLevel { return _level; }

// ─── Logger ───────────────────────────────────────────────────────────────────

/**
 * Structured log object with four severity methods.
 * Each method is a no-op unless the current `_level` allows it.
 */
export const log = {
  /** Trace-level detail: component IDs, route matching, bundle paths. */
  verbose(...args: any[]): void {
    if (_level === true) console.log(c('gray', '[verbose]'), ...args);
  },
  /** Startup messages, route tables, config summary. */
  info(...args: any[]): void {
    if (_level === true || _level === 'info') console.log(c('cyan', '[info]'), ...args);
  },
  /** Non-fatal issues: missing middleware, unrecognised config keys. */
  warn(...args: any[]): void {
    if (_level === true || _level === 'info') console.warn(c('yellow', '[warn]'), ...args);
  },
  /** Errors that produce a 500 response or crash the build. */
  error(...args: any[]): void {
    if (_level !== false) console.error(c('red', '[error]'), ...args);
  },
};
