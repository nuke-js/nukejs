/**
 * store.ts — NukeJS Client State Management
 *
 * Provides a lightweight, cross-boundary state system for "use client"
 * components.  The core problem it solves: NukeJS hydrates every client
 * component into its own independent React root (via hydrateRoot / createRoot),
 * so React Context cannot carry state across component boundaries.  Each
 * component's esbuild bundle is also a separate module instance, so a plain
 * module-level variable would not be shared between bundles.
 *
 * Solution: all store state lives in `window.__nukeStores`, a Map that persists
 * for the lifetime of the page regardless of how many times the store module
 * is evaluated.  Every bundle that imports `createStore('counter', …)` gets
 * a thin proxy object that reads from and writes to the same backing entry —
 * state is automatically shared across roots and bundles.
 *
 * API:
 *
 *   const cartStore = createStore('cart', { items: [], total: 0 });
 *
 *   // Inside any "use client" component on the same page:
 *   const items = useStore(cartStore, s => s.items);
 *   cartStore.setState(s => ({ ...s, items: [...s.items, newItem] }));
 *
 * The store is safe to import in server components — it detects the absence of
 * `window` and returns a lightweight no-op stub so SSR never throws.
 */

import { useSyncExternalStore } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

type Listener      = () => void;
type Unsubscribe   = () => void;
type Updater<T>    = T | ((prev: T) => T);

/**
 * A NukeJS store handle.  Create it once at module scope; pass it into
 * `useStore()` inside any client component to subscribe.
 */
export interface Store<T extends object> {
  /** Returns the current state snapshot. */
  getState(): T;

  /**
   * Updates the state and notifies every subscriber.
   *
   * Accepts a full replacement value or an updater function:
   *   store.setState({ count: 0 })
   *   store.setState(s => ({ ...s, count: s.count + 1 }))
   */
  setState(updater: Updater<T>): void;

  /**
   * Registers a change listener.  Returns an unsubscribe function.
   * Compatible with `useSyncExternalStore`.
   */
  subscribe(listener: Listener): Unsubscribe;

  /** The name this store is registered under in the global registry. */
  readonly name: string;

  /**
   * The value passed to `createStore` as its second argument.
   * Used internally as the server snapshot so `useSyncExternalStore` always
   * reconciles against a value that matches the server-rendered HTML —
   * the server never has mutations, so initial state is always what it renders.
   */
  readonly initialState: T;
}

// ─── Internal registry entry ──────────────────────────────────────────────────

interface StoreEntry<T> {
  state:     T;
  listeners: Set<Listener>;
}

// ─── Window registry ──────────────────────────────────────────────────────────

declare global {
  interface Window {
    __nukeStores?: Map<string, StoreEntry<any>>;
    __nukePersisted?: Set<string>;
  }
}

/**
 * Returns the process-wide store registry.
 *
 * On the server (no `window`) a fresh local Map is returned.  Server-side
 * access is a no-op because NukeJS never renders client components on the
 * server — this is purely a safety guard.
 */
function getRegistry(): Map<string, StoreEntry<any>> {
  if (typeof window === 'undefined') {
    // SSR: return a throw-away map; stores are client-only
    return new Map();
  }
  if (!window.__nukeStores) {
    window.__nukeStores = new Map();
  }
  return window.__nukeStores;
}

// ─── createStore ──────────────────────────────────────────────────────────────

/**
 * Creates (or retrieves) a named store backed by the page-global registry.
 *
 * If a store with the given `name` already exists in the registry (e.g.
 * because another bundle called `createStore` first), the existing entry is
 * reused and `initialState` is ignored.  This means the first bundle to run
 * wins the initial value — define your stores in a single shared file, or
 * treat `initialState` as a consistent default across all bundles.
 *
 * @param name          A unique string key for this store.
 * @param initialState  Default state used when the store is first created.
 */
export function createStore<T extends object>(name: string, initialState: T): Store<T> {
  const registry = getRegistry();

  if (!registry.has(name)) {
    registry.set(name, {
      state:     initialState,
      listeners: new Set(),
    } satisfies StoreEntry<T>);
  }

  // We hold a direct reference to the entry so closures below don't need to
  // re-look it up on every call.
  const entry = registry.get(name) as StoreEntry<T>;

  const subscribe = (listener: Listener): Unsubscribe => {
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  };

  const getState = (): T => entry.state;

  const setState = (updater: Updater<T>): void => {
    entry.state =
      typeof updater === 'function'
        ? (updater as (prev: T) => T)(entry.state)
        : updater;
    // Snapshot the listener set before iterating so a listener that calls
    // unsubscribe() during notification doesn't corrupt the iteration.
    for (const l of Array.from(entry.listeners)) l();
  };

  return { name, initialState, getState, setState, subscribe };
}

