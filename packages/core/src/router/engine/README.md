# RadixEngine — High-Performance Route Discovery / Matching Engine (Bun/JSC-Oriented)

> **Purpose**
>
> `RadixEngine<T>` is a standalone, zero-dependency route discovery engine optimized for **fast path matching** in JavaScript runtimes with strong JITs (notably **Bun/JSC**).
>
> It is **not** a full router by itself. It matches a path against a set of route templates and returns:
>
> - whether a match was found
> - the matched value (handler/metadata)
> - capture ranges for parameters (start/end indices into the original path string)
> - optional wildcard range information for trailing `/*` routes
>
> A parent “router” layer can then assemble params (and optionally decode or normalize paths) using the metadata exposed by the engine.

---

## Table of contents

- [RadixEngine — High-Performance Route Discovery / Matching Engine (Bun/JSC-Oriented)](#radixengine--high-performance-route-discovery--matching-engine-bunjsc-oriented)
  - [Table of contents](#table-of-contents)
  - [Key features](#key-features)
  - [Core concepts](#core-concepts)
    - [Route templates](#route-templates)
    - [Parameters and captures](#parameters-and-captures)
    - [Wildcard routes](#wildcard-routes)
    - [Priority rules](#priority-rules)
  - [Performance model](#performance-model)
    - [Zero-allocation searching](#zero-allocation-searching)
    - [Why captures are ranges](#why-captures-are-ranges)
    - [ASCII / decoded-path contract](#ascii--decoded-path-contract)
  - [Public API](#public-api)
    - [`new RadixEngine<T>(options)`](#new-radixenginetoptions)
    - [`insert(template, value)`](#inserttemplate-value)
    - [`delete(template)`](#deletetemplate)
    - [`finalize(options)`](#finalizeoptions)
    - [`search(path)`](#searchpath)
    - [`searchInto(path, memoryPool, out)`](#searchintopath-memorypool-out)
    - [`getParamKeysForNode(nodeIndex)`](#getparamkeysfornodenodeindex)
    - [`isPrefix(prefix)`](#isprefixprefix)
    - [`prefixSearch(prefix)`](#prefixsearchprefix)
    - [Batch insertion APIs](#batch-insertion-apis)
  - [Integration patterns](#integration-patterns)
    - [Pattern A: ultra-fast boolean match](#pattern-a-ultra-fast-boolean-match)
    - [Pattern B: route match returning params](#pattern-b-route-match-returning-params)
    - [Pattern C: wildcard rest handling](#pattern-c-wildcard-rest-handling)
    - [Pattern D: integration with HTTP frameworks](#pattern-d-integration-with-http-frameworks)
  - [Template syntax reference](#template-syntax-reference)
    - [Literals](#literals)
    - [Escaping](#escaping)
    - [Parameters](#parameters)
    - [Multi-parameter segments](#multi-parameter-segments)
    - [Wildcard](#wildcard)
    - [Unsupported patterns](#unsupported-patterns)
  - [Operational notes](#operational-notes)
    - [Route deletion strategy](#route-deletion-strategy)
    - [Variant parameter edges](#variant-parameter-edges)
    - [Thread safety / reentrancy](#thread-safety--reentrancy)
    - [Memory sizing](#memory-sizing)
  - [Examples](#examples)
    - [Example 1: minimal usage](#example-1-minimal-usage)
    - [Example 2: router-style wrapper with param assembly](#example-2-router-style-wrapper-with-param-assembly)
    - [Example 3: supporting `/*` wildcards](#example-3-supporting--wildcards)
    - [Example 4: benchmarking correctly](#example-4-benchmarking-correctly)
  - [FAQ](#faq)
    - [Is this a full router?](#is-this-a-full-router)
    - [Why only trailing wildcard `/*`?](#why-only-trailing-wildcard-)
    - [Why limit param variants per node?](#why-limit-param-variants-per-node)
    - [Can I store anything as the value?](#can-i-store-anything-as-the-value)
    - [Can I cache param keys?](#can-i-cache-param-keys)

---

## Key features

- **Fast lookups**: designed for high throughput matching (`searchInto` hot path).
- **Static + parameter + wildcard routing**:
  - static path segments (`/api/health`)
  - parameters (`/api/users/{id}`)
  - multiple parameters per segment (`/api/files/{name}.{ext}`, `/api/v{version}/users/{id}`)
  - trailing wildcard (`/static/*`)
- **Zero-allocation search** when using `searchInto`.
- **Captures are returned as numeric ranges** into the original path string (no substring allocations during search).
- **Supports route deletion** (tombstone strategy: clears terminal but does not prune nodes).
- **Optional `finalize()`** to freeze updates and/or drop internal template map.
- **Prefix introspection**: `isPrefix()` and `prefixSearch()` for admin/inspection use cases.

---

## Core concepts

### Route templates

A **template** is a string beginning with `/` that may include:

- literal characters
- parameter expressions in `{braces}`
- a trailing wildcard segment `/*`

Examples:

- Static:
  - `/api/health`
  - `/api/version`

- Parameterized:
  - `/api/users/{id}`
  - `/api/users/{userId}/posts/{postId}`

- Multi-parameter segment:
  - `/api/files/{name}.{ext}`
  - `/api/v{version}/users/{id}`

- Wildcard:
  - `/static/*`
  - `/assets/*`

### Parameters and captures

`RadixEngine` does **not** allocate param objects during matching.

Instead, it writes **capture ranges** into a caller-provided `Uint32Array memoryPool`.

For capture index `i`:

- start index: `memoryPool[i*2]`
- end index: `memoryPool[i*2+1]`

The parent router later assembles params:

```ts
params[keys[i]] = path.substring(start, end);
```

The **param key names** (e.g. `"userId"`, `"postId"`) are stored as metadata on the **terminal node**, retrievable via `getParamKeysForNode(nodeIndex)` after a match.

### Wildcard routes

Wildcard is **only supported as a trailing segment**:

- `/static/*`
- `/assets/*`

When a wildcard route matches, `SearchResult` includes:

- `wildcardStart`: index in the path where the wildcard began consuming characters
- `wildcardEnd`: typically `path.length`

The engine does **not** allocate or store the wildcard “rest” string. Your router may compute it if needed:

```ts
const rest = path.slice(out.wildcardStart!, out.wildcardEnd!);
```

### Priority rules

When matching from a given node:

1. **Static transition** is attempted first.
2. **Parameter edges** (up to 4 variants) are attempted next.
3. **Wildcard edge** is attempted last.

This matches typical router expectations where exact/static routes override dynamic routes.

---

## Performance model

### Zero-allocation searching

The `searchInto()` API is designed to be called in the hot path:

- caller reuses a `Uint32Array` capture pool
- caller reuses a `SearchResult` output object

No new objects or strings are created during matching (beyond VM internals outside your control).

### Why captures are ranges

Building `{ paramName: string }` objects inside the matcher is expensive because it allocates:

- objects
- strings (substrings)
- arrays of keys

Instead, the engine:

- returns raw indices into the input path string
- the router only constructs strings if/when it actually needs them

This separation is a core performance tactic.

### ASCII / decoded-path contract

This engine is intended to operate on **already-decoded ASCII paths**.

Practical implications:

- If your incoming URL is percent-encoded (`%2F`, `%E2%9C%93`, etc), you should decode/normalize upstream.
- If you receive non-ASCII code units, you should reject/normalize upstream.

Many deployments enforce this at the HTTP layer (or choose to route on a normalized/decoded representation).

The engine may provide an `assumeAscii` optimization mode in some versions; when enabled, it relies on upstream enforcement.

---

## Public API

### `new RadixEngine<T>(options)`

Creates a new engine instance.

Typical generic type usage:

- `RadixEngine<Handler>`
- `RadixEngine<number>`
- `RadixEngine<{ method: string; handler: Function }>` etc.

Common options (implementation-dependent):

- `nodePoolSizeHint?: number`
  Hint for initial sizing of internal pools.

- `assumeAscii?: boolean` (if enabled in your build)
  Skip runtime ASCII validation for maximum throughput.

---

### `insert(template, value)`

```ts
engine.insert("/api/users/{id}", handler);
```

- Validates template syntax.
- Compiles parameter segments into a compact instruction stream.
- Inserts nodes into a trie.
- Throws on:
  - malformed template
  - duplicate route template (by exact string identity)
  - terminal overwrite attempts

**Important**: templates must begin with `/`.

---

### `delete(template)`

```ts
engine.delete("/api/users/{id}");
```

Deletion is **tombstone-based**:

- it clears the terminal value and terminal param metadata
- it does **not** prune structural nodes (to keep indices stable and deletion cheap)

If you inserted routes and later delete them, the trie can still contain shared structure for other routes.

If you used `finalize({ dropInternMap: true })`, deletion by template may no longer be available (implementation chooses to throw or no-op).

---

### `finalize(options)`

```ts
engine.finalize({ freeze: true, dropInternMap: true });
```

Typical uses:

- `freeze: true`
  Prevents further `insert` and `delete` calls. Helpful in production to enforce immutability.

- `dropInternMap: true`
  Drops template→terminal mapping to reduce memory. This typically disables `delete(template)`.

This is optional; you can skip it if you want a mutable router.

---

### `search(path)`

Convenience search returning a `SearchResult<T>`.

```ts
const res = engine.search("/api/users/123");
if (res.found) {
  console.log(res.value);
}
```

Implementation note: `search()` usually reuses an internal output object and pool for speed (so treat the returned object as ephemeral and do not store it long-term).

For maximum performance and reentrancy, prefer `searchInto()`.

---

### `searchInto(path, memoryPool, out)`

The primary hot-path API.

```ts
const pool = new Uint32Array(maxParams * 2);
const out: SearchResult<Handler> = { found: false };

const ok = engine.searchInto("/api/users/123", pool, out);
if (ok && out.found) {
  // out.value, out.nodeIndex, out.paramCount
}
```

Contract:

- `out` is mutated and reused (caller owns object).
- `memoryPool` is written starting at index 0.
- Caller must ensure `memoryPool.length >= maxParamsInAnyRoute * 2`.
- Returns boolean (often the same as `out.found`; exact semantics depend on your build but generally `true` indicates match success).

On success:

- `out.found === true`
- `out.value` is set
- `out.nodeIndex` is set
- `out.paramCount` is set (0 if no params)
- `out.wildcardStart/out.wildcardEnd` set only for wildcard matches

---

### `getParamKeysForNode(nodeIndex)`

Returns parameter names in **capture order** for the terminal node.

```ts
const keys = engine.getParamKeysForNode(out.nodeIndex!);
// e.g. ["userId", "postId"]
```

This call is allowed to allocate and is not intended for the hot loop. A router can cache these keys by `nodeIndex` if it wants.

---

### `isPrefix(prefix)`

Checks whether `prefix` is present as a static prefix in the trie.

```ts
engine.isPrefix("/api"); // true/false
```

This is typically used for introspection/admin tooling.

---

### `prefixSearch(prefix)`

Collects values for all routes under a prefix.

```ts
const handlers = engine.prefixSearch("/api/users");
```

This allocates and performs DFS; not intended for hot path.

---

### Batch insertion APIs

These are insert-time convenience/performance helpers:

- `insertBatchParallel(templates: string[], values: T[])`
- `insertBatch(entries: Array<[template: string, value: T]>)`
- `insertBatchFromObject(routes: Record<string, T>)`

They typically do preflight checks for duplicates and then call `insert`.

---

## Integration patterns

### Pattern A: ultra-fast boolean match

If you only need to know whether a route exists:

```ts
const pool = new Uint32Array(0);
const out: SearchResult<unknown> = { found: false };

function exists(path: string) {
  return engine.searchInto(path, pool, out) && out.found;
}
```

(If you might match param routes, you still need a pool large enough for the maximum capture count.)

---

### Pattern B: route match returning params

A common router wrapper:

```ts
type Match<T> =
  | { found: false }
  | { found: true; value: T; params: Record<string, string> };

const EMPTY_PARAMS: Record<string, string> = Object.freeze(Object.create(null));

function matchRoute<T>(
  engine: RadixEngine<T>,
  path: string,
  pool: Uint32Array,
  out: SearchResult<T>
): Match<T> {
  const ok = engine.searchInto(path, pool, out);
  if (!ok || !out.found) return { found: false };

  const value = out.value as T;
  const count = out.paramCount | 0;
  if (count === 0) return { found: true, value, params: EMPTY_PARAMS };

  const keys = engine.getParamKeysForNode(out.nodeIndex!);
  const params: Record<string, string> = Object.create(null);

  for (let i = 0; i < count; i++) {
    const start = pool[(i << 1)] | 0;
    const end = pool[(i << 1) + 1] | 0;
    params[keys[i]!] = path.substring(start, end);
  }

  return { found: true, value, params };
}
```

---

### Pattern C: wildcard rest handling

For a route like `/static/*`, you might want the “rest”:

```ts
if (out.found && out.wildcardStart != null) {
  const rest = path.slice(out.wildcardStart, out.wildcardEnd ?? path.length);
  // e.g. "images/logo.png"
}
```

Note: if you prefer the rest without leading slash, you can normalize:

```ts
const rest = path.slice(out.wildcardStart + 1);
```

(depending on whether your wildcardStart points at `/` or at the first char after `/` in your specific insertion point—verify with a small test.)

---

### Pattern D: integration with HTTP frameworks

Typical flow for an HTTP server:

1. Parse and validate URL.
2. Produce a normalized **decoded ASCII** path string.
3. Call `searchInto` with reused pool/out.
4. Dispatch to handler.

Example skeleton:

```ts
const engine = new RadixEngine<(req: Request) => Response>();
engine.insert("/api/health", () => new Response("ok"));
engine.insert("/api/users/{id}", (req) => new Response("user"));
engine.insert("/static/*", (req) => new Response("static"));

engine.finalize({ freeze: true });

const pool = new Uint32Array(16);
const out: SearchResult<(req: Request) => Response> = { found: false };

function handleRequest(req: Request): Response {
  const url = new URL(req.url);

  // Enforce decoded ASCII path upstream:
  // - use url.pathname (already decoded by WHATWG URL)
  // - optionally reject non-ASCII (depends on your policy)
  const path = url.pathname;

  if (!engine.searchInto(path, pool, out) || !out.found) {
    return new Response("Not Found", { status: 404 });
  }

  const handler = out.value!;
  return handler(req);
}
```

---

## Template syntax reference

### Literals

Any ASCII character other than special syntax (`{`, `}`, `*` in the wildcard position) is treated as a literal.

Examples:

- `/api/health`
- `/v1/users`

### Escaping

Use backslash to escape the next character as a literal:

- `\{` literal `{`
- `\}` literal `}`
- `\\` literal `\`

Example:

- `/literal/\{notAParam\}`

### Parameters

Parameters are written as:

- `{name}`

Name rules:

- `A-Z a-z 0-9 _`
- cannot be empty
- cannot repeat within the same template

Example:

- `/api/users/{id}`

### Multi-parameter segments

Multiple params can appear inside the same path segment as long as there are **static delimiters** between them:

- `/api/files/{name}.{ext}`
- `/api/v{version}/users/{id}`
- `/x/{a}-{b}-{c}.json`

The engine compiles these into a small instruction program per param edge.

### Wildcard

Only trailing wildcard segment `/*` is supported:

- `/static/*`
- `/assets/*`

The `*` must be:

- the last character of the template
- preceded by `/`

### Unsupported patterns

- Adjacent params without delimiters: `/{a}{b}` (unsupported)
- Non-trailing wildcard: `/static/*/x` (unsupported)
- Non-ASCII in templates (engine is ASCII-oriented)

---

## Operational notes

### Route deletion strategy

Deletion is “tombstone” based:

- fast
- stable indices
- avoids expensive pruning

If you need full pruning, it can be added as an admin-only compaction pass, but it is intentionally not in the hot path.

### Variant parameter edges

A node can host up to **4 parameter edge variants**. This supports cases like:

- `/x/{id}`
- `/x/{name}.{ext}`
- `/x/v{version}`
- etc.

If you exceed 4 variants at the same node, insertion throws.

### Thread safety / reentrancy

- Engine structure is safe to share for read-only use after you finish inserting routes.
- `searchInto` is reentrant as long as you provide separate `out`/`memoryPool` per concurrent request.
- `search()` reuses internal buffers and is **not** safe for concurrent use unless externally synchronized.

### Memory sizing

- `memoryPool` must be sized to `maxParams * 2`.
- If you don’t know the maximum, either:
  - precompute based on route set, or
  - allocate a generous pool (e.g. 32 or 64 pairs), or
  - rely on `search()` which maintains an internal pool sized by observed insertions

---

## Examples

### Example 1: minimal usage

```ts
import { RadixEngine } from "./engine";

const engine = new RadixEngine<string>();

engine.insert("/api/health", "health");
engine.insert("/api/users/{id}", "user");

const pool = new Uint32Array(4);
const out = { found: false } as any;

engine.searchInto("/api/users/123", pool, out);
console.log(out.found, out.value); // true "user"
```

---

### Example 2: router-style wrapper with param assembly

```ts
import { RadixEngine, type SearchResult } from "./engine";

type Handler = (path: string, params: Record<string, string>) => string;

const engine = new RadixEngine<Handler>();
engine.insert("/api/users/{userId}/posts/{postId}", (path, params) => {
  return `user=${params.userId} post=${params.postId}`;
});

const pool = new Uint32Array(8);
const out: SearchResult<Handler> = { found: false };

function route(path: string): string {
  if (!engine.searchInto(path, pool, out) || !out.found) return "404";

  const keys = engine.getParamKeysForNode(out.nodeIndex!);
  const params: Record<string, string> = Object.create(null);
  for (let i = 0; i < (out.paramCount ?? 0); i++) {
    const s = pool[i * 2]!;
    const e = pool[i * 2 + 1]!;
    params[keys[i]!] = path.substring(s, e);
  }

  return out.value!(path, params);
}

console.log(route("/api/users/456/posts/789"));
// "user=456 post=789"
```

---

### Example 3: supporting `/*` wildcards

```ts
const engine = new RadixEngine<number>();
engine.insert("/static/*", 1);

const pool = new Uint32Array(0);
const out: SearchResult<number> = { found: false };

engine.searchInto("/static/images/logo.png", pool, out);

if (out.found) {
  const rest = out.wildcardStart != null ? "/static/images/logo.png".slice(out.wildcardStart) : "";
  console.log(rest);
}
```

---

### Example 4: benchmarking correctly

To benchmark the engine fairly:

- do not allocate `pool` or `out` inside the hot loop
- do not build params (substring) during the search benchmark unless you’re intentionally benchmarking param assembly too

Correct:

```ts
const pool = new Uint32Array(16);
const out: SearchResult<any> = { found: false };

for (let i = 0; i < 1_000_000; i++) {
  engine.searchInto(paths[i & (paths.length - 1)], pool, out);
}
```

---

## FAQ

### Is this a full router?

No. It is a **matching engine**. A router layer should:

- normalize/validate paths (decoded ASCII contract)
- handle HTTP method matching if needed
- assemble params
- perform dispatch

### Why only trailing wildcard `/*`?

It dramatically simplifies matching and keeps the hot path fast and predictable. Non-trailing wildcards are powerful but expensive and can introduce ambiguity.

### Why limit param variants per node?

To keep the matching hot path bounded and predictable. In practice, most real-world route sets have very few dynamic patterns per prefix node.

### Can I store anything as the value?

Yes. `T` can be any type: handler functions, integers, objects, etc.

### Can I cache param keys?

Yes. A router can cache `nodeIndex -> keys[]` since `nodeIndex` is stable after insertion (especially if you freeze).

---

If you integrate this engine into your own router, strongly consider documenting and enforcing:

- “routing happens only on decoded ASCII paths”
- “`searchInto` is the hot path; avoid allocations there”
