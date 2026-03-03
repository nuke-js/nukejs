/**
 * bundle.ts — NukeJS Client Runtime
 *
 * This file is compiled by esbuild into /__n.js and served to every page.
 * It provides:
 *
 *   initRuntime(data)              — called once per page load to hydrate
 *                                    "use client" components and wire up SPA nav
 *   setupLocationChangeMonitor()   — patches history.pushState/replaceState so
 *                                    SPA navigation fires a 'locationchange' event
 *
 * Hydration model (partial hydration):
 *   - The server renders the full page to HTML, wrapping each client component
 *     in a <span data-hydrate-id="cc_…" data-hydrate-props="…"> marker.
 *   - initRuntime loads the matching JS bundle for each marker and calls
 *     hydrateRoot() on it, letting React take over just that subtree.
 *   - Props serialized by the server may include nested React elements
 *     (serialized as { __re: 'html'|'client', … }), which are reconstructed
 *     back into React.createElement calls before mounting.
 *
 * SPA navigation:
 *   - Link clicks / programmatic navigation dispatch a 'locationchange' event.
 *   - The handler fetches the target URL as HTML, diffs the #app container,
 *     unmounts the old React roots, and re-hydrates the new ones.
 *   - HMR navigations add ?__hmr=1 so the server skips client-SSR (faster).
 */

// ─── History patch ────────────────────────────────────────────────────────────

/**
 * Patches history.pushState and history.replaceState to fire a custom
 * 'locationchange' event on window.  Also listens to 'popstate' for
 * back/forward navigation.
 *
 * This must be called after initRuntime sets up the navigation listener so
 * there's no race between the event firing and the listener being registered.
 */
export function setupLocationChangeMonitor(): void {
  const originalPushState = window.history.pushState.bind(window.history);
  const originalReplaceState = window.history.replaceState.bind(window.history);

  const dispatch = (href?: any) =>
    window.dispatchEvent(new CustomEvent('locationchange', { detail: { href } }));

  window.history.pushState = function (...args) {
    originalPushState(...args);
    dispatch(args[2]); // args[2] is the URL
  };

  window.history.replaceState = function (...args) {
    originalReplaceState(...args);
    dispatch(args[2]);
  };

  // Back/forward navigation via the browser's native UI.
  window.addEventListener('popstate', () => dispatch(window.location.pathname));
}

// ─── Logger ───────────────────────────────────────────────────────────────────

type ClientDebugLevel = 'silent' | 'error' | 'info' | 'verbose';

/**
 * Returns a thin logger whose methods are no-ops unless `level` allows them.
 * The server embeds the active debug level in the __n_data JSON blob so the
 * client respects the same setting as the server.
 */
function makeLogger(level: ClientDebugLevel) {
  return {
    verbose: (...a: any[]) => { if (level === 'verbose') console.log(...a); },
    info: (...a: any[]) => { if (level === 'verbose' || level === 'info') console.log(...a); },
    warn: (...a: any[]) => { if (level === 'verbose' || level === 'info') console.warn(...a); },
    error: (...a: any[]) => { if (level !== 'silent') console.error(...a); },
  };
}

// ─── Serialized node types ────────────────────────────────────────────────────

/** The wire format for React elements embedded in hydration props. */
type SerializedNode =
  | null
  | undefined
  | string
  | number
  | boolean
  | SerializedNode[]
  | { __re: 'html'; tag: string; props: Record<string, any> }   // native DOM element
  | { __re: 'client'; componentId: string; props: Record<string, any> } // client component
  | Record<string, any>;                                             // plain object

type ModuleMap = Map<string, any>; // componentId → default export

// ─── Prop reconstruction ──────────────────────────────────────────────────────

/**
 * Recursively turns the server's serialized node tree back into real React
 * elements so they can be passed as props to hydrated components.
 *
 * The server serializes JSX passed as props (e.g. `<Button icon={<Icon />}>`)
 * into a JSON-safe format.  This function reverses that process.
 */
async function reconstructElement(node: SerializedNode, mods: ModuleMap): Promise<any> {
  if (node === null || node === undefined) return node;
  if (typeof node !== 'object') return node; // primitive — pass through

  if (Array.isArray(node)) {
    const items = await Promise.all(node.map(n => reconstructElement(n, mods)));
    // Add index-based keys to any React elements in the array so React doesn't
    // warn about "Each child in a list should have a unique key prop".
    const React = await import('react');
    return items.map((el, i) =>
      el && typeof el === 'object' && el.$$typeof
        ? React.default.cloneElement(el, { key: el.key ?? i })
        : el,
    );
  }

  // Client component — look up the loaded module by ID.
  if ((node as any).__re === 'client') {
    const n = node as { __re: 'client'; componentId: string; props: Record<string, any> };
    const Comp = mods.get(n.componentId);
    if (!Comp) return null;
    const React = await import('react');
    return React.default.createElement(Comp, await reconstructProps(n.props, mods));
  }

  // Native HTML element (e.g. <div>, <span>).
  if ((node as any).__re === 'html') {
    const n = node as { __re: 'html'; tag: string; props: Record<string, any> };
    const React = await import('react');
    return React.default.createElement(n.tag, await reconstructProps(n.props, mods));
  }

  // Plain object — reconstruct each value.
  return node;
}