// ─── createPersistedStore ──────────────────────────────────────────────────────

/**
 * Creates a `Store` that survives full page refreshes by mirroring its state
 * into `localStorage` (or `sessionStorage`).
 *
 * A plain `createStore` only lives in `window.__nukeStores`, which is wiped
 * on every hard reload — fine for SPA navigations, not for data you want to
 * keep around. `createPersistedStore` wraps `createStore` and:
 *
 *   1. On first creation in the browser, reads any previously saved value
 *      from storage and applies it via `setState`.
 *   2. Subscribes to the store and writes the new state to storage on every
 *      change.
 *
 * `store.initialState` (used by `useStore` as the SSR snapshot) is left
 * untouched as the value you passed in — the persisted value is applied
 * *after* creation via `setState`, not by changing `initialState`. This
 * keeps the server-rendered HTML and the client's first hydration pass in
 * sync (no hydration mismatch); components simply re-render with the
 * persisted value immediately after mount, the same way `useSyncExternalStore`
 * already reconciles store mutations.
 *
 * Because `createStore` itself is idempotent per `name` but storage I/O is
 * not, a `window.__nukePersisted` set guards against re-running the
 * read/subscribe wiring if multiple bundles import the same persisted store.
 *
 * @param name          Unique store key — also used to derive the storage key.
 * @param initialState  Default state used when nothing is in storage yet.
 * @param options.storage  `'local'` (default) or `'session'`.
 * @param options.key      Override the storage key (defaults to `nuke-store:${name}`).
 *
 * @example
 * export const cartStore = createPersistedStore('cart', { items: [], total: 0 })
 *
 * @example
 * // Cleared when the tab closes, kept across refreshes within the session
 * export const draftStore = createPersistedStore('draft', { text: '' }, { storage: 'session' })
 */
export function createPersistedStore<T extends object>(
  name: string,
  initialState: T,
  options?: { storage?: 'local' | 'session'; key?: string },
): Store<T> {
  const store = createStore(name, initialState);

  if (typeof window === 'undefined') return store;

  const storageKey = options?.key ?? `nuke-store:${name}`;
  const backend = options?.storage === 'session' ? window.sessionStorage : window.localStorage;

  if (!window.__nukePersisted) window.__nukePersisted = new Set();
  if (window.__nukePersisted.has(storageKey)) return store;
  window.__nukePersisted.add(storageKey);

  try {
    const raw = backend.getItem(storageKey);
    if (raw !== null) store.setState(JSON.parse(raw) as T);
  } catch {
    // Corrupt or unparsable data — fall back to initialState.
  }

  store.subscribe(() => {
    try {
      backend.setItem(storageKey, JSON.stringify(store.getState()));
    } catch {
      // Storage full, disabled, or in a context (e.g. private mode) that
      // throws on write — fail silently rather than crash the app.
    }
  });

  return store;
}

// ─── useStore ─────────────────────────────────────────────────────────────────

/**
 * React hook that subscribes a component to a store.
 *
 * An optional `selector` lets you derive a slice of state.  The component
 * only re-renders when the selected value changes (by reference equality),
 * not on every store mutation.
 *
 * Works across independent React roots — any component on the page that calls
 * `useStore` with the same store will re-render when that store changes,
 * regardless of which component boundary each lives in.
 *
 * @example
 * // Full state
 * const state = useStore(cartStore);
 *
 * @example
 * // Selected slice — re-renders only when `items` changes
 * const items = useStore(cartStore, s => s.items);
 */
export function useStore<T extends object>(store: Store<T>): T;
export function useStore<T extends object, U>(store: Store<T>, selector: (state: T) => U): U;
export function useStore<T extends object, U = T>(
  store:     Store<T>,
  selector?: (state: T) => U,
): U {
  const getSnapshot = selector
    ? () => selector(store.getState())
    : () => store.getState() as unknown as U;

  // Server snapshot always uses initialState — the server never has mutations,
  // so this always matches what was rendered, preventing hydration mismatches
  // even after a store has been mutated during a previous SPA navigation.
  const getServerSnapshot = selector
    ? () => selector(store.initialState)
    : () => store.initialState as unknown as U;

  return useSyncExternalStore(
    store.subscribe,
    getSnapshot,
    getServerSnapshot,
  );
}