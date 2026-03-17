/**
 * renderer.ts — Dev-Mode Async SSR Renderer
 *
 * Implements a recursive async renderer used in `nuke dev` to convert a React
 * element tree into an HTML string.  It is a lighter alternative to
 * react-dom/server.renderToString that:
 *
 *   - Supports async server components (components that return Promises).
 *   - Emits <span data-hydrate-id="…"> markers for "use client" boundaries
 *     instead of trying to render them server-side without their browser APIs.
 *   - Serializes props passed to client components into the marker's
 *     data-hydrate-props attribute so the browser can reconstruct them.
 *
 * In production (nuke build), the equivalent renderer is inlined into each
 * page's standalone bundle by build-common.ts (makePageAdapterSource).
 *
 * RenderContext:
 *   registry    — Map<id, filePath> of all client components for this page.
 *                 Populated by component-analyzer.ts before rendering.
 *   hydrated    — Set<id> populated during render; used to tell the browser
 *                 which components to hydrate on this specific request.
 *   skipClientSSR — When true (HMR request), client components emit an empty
 *                 marker instead of running renderToString (faster dev reload).
 */

import path from 'path';
import { createElement, Fragment } from 'react';
import { renderToString } from 'react-dom/server';
import { log } from './logger';
import { getComponentCache } from './component-analyzer';
import { escapeHtml } from './utils';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RenderContext {
  /** id → absolute file path for every client component reachable from this page. */
  registry:       Map<string, string>;
  /** Populated during render: IDs of client components actually encountered. */
  hydrated:       Set<string>;
  /** When true, skip renderToString for client components (faster HMR). */
  skipClientSSR?: boolean;
}

// ─── Wrapper attribute helpers ────────────────────────────────────────────────

/**
 * Attributes that belong on the hydration <span> wrapper rather than being
 * forwarded to the inner client component.  Includes className, style, id,
 * and any data-* / aria-* attributes.
 */
function isWrapperAttr(key: string): boolean {
  return (
    key === 'className' ||
    key === 'style'     ||
    key === 'id'        ||
    key.startsWith('data-') ||
    key.startsWith('aria-')
  );
}

/**
 * Splits props into two bags:
 *   wrapperAttrs   — keys destined for the <span> (className, style, id, data-*, aria-*)
 *   componentProps — everything else, forwarded to the actual component
 */
function splitWrapperAttrs(props: any): {
  wrapperAttrs:   Record<string, any>;
  componentProps: Record<string, any>;
} {
  const wrapperAttrs:   Record<string, any> = {};
  const componentProps: Record<string, any> = {};
  for (const [key, value] of Object.entries((props || {}) as Record<string, any>)) {
    if (isWrapperAttr(key)) wrapperAttrs[key]   = value;
    else                    componentProps[key] = value;
  }
  return { wrapperAttrs, componentProps };
}

/**
 * Converts a wrapper-attrs bag into an HTML attribute string (leading space
 * included when non-empty) suitable for direct interpolation into a tag.
 *
 *   className → class
 *   style obj → "prop:value;…" CSS string
 */