/** Reconstructs every value in a props object, handling nested serialized nodes. */
async function reconstructProps(
  props: Record<string, any> | null | undefined,
  mods: ModuleMap,
): Promise<Record<string, any>> {
  if (!props || typeof props !== 'object' || Array.isArray(props))
    return reconstructElement(props as any, mods);

  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(props))
    out[k] = await reconstructElement(v, mods);
  return out;
}

// ─── Module loading ───────────────────────────────────────────────────────────

/**
 * Dynamically imports each client component bundle from /__client-component/.
 * All fetches are issued in parallel; failures are logged but do not abort
 * the rest of the hydration pass.
 *
 * @param bust  Optional cache-busting suffix appended as `?t=<bust>`.
 *              Used during HMR navigation to bypass the module cache.
 */
async function loadModules(
  ids: string[],
  log: ReturnType<typeof makeLogger>,
  bust = '',
): Promise<ModuleMap> {
  const mods: ModuleMap = new Map();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const url = `/__client-component/${id}.js` + (bust ? `?t=${bust}` : '');
        const m = await import(url);
        mods.set(id, m.default);
        log.verbose('✓ Loaded:', id);
      } catch (err) {
        log.error('✗ Load failed:', id, err);
      }
    }),
  );
  return mods;
}

// ─── Root mounting ────────────────────────────────────────────────────────────

/** All active React roots — tracked so they can be unmounted before navigation. */
type ReactRoot = { unmount(): void };
const activeRoots: ReactRoot[] = [];

/**
 * Finds every `[data-hydrate-id]` span in the document and either:
 *   - hydrateRoot()  — on initial page load (server HTML already present)
 *   - createRoot()   — after SPA navigation (innerHTML was set by us)
 *
 * Nested markers (a client component inside another client component) are
 * skipped here because the parent's React tree will handle its children.
 */
async function mountNodes(
  mods: ModuleMap,
  log: ReturnType<typeof makeLogger>,
  isNavigation: boolean,
): Promise<void> {
  const { hydrateRoot, createRoot } = await import('react-dom/client');
  const React = await import('react');

  const nodes = document.querySelectorAll<HTMLElement>('[data-hydrate-id]');
  log.verbose('Found', nodes.length, 'hydration point(s)');

  for (const node of nodes) {
    // Skip nested markers — the outer component owns its children.
    if (node.parentElement?.closest('[data-hydrate-id]')) continue;

    const id = node.getAttribute('data-hydrate-id')!;
    const Comp = mods.get(id);
    if (!Comp) { log.warn('No module for', id); continue; }

    // Deserialize props from the data attribute (JSON set by the server).
    let rawProps: Record<string, any> = {};
    try {
      rawProps = JSON.parse(node.getAttribute('data-hydrate-props') || '{}');
    } catch (e) {
      log.error('Props parse error for', id, e);
    }

    try {
      const element = React.default.createElement(Comp, await reconstructProps(rawProps, mods));

      // hydrateRoot reconciles React's virtual DOM against the server-rendered
      // HTML without fully re-rendering.  createRoot replaces the content
      // entirely — safe after navigation because we set innerHTML ourselves.
      const root = isNavigation ? createRoot(node) : hydrateRoot(node, element);
      if (isNavigation) (root as any).render(element);
      activeRoots.push(root);
      log.verbose('✓ Mounted:', id);
    } catch (err) {
      log.error('✗ Mount failed:', id, err);
    }
  }
}

// ─── SPA navigation ───────────────────────────────────────────────────────────

/**
 * Listens for 'locationchange' events (fired by setupLocationChangeMonitor
 * or by Link clicks) and performs a soft navigation:
 *
 *   1. Fetch the target URL as HTML (adds ?__hmr=1 during HMR updates so the
 *      server skips client-side SSR for a faster response).
 *   2. Parse the response with DOMParser.
 *   3. Replace #app innerHTML and __n_data.
 *   4. Unmount old React roots, then re-hydrate new ones.
 *   5. Scroll to top.
 *
 * Falls back to a full page reload if anything goes wrong.
 */
/**
 * Syncs attributes from a parsed element onto the live document element.
 * Adds/updates attributes present in `next`, and removes any that were set
 * on `live` but are absent in `next` (so stale bodyAttrs/htmlAttrs are cleared).
 */
