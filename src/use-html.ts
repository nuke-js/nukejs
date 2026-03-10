/**
 * use-html.ts — useHtml() Hook
 *
 * A universal hook that lets React components control the HTML document's
 * <head>, <html> attributes, and <body> attributes from within JSX — on both
 * the server (SSR) and the client (hydration / SPA navigation).
 *
 * Server behaviour:
 *   Writes directly into the per-request html-store.  The store is flushed
 *   into the HTML document after the component tree is fully rendered.
 *   useHtml() is called synchronously during rendering so no actual React
 *   hook is used — it's just a function that pokes the globalThis store.
 *
 * Client behaviour:
 *   Uses useEffect() to apply changes to the live document and clean them up
 *   when the component unmounts (navigation, unmount).  Each effect is keyed
 *   to its options object via JSON.stringify so React re-runs it when the
 *   options change.
 *
 * Layout title templates:
 *   Layouts typically set title as a function so they can append a site suffix:
 *
 *   ```tsx
 *   // Root layout
 *   useHtml({ title: (prev) => `${prev} | Acme` });
 *
 *   // A page
 *   useHtml({ title: 'About' });
 *   // → 'About | Acme'
 *   ```
 *
 * Example usage:
 *   ```tsx
 *   useHtml({
 *     title: 'Blog Post',
 *     meta:  [{ name: 'description', content: 'A great post' }],
 *     link:  [{ rel: 'canonical', href: 'https://example.com/post' }],
 *   });
 *   ```
 */

import { useEffect } from 'react';
import { getHtmlStore } from './html-store';
import type {
  TitleValue,
  HtmlAttrs,
  BodyAttrs,
  MetaTag,
  LinkTag,
  ScriptTag,
  StyleTag,
} from './html-store';

// Re-export types so consumers can import them from 'nukejs' directly.
export type { TitleValue, HtmlAttrs, BodyAttrs, MetaTag, LinkTag, ScriptTag, StyleTag };

// ─── Options type ─────────────────────────────────────────────────────────────

export interface HtmlOptions {
  /**
   * Page title.
   *   string   → sets the title directly (page wins over layout).
   *   function → receives the inner title; use in layouts to append a suffix:
   *              `(prev) => \`${prev} | MySite\``
   */
  title?:     TitleValue;
  /** Attributes merged onto <html>. Per-attribute last-write-wins. */
  htmlAttrs?: HtmlAttrs;
  /** Attributes merged onto <body>. Per-attribute last-write-wins. */
  bodyAttrs?: BodyAttrs;
  meta?:      MetaTag[];
  link?:      LinkTag[];
  script?:    ScriptTag[];
  style?:     StyleTag[];
}

// ─── Universal hook ───────────────────────────────────────────────────────────

/**
 * Applies HTML document customisations from a React component.
 * Automatically detects whether it is running on the server or the client.
 */
export function useHtml(options: HtmlOptions): void {
  if (typeof document === 'undefined') {
    // Running on the server (SSR) — write synchronously to the request store.
    serverUseHtml(options);
  } else {
    // Running in the browser — use React effects.
    clientUseHtml(options);
  }
}

// ─── Server implementation ────────────────────────────────────────────────────

/**
 * Writes options directly into the active per-request html-store.
 * Called synchronously during SSR; no React hooks are used.
 *
 * Title operations are *pushed* (not replaced) so both layout and page values
 * are preserved for resolveTitle() to process in the correct order.
 */
function serverUseHtml(options: HtmlOptions): void {
  const store = getHtmlStore();
  if (!store) return; // Called outside of a runWithHtmlStore context — ignore.

  if (options.title !== undefined) store.titleOps.push(options.title);
  if (options.htmlAttrs)           Object.assign(store.htmlAttrs, options.htmlAttrs);
  if (options.bodyAttrs)           Object.assign(store.bodyAttrs, options.bodyAttrs);
  if (options.meta?.length)        store.meta.push(...options.meta);
  if (options.link?.length)        store.link.push(...options.link);
  if (options.script?.length)      store.script.push(...options.script);
  if (options.style?.length)       store.style.push(...options.style);
}

// ─── Client implementation ────────────────────────────────────────────────────

/** Monotonically incrementing counter for generating unique dataset IDs. */
let _uid = 0;
const uid = () => `uh${++_uid}`;

/**
 * Applies options to the live document using React effects.
 * Each effect type is independent so a change to `title` does not re-run the
 * `meta` effect and vice versa.
 *
 * Cleanup functions restore the previous state so unmounting a component that
 * called useHtml() reverses its changes (important for SPA navigation).
 */
