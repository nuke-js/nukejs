// ─── Client-side hooks & components ────────────────────────────────────────
export { useHtml } from './use-html';
export type {
    HtmlOptions,
    TitleValue,
    HtmlAttrs,
    BodyAttrs,
    MetaTag,
    LinkTag,
    ScriptTag,
    StyleTag,
} from './use-html';

export { default as useRouter } from './as-is/useRouter';

export { default as Link } from './as-is/Link';

// ─── Client runtime (browser bootstrap) ────────────────────────────────────
export { setupLocationChangeMonitor, initRuntime } from './bundle';
export type { RuntimeData } from './bundle';

// ─── Shared utilities ───────────────────────────────────────────────────────
export { escapeHtml } from './utils';

export { ansi, c, log, setDebugLevel, getDebugLevel } from './logger';
export type { DebugLevel } from './logger';
