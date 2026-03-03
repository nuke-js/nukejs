/**
 * metadata.ts — Legacy Metadata Helpers
 *
 * @deprecated  Use the `useHtml()` hook instead.
 *
 * This module provided an earlier metadata API where pages exported a
 * `metadata` object alongside their default component.  It is retained for
 * backwards compatibility but new projects should use useHtml().
 *
 * Example (old pattern):
 *   export const metadata = {
 *     title: 'My Page',
 *     scripts: [{ src: '/analytics.js', defer: true }],
 *   };
 */

import { pathToFileURL } from 'url';
import { escapeHtml } from './utils';

export interface ScriptTag {
  src?:     string;
  content?: string;
  type?:    string;
  defer?:   boolean;
  async?:   boolean;
}

export interface StyleTag {
  href?:    string;
  content?: string;
}

export interface Metadata {
  title?:   string;
  scripts?: ScriptTag[];
  styles?:  StyleTag[];
}

/**
 * Dynamically imports a page/layout module and returns its exported `metadata`
 * object, or an empty object if none is found or the import fails.
 */
export async function loadMetadata(filePath: string): Promise<Metadata> {
  try {
    const mod = await import(pathToFileURL(filePath).href);
    return (mod.metadata as Metadata) ?? {};
  } catch {
    return {};
  }
}

/**
 * Merges metadata from an array of modules in render order (outermost layout
 * first, page last).
 *
 * Merge strategy:
 *   title   — last non-empty value wins (page overrides layout)
 *   scripts — concatenated in order
 *   styles  — concatenated in order
 */
export function mergeMetadata(ordered: Metadata[]): Required<Metadata> {
  const result: Required<Metadata> = { title: '', scripts: [], styles: [] };
  for (const m of ordered) {
    if (m.title)          result.title = m.title;
    if (m.scripts?.length) result.scripts.push(...m.scripts);
    if (m.styles?.length)  result.styles.push(...m.styles);
  }
  return result;
}

/** Renders a ScriptTag to an HTML string. */
export function renderScriptTag(s: ScriptTag): string {
  if (s.src) {
    const attrs = [
      `src="${escapeHtml(s.src)}"`,
      s.type  ? `type="${escapeHtml(s.type)}"` : '',
      s.defer ? 'defer'  : '',
      s.async ? 'async'  : '',
    ].filter(Boolean).join(' ');
    return `<script ${attrs}></script>`;
  }
  const typeAttr = s.type ? ` type="${escapeHtml(s.type)}"` : '';
  return `<script${typeAttr}>${s.content ?? ''}</script>`;
}

/** Renders a StyleTag to an HTML string. */
export function renderStyleTag(s: StyleTag): string {
  if (s.href) return `<link rel="stylesheet" href="${escapeHtml(s.href)}" />`;
  return `<style>${s.content ?? ''}</style>`;
}