function clientUseHtml(options: HtmlOptions): void {
  // ── title ──────────────────────────────────────────────────────────────────
  useEffect(() => { // eslint-disable-line react-hooks/rules-of-hooks
    if (options.title === undefined) return;
    const prev      = document.title;
    document.title  = typeof options.title === 'function'
      ? options.title(prev)
      : options.title;
    return () => { document.title = prev; };
  }, [typeof options.title === 'function' // eslint-disable-line react-hooks/exhaustive-deps
    ? options.title.toString()
    : options.title]);

  // ── <html> attributes ──────────────────────────────────────────────────────
  useEffect(() => { // eslint-disable-line react-hooks/rules-of-hooks
    if (!options.htmlAttrs) return;
    return applyAttrs(document.documentElement, options.htmlAttrs);
  }, [JSON.stringify(options.htmlAttrs)]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── <body> attributes ──────────────────────────────────────────────────────
  useEffect(() => { // eslint-disable-line react-hooks/rules-of-hooks
    if (!options.bodyAttrs) return;
    return applyAttrs(document.body, options.bodyAttrs);
  }, [JSON.stringify(options.bodyAttrs)]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── <meta> tags ────────────────────────────────────────────────────────────
  useEffect(() => { // eslint-disable-line react-hooks/rules-of-hooks
    if (!options.meta?.length) return;
    const id    = uid();
    const nodes = options.meta.map((tag) => {
      const el = document.createElement('meta');
      for (const [k, v] of Object.entries(tag)) {
        if (v !== undefined) el.setAttribute(domAttr(k), v);
      }
      el.dataset.usehtml = id;
      document.head.appendChild(el);
      return el;
    });
    return () => nodes.forEach(n => n.remove());
  }, [JSON.stringify(options.meta)]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── <link> tags ────────────────────────────────────────────────────────────
  useEffect(() => { // eslint-disable-line react-hooks/rules-of-hooks
    if (!options.link?.length) return;
    const id    = uid();
    const nodes = options.link.map((tag) => {
      const el = document.createElement('link');
      for (const [k, v] of Object.entries(tag)) {
        if (v !== undefined) el.setAttribute(domAttr(k), v);
      }
      el.dataset.usehtml = id;
      document.head.appendChild(el);
      return el;
    });
    return () => nodes.forEach(n => n.remove());
  }, [JSON.stringify(options.link)]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── <script> tags ──────────────────────────────────────────────────────────
  useEffect(() => { // eslint-disable-line react-hooks/rules-of-hooks
    if (!options.script?.length) return;
    const id    = uid();
    const nodes = options.script.map((tag) => {
      const el = document.createElement('script');
      if (tag.src)         el.src           = tag.src;
      if (tag.type)        el.type          = tag.type;
      if (tag.defer)       el.defer         = true;
      if (tag.async)       el.async         = true;
      if (tag.noModule)    el.setAttribute('nomodule', '');
      if (tag.crossOrigin) el.crossOrigin   = tag.crossOrigin;
      if (tag.integrity)   el.integrity     = tag.integrity;
      if (tag.content)     el.textContent   = tag.content;
      el.dataset.usehtml = id;
      // Respect position: 'body' scripts are appended at the end of <body>.
      if (tag.position === 'body') {
        document.body.appendChild(el);
      } else {
        document.head.appendChild(el);
      }
      return el;
    });
    return () => nodes.forEach(n => n.remove());
  }, [JSON.stringify(options.script)]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── <style> tags ───────────────────────────────────────────────────────────
  useEffect(() => { // eslint-disable-line react-hooks/rules-of-hooks
    if (!options.style?.length) return;
    const id    = uid();
    const nodes = options.style.map((tag) => {
      const el = document.createElement('style');
      if (tag.media)   el.media       = tag.media;
      if (tag.content) el.textContent = tag.content;
      el.dataset.usehtml = id;
      document.head.appendChild(el);
      return el;
    });
    return () => nodes.forEach(n => n.remove());
  }, [JSON.stringify(options.style)]); // eslint-disable-line react-hooks/exhaustive-deps
}

// ─── Attribute helpers ────────────────────────────────────────────────────────

/**
 * Applies an attribute map to a DOM element, storing the previous values so
 * the returned cleanup function can restore them on unmount.
 */
function applyAttrs(
  el:    Element,
  attrs: Record<string, string | undefined>,
): () => void {
  const prev: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    const attr    = domAttr(k);
    prev[attr]    = el.getAttribute(attr);
    el.setAttribute(attr, v);
  }
  return () => {
    for (const [attr, was] of Object.entries(prev)) {
      if (was === null) el.removeAttribute(attr);
      else el.setAttribute(attr, was);
    }
  };
}

/**
 * Converts camelCase React prop names to their HTML attribute equivalents.
 *   httpEquiv  → http-equiv
 *   hrefLang   → hreflang
 *   crossOrigin → crossorigin
 */
function domAttr(key: string): string {
  if (key === 'httpEquiv')   return 'http-equiv';
  if (key === 'hrefLang')    return 'hreflang';
  if (key === 'crossOrigin') return 'crossorigin';
  return key;
}