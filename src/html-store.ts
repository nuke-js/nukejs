/**
 * html-store.ts — Per-Request HTML Head Store
 *
 * Provides a request-scoped store that server components can write to via
 * `useHtml()` during SSR.  The accumulated values are flushed into the
 * rendered HTML document after the component tree is fully rendered.
 *
 * Why globalThis?
 *   Node's module system may import this file multiple times if the page
 *   module and the nukejs package resolve to different copies (e.g. when
 *   running from source in dev with tsx).  Using a well-known Symbol on
 *   globalThis guarantees all copies share the same store instance.
 *
 * Request isolation:
 *   runWithHtmlStore() creates a fresh store before rendering and clears it
 *   in the `finally` block, so concurrent requests cannot bleed into each other.
 *
 * Title resolution:
 *   Layouts and pages can both call useHtml({ title: … }).  Layouts typically
 *   pass a template function:
 *
 *     useHtml({ title: (prev) => `${prev} | Acme` })
 *
 *   Operations are collected in render order (outermost layout first, page
 *   last) then resolved *in reverse* so the page's string value is the base
 *   and layout template functions wrap outward.
 */

// ─── Public types ─────────────────────────────────────────────────────────────

/** A page sets a literal string; a layout wraps with a template function. */
export type TitleValue = string | ((prev: string) => string);

export interface HtmlAttrs {
  lang?:  string;
  class?: string;
  style?: string;
  dir?:   string;
  [attr: string]: string | undefined;
}

export interface BodyAttrs {
  class?: string;
  style?: string;
  [attr: string]: string | undefined;
}

export interface MetaTag {
  name?:       string;
  property?:   string;
  httpEquiv?:  string;
  charset?:    string;
  content?:    string;
  [attr: string]: string | undefined;
}

export interface LinkTag {
  rel?:         string;
  href?:        string;
  type?:        string;
  media?:       string;
  as?:          string;
  crossOrigin?: string;
  integrity?:   string;
  hrefLang?:    string;
  sizes?:       string;
  [attr: string]: string | undefined;
}

export interface ScriptTag {
  src?:         string;
  content?:     string;
  type?:        string;
  defer?:       boolean;
  async?:       boolean;
  crossOrigin?: string;
  integrity?:   string;
  noModule?:    boolean;
}

export interface StyleTag {
  content?: string;
  media?:   string;
}

export interface HtmlStore {
  /** Collected in render order; resolved in reverse so the page title wins. */
  titleOps:  TitleValue[];
  /** Attributes merged onto <html>; last write wins per attribute. */
  htmlAttrs: HtmlAttrs;
  /** Attributes merged onto <body>; last write wins per attribute. */
  bodyAttrs: BodyAttrs;
  /** Accumulated in render order: layouts first, page last. */
  meta:      MetaTag[];
  link:      LinkTag[];
  script:    ScriptTag[];
  style:     StyleTag[];
}

// ─── GlobalThis storage ───────────────────────────────────────────────────────

/** Well-known Symbol used to share the store across duplicate module copies. */
const KEY = Symbol.for('__nukejs_html_store__');

const getGlobal = (): HtmlStore | null => (globalThis as any)[KEY] ?? null;
const setGlobal = (store: HtmlStore | null): void => { (globalThis as any)[KEY] = store; };

function emptyStore(): HtmlStore {
  return {
    titleOps:  [],
    htmlAttrs: {},
    bodyAttrs: {},
    meta:      [],
    link:      [],
    script:    [],
    style:     [],
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Runs `fn` inside a fresh HTML store and returns the collected values.
 *
 * Usage in SSR:
 * ```ts
 * const store = await runWithHtmlStore(async () => {
 *   appHtml = await renderElementToHtml(element, ctx);
 * });
 * // store.titleOps, store.meta, etc. are now populated
 * ```
 */
export async function runWithHtmlStore(fn: () => Promise<void>): Promise<HtmlStore> {
  setGlobal(emptyStore());
  try {
    await fn();
    return { ...(getGlobal() ?? emptyStore()) } as HtmlStore;
  } finally {
    // Always clear the store, even if rendering throws, to prevent leakage
    // into the next request on the same event-loop tick.
    setGlobal(null);
  }
}

/**
 * Returns the current request's store, or `undefined` if called outside of
 * a `runWithHtmlStore` context (e.g. in the browser or in a test).
 */
export function getHtmlStore(): HtmlStore | undefined {
  return getGlobal() ?? undefined;
}

/**
 * Resolves the final page title from a list of title operations.
 *
 * Operations are walked in *reverse* so the page's value is the starting
 * point and layout template functions wrap it outward:
 *
 * ```
 * ops = [ (p) => `${p} | Acme`, 'About' ]   ← layout pushed first, page last
 * Walk in reverse:
 *   i=1: op = 'About'          → title = 'About'
 *   i=0: op = (p) => …         → title = 'About | Acme'
 * ```
 *
 * @param fallback  Used when ops is empty (e.g. a page that didn't call useHtml).
 */
export function resolveTitle(ops: TitleValue[], fallback = ''): string {
  let title = fallback;
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    title = typeof op === 'string' ? op : op(title);
  }
  return title;
}
