[![NukeJS Banner](.github/banner.png)](https://nukejs.com)

# NukeJS

A **minimal**, opinionated full-stack React framework on Node.js that server-renders everything and hydrates only interactive parts.

```
npm create nuke@latest
```

## Table of Contents

- [Overview](#overview)
- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Pages & Routing](#pages--routing)
- [Layouts](#layouts)
- [Client Components](#client-components)
- [API Routes](#api-routes)
- [Middleware](#middleware)
- [Static Files](#static-files)
- [useHtml() — Head Management](#usehtml--head-management)
- [Configuration](#configuration)
- [Building & Deploying](#building--deploying)

## Overview

NukeJS gives you:

| Feature | Description |
|---|---|
| **File-based routing** | Pages in `app/pages/`, API in `server/` |
| **Server-side rendering** | All pages rendered to HTML on the server |
| **Partial hydration** | Only `"use client"` components download JS |
| **SPA navigation** | Client-side page transitions after first load |
| **Hot module replacement** | Instant page updates during development |
| **Zero config** | Works out of the box; `nuke.config.ts` for overrides |
| **Deploy anywhere** | Node.js or Vercel serverless |

### The core idea

Most pages don't need JavaScript. NukeJS renders your entire React tree to HTML on the server, and only ships JavaScript for components explicitly marked `"use client"`. Everything else stays server-only — no hydration cost, no JS bundle for static content.

```tsx
// app/pages/index.tsx — Server component (zero JS sent to browser)
export default async function Home() {
  const posts = await db.getPosts(); // runs on server only
  return (
    <main>
      <h1>Blog</h1>
      {posts.map(p => <PostCard key={p.id} post={p} />)}
      <LikeButton postId={posts[0].id} />  {/* ← this one is interactive */}
    </main>
  );
}
```

```tsx
// app/components/LikeButton.tsx — Client component (JS downloaded)
"use client";
import { useState } from 'react';

export default function LikeButton({ postId }: { postId: string }) {
  const [liked, setLiked] = useState(false);
  return <button onClick={() => setLiked(!liked)}>{liked ? '❤️' : '🤍'}</button>;
}
```

---

## Getting Started

### Prerequisites

- Node.js 20+
- React 19+
- esbuild (peer dependency)

### Installation

```bash
npm create nuke
```

### Running the dev server

```bash
npm run dev
```

The server starts on port 3000 by default (auto-increments if in use).

---

## Project Structure

```
my-app/
├── app/
│   ├── pages/              # Page components (file-based routing)
│   │   ├── layout.tsx      # Root layout (wraps every page)
│   │   ├── index.tsx       # → /
│   │   ├── about.tsx       # → /about
│   │   └── blog/
│   │       ├── layout.tsx  # Blog section layout
│   │       ├── index.tsx   # → /blog
│   │       └── [slug].tsx  # → /blog/:slug
│   ├── components/         # Shared components (not routed)
│   └── public/             # Static files served at root (e.g. /favicon.ico)
├── server/                 # API route handlers
│   ├── users/
│   │   ├── index.ts        # → GET/POST /users
│   │   └── [id].ts         # → GET/PUT/DELETE /users/:id
│   └── auth.ts             # → /auth
├── middleware.ts           # (optional) global request middleware
├── nuke.config.ts          # (optional) configuration
└── package.json
```

---

## Pages & Routing

### Basic pages

Each `.tsx` file in `app/pages/` maps to a URL route:

| File | URL |
|---|---|
| `index.tsx` | `/` |
| `about.tsx` | `/about` |
| `blog/index.tsx` | `/blog` |
| `blog/[slug].tsx` | `/blog/:slug` |
| `docs/[...path].tsx` | `/docs/*` (catch-all, required) |
| `users/[[id]].tsx` | `/users` or `/users/42` (optional single segment) |
| `files/[[...path]].tsx` | `/files` or `/files/*` (optional catch-all) |

### Page component

A page exports a default React component. It may be async (runs on the server).

```tsx
// app/pages/blog/[slug].tsx
export default async function BlogPost({ slug }: { slug: string }) {
  const post = await fetchPost(slug);
  return (
    <article>
      <h1>{post.title}</h1>
      <p>{post.content}</p>
    </article>
  );
}
```

Route params are passed as props to the component.

### Catch-all routes

```tsx
// app/pages/docs/[...path].tsx
export default function Docs({ path }: { path: string[] }) {
  // path = ['getting-started', 'installation'] for /docs/getting-started/installation
  return <DocViewer segments={path} />;
}
```

### Route specificity

When multiple routes could match a URL, the most specific one wins:

```
/users/profile  → users/profile.tsx   (static, wins)
/users/42       → users/[id].tsx      (dynamic)
/users          → users/[[id]].tsx    (optional single, matches with no id)
/users/a/b/c    → users/[...rest].tsx (catch-all)
```

Specificity order, highest to lowest: static → `[param]` → `[[param]]` → `[...catchAll]` → `[[...optionalCatchAll]]`.

---

## Layouts

Place a `layout.tsx` alongside your pages to wrap a group of routes.

```tsx
// app/pages/layout.tsx — Wraps every page
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <Nav />
      <main>{children}</main>
      <Footer />
    </div>
  );
}
```

Layouts nest automatically. A page at `blog/[slug].tsx` gets wrapped by both `layout.tsx` (root) and `blog/layout.tsx` (blog section).

### Title templates in layouts

```tsx
// app/pages/layout.tsx
import { useHtml } from 'nukejs';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  useHtml({ title: (prev) => `${prev} | Acme Corp` });
  return <>{children}</>;
}

// app/pages/about.tsx
export default function About() {
  useHtml({ title: 'About Us' });
  // Final title: "About Us | Acme Corp"
  return <h1>About</h1>;
}
```

---

## Client Components

Add `"use client"` as the very first line of any component file to make it a **client component**. NukeJS will:

1. Bundle that file separately and serve it as `/__client-component/<id>.js`
2. Render a `<span data-hydrate-id="…">` placeholder in the server HTML
3. Hydrate the placeholder with React in the browser

```tsx
"use client";
import { useState, useEffect } from 'react';

export default function Counter({ initial = 0 }: { initial?: number }) {
  const [count, setCount] = useState(initial);
  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(c => c + 1)}>+</button>
    </div>
  );
}
```

### Rules for client components

- The `"use client"` directive must be the **first non-comment line**
- The component must have a **named default export** (NukeJS uses the function name to match props during hydration)
- Props must be **JSON-serializable** (no functions, no class instances)
- React elements passed as props are supported (serialized and reconstructed)

### Passing children to client components

Children and other React elements can be passed as props — NukeJS serializes them at render time:

```tsx
// Server component
<Modal>
  <p>This content is from the server</p>
</Modal>

// Modal is a "use client" component; its children are serialized as
// { __re: 'html', tag: 'p', props: { children: 'This content...' } }
// and reconstructed in the browser before mounting.
```

---

## API Routes

Export named HTTP method handlers from `.ts` files in your `server/` directory.

```ts
// server/users/index.ts
import type { ApiRequest, ApiResponse } from 'nukejs';

export async function GET(req: ApiRequest, res: ApiResponse) {
  const users = await db.getUsers();
  res.json(users);
}

export async function POST(req: ApiRequest, res: ApiResponse) {
  const user = await db.createUser(req.body);
  res.json(user, 201);
}
```

```ts
// server/users/[id].ts
export async function GET(req: ApiRequest, res: ApiResponse) {
  const { id } = req.params as { id: string };
  const user = await db.getUser(id);
  if (!user) { res.json({ error: 'Not found' }, 404); return; }
  res.json(user);
}

export async function DELETE(req: ApiRequest, res: ApiResponse) {
  await db.deleteUser(req.params!.id as string);
  res.status(204).end();
}
```

### Request object

| Property | Type | Description |
|---|---|---|
| `req.body` | `any` | Parsed JSON body (or raw string), up to 10 MB |
| `req.params` | `Record<string, string \| string[]>` | Dynamic route segments |
| `req.query` | `Record<string, string>` | URL search params |
| `req.method` | `string` | HTTP method |
| `req.headers` | `IncomingHttpHeaders` | Request headers |

### Response object

| Method | Description |
|---|---|
| `res.json(data, status?)` | Send a JSON response (default status 200) |
| `res.status(code)` | Set status code and return `res` for chaining |
| `res.setHeader(name, value)` | Set a response header |
| `res.end(body?)` | Send raw response |

---

## Middleware

Create `middleware.ts` in your project root to intercept every request before routing:

```ts
// middleware.ts
import type { IncomingMessage, ServerResponse } from 'http';

export default async function middleware(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Logging
  console.log(`${req.method} ${req.url}`);

  // Auth guard
  if (req.url?.startsWith('/admin') && !isAuthenticated(req)) {
    res.statusCode = 401;
    res.end('Unauthorized');
    return; // End response to halt further processing
  }

  // Header injection (let request continue without ending it)
  res.setHeader('X-Powered-By', 'nukejs');
}
```

If `res.end()` (or `res.json()`) is called, NukeJS stops processing and does not handle the request through routing. If middleware returns without ending the response, the request continues to API routes or SSR.

---

## Static Files

Place any file in `app/public/` and it will be served directly at its path relative to that directory — no route file needed.

```
app/public/
├── favicon.ico        → GET /favicon.ico
├── robots.txt         → GET /robots.txt
├── logo.png           → GET /logo.png
└── fonts/
    └── inter.woff2    → GET /fonts/inter.woff2
```

Every file type is served with the correct `Content-Type` automatically (images, fonts, CSS, video, audio, JSON, WASM, etc.).

Reference public files directly in your components:

```tsx
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <link rel="icon" href="/favicon.ico" />
      <img src="/logo.png" alt="Logo" />
      {children}
    </>
  );
}
```

### Deployment behaviour

| Environment | How public files are served |
|---|---|
| `nuke dev` | Served by the built-in middleware before any API or SSR routing |
| `nuke build` (Node) | Copied to `dist/static/` and served by the production HTTP server |
| `nuke build` (Vercel) | Copied to `.vercel/output/static/` — served by Vercel's CDN, no function invocation |

On Vercel, public files receive the same zero-latency CDN treatment as `__react.js` and `__n.js`.

---

## useHtml() — Head Management

The `useHtml()` hook works in both server components and client components to control the document head.

```tsx
import { useHtml } from 'nukejs';

export default function Page() {
  useHtml({
    title: 'My Page',

    meta: [
      { name: 'description', content: 'Page description' },
      { property: 'og:title', content: 'My Page' },
    ],

    link: [
      { rel: 'canonical', href: 'https://example.com/page' },
      { rel: 'stylesheet', href: '/styles.css' },
    ],

    htmlAttrs: { lang: 'en', class: 'dark' },
    bodyAttrs: { class: 'page-home' },
  });

  return <main>...</main>;
}
```

### Title resolution order

When both a layout and a page call `useHtml({ title })`, they are resolved in this order:

```
Layout: useHtml({ title: (prev) => `${prev} | Site` })
Page:   useHtml({ title: 'Home' })
Result: "Home | Site"
```

The page title always serves as the base value; layout functions wrap it outward.

---

## Configuration

Create `nuke.config.ts` in your project root:

```ts
// nuke.config.ts
export default {
  // Directory containing API route files (default: './server')
  serverDir: './server',

  // Port for the dev server (default: 3000, auto-increments if in use)
  port: 3000,

  // Logging verbosity
  // false    — silent (default)
  // 'error'  — errors only
  // 'info'   — startup messages + errors
  // true     — verbose (all debug output)
  debug: false,
};
```

---

## Link Component & Navigation

Use the built-in `<Link>` component for client-side navigation (no full page reload):

```tsx
import { Link } from 'nukejs';

export default function Nav() {
  return (
    <nav>
      <Link href="/">Home</Link>
      <Link href="/about">About</Link>
      <Link href="/blog">Blog</Link>
    </nav>
  );
}
```

### useRouter

```tsx
"use client";
import { useRouter } from 'nukejs';

export default function SearchForm() {
  const router = useRouter();
  return (
    <button onClick={() => router.push('/results?q=nuke')}>
      Search
    </button>
  );
}
```

---

## Building & Deploying

### Node.js server

```bash
npm run build       # builds to dist/
node dist/index.mjs # starts the production server
```

The build output:

```
dist/
├── api/            # Bundled API route handlers (.mjs)
├── pages/          # Bundled page handlers (.mjs)
├── static/
│   ├── __react.js          # Bundled React runtime
│   ├── __n.js              # NukeJS client runtime
│   ├── __client-component/ # Bundled "use client" component files
│   └── <app/public files>  # Copied from app/public/ at build time
├── manifest.json   # Route dispatch table
└── index.mjs       # HTTP server entry point
```

### Vercel
Just import the code from GitHub.

### Environment variables

| Variable | Description |
|---|---|
| `ENVIRONMENT=production` | Disables HMR and file watching |
| `PORT` | Port for the production server |

## License

MIT