function syncAttrs(live: Element, next: Element): void {
  // Apply / update attributes from the new document.
  for (const { name, value } of Array.from(next.attributes)) {
    live.setAttribute(name, value);
  }
  // Remove attributes that no longer exist in the new document.
  for (const { name } of Array.from(live.attributes)) {
    if (!next.hasAttribute(name)) live.removeAttribute(name);
  }
}

function setupNavigation(log: ReturnType<typeof makeLogger>): void {
  window.addEventListener('locationchange', async ({ detail: { href, hmr } }: any) => {
    try {
      // Append ?__hmr=1 for HMR-triggered reloads so SSR skips the slower
      // client-component renderToString path.
      const fetchUrl = hmr
        ? href + (href.includes('?') ? '&' : '?') + '__hmr=1'
        : href;

      const response = await fetch(fetchUrl, { headers: { Accept: 'text/html' } });
      if (!response.ok) {
        log.error('Navigation fetch failed:', response.status);
        return;
      }

      const parser = new DOMParser();
      const doc = parser.parseFromString(await response.text(), 'text/html');
      const newApp = doc.getElementById('app');
      const currApp = document.getElementById('app');
      if (!newApp || !currApp) return;

      // Tear down existing React trees before mutating the DOM — avoids React
      // warnings about unmounting from a detached node.
      activeRoots.splice(0).forEach(r => r.unmount());

      // Swap content in-place (avoids a full document.write / navigation).
      currApp.innerHTML = newApp.innerHTML;

      // Update the runtime data blob so subsequent navigations use the new page's
      // client component IDs.
      const newDataEl = doc.getElementById('__n_data');
      const currDataEl = document.getElementById('__n_data');
      if (newDataEl && currDataEl) currDataEl.textContent = newDataEl.textContent;

      // Update <title>.
      const newTitle = doc.querySelector('title');
      if (newTitle) document.title = newTitle.textContent ?? '';

      // Sync <html> attributes (e.g. lang, class, style from useHtml({ htmlAttrs })).
      syncAttrs(document.documentElement, doc.documentElement);

      // Sync <body> attributes (e.g. style, class from useHtml({ bodyAttrs })).
      syncAttrs(document.body, doc.body);

      const navData = JSON.parse(currDataEl?.textContent ?? '{}') as RuntimeData;
      log.info('🔄 Route →', href, '— mounting', navData.hydrateIds?.length ?? 0, 'component(s)');

      // Load bundles with a cache-buster timestamp so stale modules are evicted.
      const mods = await loadModules(navData.allIds ?? [], log, String(Date.now()));
      await mountNodes(mods, log, true);

      window.scrollTo(0, 0);
      log.info('🎉 Navigation complete:', href);
    } catch (err) {
      log.error('Navigation error, falling back to full reload:', err);
      window.location.href = href;
    }
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Shape of the JSON blob embedded as #__n_data in every SSR page. */
export interface RuntimeData {
  /** IDs of client components actually rendered on this page (subset of allIds). */
  hydrateIds: string[];
  /** All client component IDs reachable from this page, including layouts.
   *  Pre-loaded so SPA navigations to related pages feel instant. */
  allIds: string[];
  url: string;
  params: Record<string, any>;
  debug: ClientDebugLevel;
}

/**
 * Bootstraps the NukeJS client runtime.
 *
 * Called once per page load from the inline <script type="module"> injected
 * by the SSR renderer:
 *
 * ```js
 * const { initRuntime } = await import('nukejs');
 * const data = JSON.parse(document.getElementById('__n_data').textContent);
 * await initRuntime(data);
 * ```
 *
 * Order of operations:
 *   1. Create the logger at the configured debug level.
 *   2. Wire up SPA navigation listener.
 *   3. Load all client component bundles in parallel.
 *   4. Hydrate every [data-hydrate-id] node.
 *   5. Patch history.pushState/replaceState so Link clicks trigger navigation.
 */
export async function initRuntime(data: RuntimeData): Promise<void> {
  const log = makeLogger(data.debug ?? 'silent');

  log.info('🚀 Partial hydration:', data.hydrateIds.length, 'root component(s)');

  // Set up navigation first so any 'locationchange' fired during hydration
  // is captured.
  setupNavigation(log);

  // Load all component bundles (not just hydrateIds) so SPA navigations can
  // mount components for other pages without an extra network round-trip.
  const mods = await loadModules(data.allIds, log);
  await mountNodes(mods, log, false);

  log.info('🎉 Done!');

  // Patch history last so pushState calls during hydration (e.g. redirect
  // side-effects) don't trigger a navigation before roots are ready.
  setupLocationChangeMonitor();
}