function buildWrapperAttrString(attrs: Record<string, any>): string {
  const parts = Object.entries(attrs)
    .map(([key, value]) => {
      if (key === 'className') key = 'class';

      if (key === 'style' && typeof value === 'object') {
        const css = Object.entries(value as Record<string, any>)
          .map(([k, v]) => {
            const prop    = k.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
            const safeVal = String(v).replace(/[<>"'`\\]/g, '');
            return `${prop}:${safeVal}`;
          })
          .join(';');
        return `style="${css}"`;
      }

      if (typeof value === 'boolean') return value ? key : '';
      if (value == null) return '';
      return `${key}="${escapeHtml(String(value))}"`;
    })
    .filter(Boolean);

  return parts.length ? ' ' + parts.join(' ') : '';
}

// ─── Top-level renderer ───────────────────────────────────────────────────────

/**
 * Recursively renders a React element (or primitive) to an HTML string.
 *
 * Handles:
 *   null / undefined / boolean  → ''
 *   string / number             → HTML-escaped text
 *   array                       → rendered in parallel, joined
 *   Fragment                    → renders children directly
 *   HTML element string         → renderHtmlElement()
 *   function component          → renderFunctionComponent()
 */
export async function renderElementToHtml(
  element: any,
  ctx: RenderContext,
): Promise<string> {
  if (element === null || element === undefined || typeof element === 'boolean') return '';
  if (typeof element === 'string' || typeof element === 'number')
    return escapeHtml(String(element));

  if (Array.isArray(element)) {
    const parts = await Promise.all(element.map(e => renderElementToHtml(e, ctx)));
    return parts.join('');
  }

  if (!element.type) return '';

  const { type, props } = element;

  if (type === Fragment)              return renderElementToHtml(props.children, ctx);
  if (typeof type === 'string')       return renderHtmlElement(type, props, ctx);
  if (typeof type === 'function')     return renderFunctionComponent(type, props, ctx);

  return '';
}

// ─── HTML element renderer ────────────────────────────────────────────────────

/**
 * Renders a native HTML element (e.g. `<div className="foo">`).
 *
 * Attribute conversion:
 *   className → class
 *   htmlFor   → for
 *   style     → converted from camelCase object to CSS string
 *   boolean   → omitted when false, rendered as name-only attribute when true
 *   dangerouslySetInnerHTML → inner HTML set verbatim (no escaping)
 *
 * Void elements (img, br, input, etc.) are self-closed.
 */
async function renderHtmlElement(
  type: string,
  props: any,
  ctx: RenderContext,
): Promise<string> {
  const { children, ...attributes } = (props || {}) as Record<string, any>;

  const attrs = Object.entries(attributes as Record<string, any>)
    .map(([key, value]) => {
      // React prop name → HTML attribute name.
      if (key === 'className')              key = 'class';
      if (key === 'htmlFor')                key = 'for';
      if (key === 'dangerouslySetInnerHTML') return ''; // handled separately below

      if (typeof value === 'boolean') return value ? key : '';

      // camelCase style object → "prop:value;…" CSS string.
      if (key === 'style' && typeof value === 'object') {
        const styleStr = Object.entries(value)
          .map(([k, v]) => {
            const prop    = k.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
            // Strip characters that could break out of the attribute value.
            const safeVal = String(v).replace(/[<>"'`\\]/g, '');
            return `${prop}:${safeVal}`;
          })
          .join(';');
        return `style="${styleStr}"`;
      }

      return `${key}="${escapeHtml(String(value))}"`;
    })
    .filter(Boolean)
    .join(' ');

  const attrStr = attrs ? ` ${attrs}` : '';

  if (props?.dangerouslySetInnerHTML) {
    return `<${type}${attrStr}>${props.dangerouslySetInnerHTML.__html}</${type}>`;
  }

  // Void elements cannot have children.
  if (['img', 'br', 'hr', 'input', 'meta', 'link'].includes(type)) {
    return `<${type}${attrStr} />`;
  }

  const childrenHtml = children ? await renderElementToHtml(children, ctx) : '';
  return `<${type}${attrStr}>${childrenHtml}</${type}>`;
}

// ─── Function component renderer ──────────────────────────────────────────────

/**
 * Renders a function (or class) component.
 *
 * Client boundary detection:
 *   The component cache maps file paths to ComponentInfo.  We match the
 *   component's function name against the default export of each registered
 *   client file to determine whether this component is a client boundary.
 *
 *   If it is, we emit a hydration marker and optionally run renderToString
 *   to produce the initial HTML inside the marker (skipped when skipClientSSR
 *   is set, e.g. during HMR navigation).
 *
 * Class components:
 *   Instantiated via `new type(props)` and their render() method called.
 *
 * Async components:
 *   Awaited if the return value is a Promise (standard server component pattern).
 */
async function renderFunctionComponent(
  type: Function,
  props: any,
  ctx: RenderContext,
): Promise<string> {
  const componentCache = getComponentCache();

  // Check whether this component function is a registered client component.
  for (const [id, filePath] of ctx.registry.entries()) {
    const info = componentCache.get(filePath);
    if (!info?.isClientComponent) continue;

    // Match by default export function name (cached — handles both source and
    // esbuild-compiled formats; see component-analyzer.getExportedDefaultName).
    if (!info.exportedName || type.name !== info.exportedName) continue;

    // This is a client boundary.
    try {
      ctx.hydrated.add(id);

      // Split props: wrapper attrs go on the <span>, the rest reach the component.
      const { wrapperAttrs, componentProps } = splitWrapperAttrs(props);
      const wrapperAttrStr  = buildWrapperAttrString(wrapperAttrs);
      const serializedProps = serializePropsForHydration(componentProps, ctx.registry);
      log.verbose(`Client component rendered for hydration: ${id} (${path.basename(filePath)})`);

      // Optionally SSR the component so the initial HTML is meaningful
      // (improves perceived performance and avoids layout shift).
      const html = ctx.skipClientSSR
        ? ''
        : renderToString(createElement(type as React.ComponentType<any>, componentProps));

      return `<span data-hydrate-id="${id}"${wrapperAttrStr} data-hydrate-props="${escapeHtml(
        JSON.stringify(serializedProps),
      )}">${html}</span>`;
    } catch (err) {
      log.error('Error rendering client component:', err);
      return `<div style="color:red">Error rendering client component: ${escapeHtml(String(err))}</div>`;
    }
  }

  // Server component — call it and recurse into the result.
  // Do NOT catch here: errors must propagate up so serverSideRender can
  // render _500.tsx. The client-component catch above is kept because those
  // errors are hydration failures, not page-level errors.
  const result   = type(props);
  const resolved = result?.then ? await result : result;
  return renderElementToHtml(resolved, ctx);
}

// ─── Prop serialization ───────────────────────────────────────────────────────

/**
 * Converts props into a JSON-serializable form for the data-hydrate-props
 * attribute.  React elements inside props are serialized to a tagged object
 * format ({ __re: 'html'|'client', … }) that the browser's reconstructElement
 * function (in bundle.ts) can turn back into real React elements.
 *
 * Functions are dropped (cannot be serialized).
 */
function serializePropsForHydration(
  props: any,
  registry: Map<string, string>,
): any {
  if (!props || typeof props !== 'object') return props;
  const out: any = {};
  for (const [key, value] of Object.entries(props as Record<string, any>)) {
    const s = serializeValue(value, registry);
    if (s !== undefined) out[key] = s;
  }
  return out;
}

function serializeValue(value: any, registry: Map<string, string>): any {
  if (value === null || value === undefined)  return value;
  if (typeof value === 'function')            return undefined; // not serializable
  if (typeof value !== 'object')              return value;
  if (Array.isArray(value))
    return value.map(v => serializeValue(v, registry)).filter(v => v !== undefined);
  if ((value as any).$$typeof)
    return serializeReactElement(value, registry);

  const out: any = {};
  for (const [k, v] of Object.entries(value as Record<string, any>)) {
    const s = serializeValue(v, registry);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

/**
 * Serializes a React element to its wire format:
 *   Native element  → { __re: 'html',   tag, props }
 *   Client component → { __re: 'client', componentId, props }
 *   Server component → undefined (cannot be serialized)
 */
function serializeReactElement(element: any, registry: Map<string, string>): any {
  const { type, props } = element;

  if (typeof type === 'string') {
    return { __re: 'html', tag: type, props: serializePropsForHydration(props, registry) };
  }

  if (typeof type === 'function') {
    const componentCache = getComponentCache();
    for (const [id, filePath] of registry.entries()) {
      const info = componentCache.get(filePath);
      if (!info?.isClientComponent) continue;
      if (info.exportedName && type.name === info.exportedName) {
        return {
          __re:        'client',
          componentId: id,
          props:       serializePropsForHydration(props, registry),
        };
      }
    }
  }

  return undefined; // Server component — not serializable
}