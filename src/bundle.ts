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
 *
 * Head tag management:
 *   - The SSR renderer wraps every useHtml()-generated <meta>, <link>, <style>,
 *     and <script> tag in <!--n-head-->…<!--/n-head--> sentinel comments.
 *   - On each navigation the client diffs the live sentinel block against the
 *     incoming one by fingerprint, adding new tags and removing gone ones.
 *     Tags shared between pages (e.g. a layout stylesheet) are left untouched
 *     so there is no removal/re-insertion flash.
 *   - New tags are always inserted before <!--/n-head--> so they stay inside
 *     the tracked block and remain visible to the diff on subsequent navigations.
 */

// ─── History patch ────────────────────────────────────────────────────────────

/**
 * Patches history.pushState and history.replaceState to fire a custom
 * 'locationchange' event on window.  Also listens to 'popstate' for
 * back/forward navigation.
 *
 * Called after initRuntime sets up the navigation listener so there is no
 * race between the event firing and the listener being registered.
 */
export function setupLocationChangeMonitor(): void {
  const originalPushState    = window.history.pushState.bind(window.history);
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
    info:    (...a: any[]) => { if (level === 'verbose' || level === 'info') console.log(...a); },
    warn:    (...a: any[]) => { if (level === 'verbose' || level === 'info') console.warn(...a); },
    error:   (...a: any[]) => { if (level !== 'silent') console.error(...a); },
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
  | { __re: 'html';   tag: string;         props: Record<string, any> }
  | { __re: 'client'; componentId: string; props: Record<string, any> }
  | Record<string, any>;

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
    // Add index-based keys to React elements in the array to avoid the
    // "Each child in a list should have a unique key prop" warning.
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

  // Plain object — pass through as-is.
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
 * Finds every `[data-hydrate-id]` span in the document and calls hydrateRoot()
 * on it.  hydrateRoot reconciles React's virtual DOM against the existing server
 * HTML without discarding it, which avoids a visible flash on both initial load
 * and SPA navigation (where we set innerHTML to fresh SSR output before calling
 * mountNodes).
 *
 * Nested markers are skipped — the parent's React tree owns its children.
 */
async function mountNodes(
  mods: ModuleMap,
  log:  ReturnType<typeof makeLogger>,
): Promise<void> {
  const { hydrateRoot, createRoot } = await import('react-dom/client');
  const React = await import('react');

  const nodes = document.querySelectorAll<HTMLElement>('[data-hydrate-id]');
  log.verbose('Found', nodes.length, 'hydration point(s)');

  for (const node of nodes) {
    // Skip nested markers — the outer component owns its children.
    if (node.parentElement?.closest('[data-hydrate-id]')) continue;

    const id   = node.getAttribute('data-hydrate-id')!;
    const Comp = mods.get(id);
    if (!Comp) { log.warn('No module for', id); continue; }

    let rawProps: Record<string, any> = {};
    try {
      rawProps = JSON.parse(node.getAttribute('data-hydrate-props') || '{}');
    } catch (e) {
      log.error('Props parse error for', id, e);
    }

    try {
      const element = React.default.createElement(Comp, await reconstructProps(rawProps, mods));

      // hydrateRoot reconciles against existing server HTML (initial page load).
      // createRoot renders fresh when the span is empty (HMR path — server sent
      // skipClientSSR=true so the span has no pre-rendered content to reconcile).
      let root: ReactRoot;
      if (node.innerHTML.trim()) {
        root = hydrateRoot(node, element);
      } else {
        const r = createRoot(node);
        r.render(element);
        root = r;
      }

      activeRoots.push(root);
      log.verbose('✓ Mounted:', id);
    } catch (err) {
      log.error('✗ Mount failed:', id, err);
    }
  }
}

// ─── Head tag sync ────────────────────────────────────────────────────────────

/**
 * Walks a <head> element and returns every Element node that lives between
 * the <!--n-head--> and <!--/n-head--> sentinel comments, plus the closing
 * comment node itself (used as the insertion anchor).
 *
 * The SSR renderer emits these sentinels around every useHtml()-generated tag
 * so the client can manage exactly that set without touching permanent tags
 * (charset, viewport, importmap, runtime <script>).
 */
function headBlock(head: HTMLHeadElement): { nodes: Element[]; closeComment: Comment | null } {
  const nodes: Element[] = [];
  let closeComment: Comment | null = null;
  let inside = false;

  for (const child of Array.from(head.childNodes)) {
    if (child.nodeType === Node.COMMENT_NODE) {
      const text = (child as Comment).data.trim();
      if (text === 'n-head')  { inside = true;  continue; }
      if (text === '/n-head') { closeComment = child as Comment; inside = false; continue; }
    }
    if (inside && child.nodeType === Node.ELEMENT_NODE)
      nodes.push(child as Element);
  }

  return { nodes, closeComment };
}

/** Stable key for an Element: tag name + sorted attribute list (name=value pairs). */
function fingerprint(el: Element): string {
  return el.tagName + '|' + Array.from(el.attributes)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(a => `${a.name}=${a.value}`)
    .join('&');
}

/**
 * Diffs the live <!--n-head--> block against the incoming document's block and
 * applies the minimal set of DOM mutations:
 *
 *   - Non-script tags (meta, link, style): fingerprint-diffed so shared layout
 *     tags are left untouched (avoids stylesheet flash on navigation).
 *   - Script tags: always removed and re-inserted as fresh elements so the
 *     browser re-executes them and re-fetches any changed src file.
 *     (Fingerprint diffing silently skips re-execution when src is unchanged.)
 *
 * If the live head has no sentinel block yet (e.g. initial page had no useHtml
 * tags), both sentinel comments are created on the fly.
 */
function syncHeadTags(doc: Document): void {
  const live = headBlock(document.head);
  const next = headBlock(doc.head);

  // Ensure we have an anchor to insert before.
  let anchor = live.closeComment;
  if (!anchor) {
    document.head.appendChild(document.createComment('n-head'));
    anchor = document.createComment('/n-head');
    document.head.appendChild(anchor);
  }

  // ── Scripts: always replace ──────────────────────────────────────────────
  // Remove all live script tags and re-insert fresh ones so the browser
  // executes them. src gets cache-busted so the latest file is fetched.
  for (const el of live.nodes)
    if (el.tagName === 'SCRIPT') el.remove();

  for (const el of next.nodes) {
    if (el.tagName === 'SCRIPT')
      document.head.insertBefore(cloneScriptForExecution(el), anchor);
  }

  // ── Everything else: fingerprint diff ────────────────────────────────────
  const liveMap = new Map<string, Element>();
  for (const el of live.nodes) if (el.tagName !== 'SCRIPT') liveMap.set(fingerprint(el), el);

  const nextMap = new Map<string, Element>();
  for (const el of next.nodes) if (el.tagName !== 'SCRIPT') nextMap.set(fingerprint(el), el);

  for (const [fp, el] of nextMap)
    if (!liveMap.has(fp)) document.head.insertBefore(el, anchor);

  for (const [fp, el] of liveMap)
    if (!nextMap.has(fp)) el.remove();
}

/**
 * Walks a <body> element and returns every Element node that lives between
 * the <!--n-body-scripts--> and <!--/n-body-scripts--> sentinel comments,
 * plus the closing comment node used as the insertion anchor.
 *
 * The SSR renderer emits these sentinels around every useHtml() body script
 * so the client can manage exactly that set without touching permanent nodes.
 */
function bodyScriptsBlock(body: HTMLBodyElement | Element): { nodes: Element[]; closeComment: Comment | null } {
  const nodes: Element[] = [];
  let closeComment: Comment | null = null;
  let inside = false;

  for (const child of Array.from(body.childNodes)) {
    if (child.nodeType === Node.COMMENT_NODE) {
      const text = (child as Comment).data.trim();
      if (text === 'n-body-scripts')  { inside = true;  continue; }
      if (text === '/n-body-scripts') { closeComment = child as Comment; inside = false; continue; }
    }
    if (inside && child.nodeType === Node.ELEMENT_NODE)
      nodes.push(child as Element);
  }

  return { nodes, closeComment };
}

/**
 * Creates a fresh <script> element from a parsed source element so the browser
 * actually executes it when inserted into the live document.
 *
 * Why: browsers only execute a <script> that is *created and inserted* into
 * the live document. Nodes moved from a DOMParser document are auto-adopted
 * but their script is silently skipped. Cloning via createElement is required.
 *
 * Cache-busting: src-based scripts get a ?t=<timestamp> query appended so the
 * browser always fetches the latest version from the server on HMR updates,
 * bypassing the module/response cache.
 */
function cloneScriptForExecution(src: Element): HTMLScriptElement {
  const el = document.createElement('script');
  for (const { name, value } of Array.from(src.attributes)) {
    if (name === 'src') {
      // Append a timestamp to force the browser to re-fetch the script file.
      const url = new URL(value, location.href);
      url.searchParams.set('t', String(Date.now()));
      el.setAttribute('src', url.toString());
    } else {
      el.setAttribute(name, value);
    }
  }
  // Copy inline content (for content-based scripts).
  if (src.textContent) el.textContent = src.textContent;
  return el;
}

/**
 * Replaces all body scripts in the <!--n-body-scripts--> sentinel block with
 * fresh elements from the incoming document.
 *
 * Unlike syncHeadTags (which diffs by fingerprint to avoid removing shared
 * stylesheets), body scripts must ALWAYS be removed and re-inserted so that:
 *   - File changes picked up by HMR are actually executed by the browser.
 *   - src-based scripts are cache-busted so the browser re-fetches them.
 *
 * Fingerprint diffing would silently skip re-execution of any script whose
 * src/attributes haven't changed, even if the file contents changed on disk.
 */
function syncBodyScripts(doc: Document): void {
  const live = bodyScriptsBlock(document.body);
  const next = bodyScriptsBlock(doc.body);

  // Always remove every existing body script — never leave stale ones.
  for (const el of live.nodes) el.remove();

  // Ensure we have a sentinel anchor to insert before.
  let anchor = live.closeComment;
  if (!anchor) {
    document.body.appendChild(document.createComment('n-body-scripts'));
    anchor = document.createComment('/n-body-scripts');
    document.body.appendChild(anchor);
  }

  // Insert every script from the incoming document as a brand-new element
  // so the browser executes it. src gets a timestamp to bust any cache.
  for (const el of next.nodes)
    document.body.insertBefore(cloneScriptForExecution(el), anchor);
}



/**
 * Syncs attributes from a parsed element onto the live document element.
 * Adds/updates attributes present in `next` and removes any that were set
 * on `live` but are absent in `next` (clears stale htmlAttrs/bodyAttrs).
 */
function syncAttrs(live: Element, next: Element): void {
  for (const { name, value } of Array.from(next.attributes))
    live.setAttribute(name, value);
  for (const { name } of Array.from(live.attributes))
    if (!next.hasAttribute(name)) live.removeAttribute(name);
}

/**
 * Listens for 'locationchange' events and performs a soft navigation:
 *
 *   1. Fetch the target URL as HTML (?__hmr=1 skips client-SSR for HMR speed).
 *   2. Parse the response with DOMParser.
 *   3. Apply all visual DOM changes first (head tags, html/body attrs, #app
 *      innerHTML, title, __n_data) so the new content is painted before React
 *      cleanup effects run — prevents a useHtml restore from briefly undoing
 *      the new document state.
 *   4. Unmount old React roots (runs cleanup effects against the already-updated DOM).
 *   5. Re-hydrate new client component markers.
 *   6. Scroll to top.
 *
 * Falls back to a full page reload if anything goes wrong.
 */
function setupNavigation(log: ReturnType<typeof makeLogger>): void {
  window.addEventListener('locationchange', async ({ detail: { href, hmr } }: any) => {
    try {
      const fetchUrl = hmr
        ? href + (href.includes('?') ? '&' : '?') + '__hmr=1'
        : href;

      const response = await fetch(fetchUrl, { headers: { Accept: 'text/html' } });
      // Allow HTML error pages (404, 500) to be rendered in-place via SPA
      // navigation. Only fall back to a full reload for non-HTML responses
      // (e.g. JSON API errors) where we have no page to display.
      if (!response.ok) {
        const ct = response.headers.get('content-type') ?? '';
        if (!ct.includes('text/html')) {
          log.error('Navigation fetch failed:', response.status, '— falling back to full reload');
          window.location.href = href;
          return;
        }
        log.info('Navigation returned', response.status, '— rendering error page in-place');
      }

      const parser  = new DOMParser();
      const doc     = parser.parseFromString(await response.text(), 'text/html');
      const newApp  = doc.getElementById('app');
      const currApp = document.getElementById('app');
      if (!newApp || !currApp) return;

      // ── Visual update — all DOM mutations before React teardown ────────────
      // Styles must be in place before new content appears to avoid an unstyled
      // flash. Unmounting runs useEffect cleanups (including useHtml restores)
      // which would temporarily revert document state if done first.

      // 1. Head tags — diff-based sync preserves shared layout tags untouched.
      syncHeadTags(doc);

      // 2. Body scripts (position='body') — diff-based sync mirrors head tag logic.
      syncBodyScripts(doc);

      // 3. <html> and <body> attributes (lang, class, style, etc.).
      syncAttrs(document.documentElement, doc.documentElement);
      syncAttrs(document.body, doc.body);

      // 4. Page content.
      currApp.innerHTML = newApp.innerHTML;

      // 5. <title>.
      const newTitle = doc.querySelector('title');
      if (newTitle) document.title = newTitle.textContent ?? '';

      // 6. Runtime data blob — must come after innerHTML swap so the new
      //    __n_data element is part of the live document.
      const newDataEl  = doc.getElementById('__n_data');
      const currDataEl = document.getElementById('__n_data');
      if (newDataEl && currDataEl) currDataEl.textContent = newDataEl.textContent;

      // ── React teardown ─────────────────────────────────────────────────────
      // Unmount after the visual update.  Cleanup effects now run against an
      // already-updated document, so there is nothing left to visually undo.
      activeRoots.splice(0).forEach(r => r.unmount());

      // ── Re-hydration ───────────────────────────────────────────────────────
      const navData = JSON.parse(currDataEl?.textContent ?? '{}') as RuntimeData;
      log.info('🔄 Route →', href, '— mounting', navData.hydrateIds?.length ?? 0, 'component(s)');

      const mods = await loadModules(navData.allIds ?? [], log, String(Date.now()));
      await mountNodes(mods, log);

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
  allIds:  string[];
  url:     string;
  params:  Record<string, any>;
  /** Query string parameters parsed from the URL. Multi-value keys are arrays. */
  query:   Record<string, string | string[]>;
  /**
   * Safe subset of the incoming request headers (cookie, authorization, and
   * proxy-authorization are stripped before embedding in the HTML document).
   */
  headers: Record<string, string>;
  debug:   ClientDebugLevel;
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
  // is captured (e.g. a redirect side-effect inside a component).
  setupNavigation(log);

  // Load all component bundles (not just hydrateIds) so SPA navigations to
  // related pages can mount their components without an extra network round-trip.
  const mods = await loadModules(data.allIds, log);
  await mountNodes(mods, log);

  log.info('🎉 Done!');

  // Patch history last so pushState calls during hydration don't trigger a
  // navigation before roots are ready.
  setupLocationChangeMonitor();
}