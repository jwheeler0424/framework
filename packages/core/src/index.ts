import { RouterBenchmark } from "./router/benchmark";
import { RadixEngine, type SearchResult } from "./router/engine";

import findMyWay from "find-my-way";
import { TrieRouter } from "hono/router/trie-router";
import { createRouter as createRadix3Router } from "radix3";

function mem(label: string) {
  const m = process.memoryUsage();
  console.log(
    `${label} rss=${(m.rss / 1024 / 1024).toFixed(2)}MB ` +
    `heapUsed=${(m.heapUsed / 1024 / 1024).toFixed(2)}MB ` +
    `external=${(m.external / 1024 / 1024).toFixed(2)}MB`,
  );
}

type BenchRouter = { search(path: string): boolean };

class RegexRouter implements BenchRouter {
  private routes: { re: RegExp }[] = [];
  add(route: string) {
    this.routes.push({ re: compileRouteToRegExp(route) });
  }
  addBatch(routes: Array<{ route: string }>) {
    for (const r of routes) this.add(r.route);
  }
  search(path: string): boolean {
    for (let i = 0; i < this.routes.length; i++)
      if (this.routes[i]!.re.test(path)) return true;
    return false;
  }
}

function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileRouteToRegExp(route: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < route.length) {
    const ch = route[i]!;
    if (ch === "{") {
      i++;
      while (i < route.length && route[i] !== "}") i++;
      if (i < route.length && route[i] === "}") i++;
      out += "([^/]+)";
      continue;
    }
    if (ch === "*") {
      i++;
      out += "(.*)";
      continue;
    }
    out += escapeRegExpLiteral(ch);
    i++;
  }
  out += "$";
  return new RegExp(out);
}

class RadixEngineAdapter implements BenchRouter {
  private engine: RadixEngine<unknown>;
  private pool: Uint32Array;
  private out: SearchResult<any>;

  constructor() {
    this.engine = new RadixEngine({ assumeAscii: true });
    this.pool = new Uint32Array(8 * 2);
    this.out = { found: false };
  }

  add(route: string) {
    this.engine.insert(route, 1);
  }

  addBatch(routes: Array<{ route: string }>) {
    for (const r of routes) this.add(r.route);
  }

  search(path: string): boolean {
    return this.engine.searchInto(path, this.pool, this.out);
  }
}

/**
 * find-my-way adapter
 * - find-my-way is method-aware; we'll register GET routes.
 * - lookup(req, res) dispatches handler; find() uses internal find() if available,
 *   otherwise does a tiny lookup with dummy req.
 */
class FindMyWayAdapter implements BenchRouter {
  private fmw: any;
  private _matched: boolean;

  constructor() {
    this.fmw = findMyWay({ ignoreTrailingSlash: false, caseSensitive: true });
    this._matched = false;
  }

  // Shared handler (stable identity, no per-route allocations beyond registration)
  private _handler = (_req: any, _res: any, _params: any) => {
    this._matched = true;
  };

  add(route: string) {
    const fmwRoute = route.replace(/\{([^}]+)\}/g, ":$1");
    this.fmw.on("GET", fmwRoute, this._handler);
  }

  addBatch(routes: Array<{ route: string }>) {
    for (const r of routes) this.add(r.route);
  }

  search(path: string): boolean {
    if (typeof this.fmw.find === "function") {
      return this.fmw.find("GET", path) != null;
    }

    this._matched = false;
    const req: any = { method: "GET", url: path };
    const res: any = {};

    this.fmw.lookup(req, res, () => {
      // not found; keep _matched=false
    });

    return this._matched;
  }
}

/**
 * Hono TrieRouter adapter
 * - TrieRouter#add(method, path, handler)
 * - TrieRouter#match(method, path) returns [handler, params] style (varies by version)
 */
class HonoTrieAdapter implements BenchRouter {
  private r: TrieRouter<any>;
  constructor() {
    this.r = new TrieRouter();
  }
  add(route: string) {
    // Hono uses ":id" for params and "*" for wildcard segments
    const honoRoute = route.replace(/\{([^}]+)\}/g, ":$1");
    this.r.add("GET", honoRoute, () => {});
  }
  addBatch(routes: Array<{ route: string }>) {
    for (const r of routes) this.add(r.route);
  }
  search(path: string): boolean {
    const m: any = (this.r as any).match("GET", path);
    // Hono match return differs by version:
    // - v4 trie-router typically returns { handlers: [...], params: {...} } OR [handlers, params]
    if (!m) return false;
    if (Array.isArray(m)) return m[0] && m[0].length > 0;
    if (m.handlers) return m.handlers.length > 0;
    if (m[0]) return true;
    return false;
  }
}

/**
 * radix3 adapter
 * radix3 route syntax uses ":param" and "*" (depending on version).
 * API (common):
 * - const r = createRouter()
 * - r.insert(path, value) or r.add(path, value)
 * - r.lookup(path) or r.match(path)
 */
class Radix3Adapter implements BenchRouter {
  private r: any;
  constructor() {
    this.r = createRadix3Router();
  }
  add(route: string) {
    const radixRoute = route.replace(/\{([^}]+)\}/g, ":$1");
    // Try common APIs
    if (typeof this.r.insert === "function") this.r.insert(radixRoute, 1);
    else if (typeof this.r.add === "function") this.r.add(radixRoute, 1);
    else if (typeof this.r.set === "function") this.r.set(radixRoute, 1);
    else
      throw new Error("Unsupported radix3 router API: expected insert/add/set");
  }
  addBatch(routes: Array<{ route: string }>) {
    for (const r of routes) this.add(r.route);
  }
  search(path: string): boolean {
    if (typeof this.r.lookup === "function") {
      const res = this.r.lookup(path);
      return !!(res && (res.value ?? res.data ?? res));
    }
    if (typeof this.r.match === "function") {
      const res = this.r.match(path);
      return !!(res && (res.value ?? res.data ?? res));
    }
    if (typeof this.r.find === "function") {
      const res = this.r.find(path);
      return !!(res && (res.value ?? res.data ?? res));
    }
    throw new Error(
      "Unsupported radix3 router API: expected lookup/match/find",
    );
  }
}

async function runOne(
  name: string,
  router: BenchRouter,
  requests: Array<{ method: string; path: string }>,
) {
  console.log(`\n--- Throughput Benchmark - ${name} (1M iterations) ---`);
  const thr = await RouterBenchmark.measureFindThroughput(
    router as any,
    requests,
    1_000_000,
  );
  console.log(`Throughput: ${(thr.opsPerSec / 1_000_000).toFixed(2)}M ops/sec`);
  console.log(`Avg Latency: ${thr.avgLatencyNs.toFixed(2)} ns`);
  console.log(`Min Latency: ${thr.minLatencyNs.toFixed(2)} ns`);
  console.log(`Max Latency: ${thr.maxLatencyNs.toFixed(2)} ns`);
  console.log(`P50 Latency: ${thr.p50Ns.toFixed(2)} ns`);
  console.log(`P95 Latency: ${thr.p95Ns.toFixed(2)} ns`);
  console.log(`P99 Latency: ${thr.p99Ns.toFixed(2)} ns`);

  console.log(`\n--- Memory Profiling - ${name} ---`);
  const memp = await RouterBenchmark.profileMemory(
    router as any,
    requests,
    100_000,
  );
  console.log(
    `Heap Before: ${(memp.heapUsedBefore / 1024 / 1024).toFixed(2)} MB`,
  );
  console.log(
    `Heap After: ${(memp.heapUsedAfter / 1024 / 1024).toFixed(2)} MB`,
  );
  console.log(`Heap Growth: ${(memp.heapGrowth / 1024 / 1024).toFixed(2)} MB`);
}

async function comprehensiveExample() {
  console.log("=".repeat(80));
  console.log("RADIX ROUTER ENGINE - COMPREHENSIVE BENCHMARK");
  console.log("=".repeat(80));

  mem("Startup:");

  const noopAsync: any = async () => {};

  const routes = [
    ["/api/health", noopAsync],
    ["/api/metrics", noopAsync],
    ["/api/version", noopAsync],

    ["/api/users/{id}", noopAsync],
    ["/api/posts/{id}", noopAsync],
    ["/api/products/{id}", noopAsync],

    ["/api/users/{userId}/posts/{postId}", noopAsync],
    ["/api/orgs/{orgId}/repos/{repoId}/issues/{issueId}",
      noopAsync,
    ],

    ["/api/files/{name}.{ext}", noopAsync],
    ["/api/v{version}/users/{id}", noopAsync],

    ["/static/*", noopAsync],
    ["/assets/*", noopAsync],

    ["/api/sample/health", noopAsync],
    ["/api/sample/metrics", noopAsync],
    ["/api/sample/version", noopAsync],

    ["/api/sample/users/{id}", noopAsync],
    ["/api/sample/posts/{id}", noopAsync],
    ["/api/sample/products/{id}", noopAsync],

    ["/api/sample/users/{userId}/posts/{postId}", noopAsync],
    ["/api/sample/orgs/{orgId}/repos/{repoId}/issues/{issueId}",
      noopAsync,
    ],

    ["/api/sample/files/{name}.{ext}", noopAsync],
    ["/api/sample/v{version}/users/{id}", noopAsync],

    ["/static/sample/*", noopAsync],
    ["/assets/sample/*", noopAsync],
  ];

  // Requests
  const requests = [
    { method: "GET", path: "/api/health" },
    { method: "GET", path: "/api/users/123" },
    { method: "GET", path: "/api/users/456/posts/789" },
    { method: "GET", path: "/api/files/document.pdf" },
    { method: "GET", path: "/static/images/logo.png" },
  ];

  // Build Aether
  const aether = new RadixEngineAdapter();
  aether.addBatch(routes.map((r) => ({ route: r[0] })));
  // IMPORTANT: finalize to apply densifyLevels + compaction for best small+large performance
  // aether.finalize({
  //   densifyLevels: 2,
  //   compactSparse: true,
  //   compactStaticPool: true,
  //   freeze: true,
  //   dropInternMap: true,
  // });

  // Build Regex
  const regex = new RegexRouter();
  regex.addBatch(routes.map((r) => ({ route: r[0] })));

  // Build find-my-way
  const fmw = new FindMyWayAdapter();
  fmw.addBatch(routes.map((r) => ({ route: r[0] })));

  // Build Hono trie
  const hono = new HonoTrieAdapter();
  hono.addBatch(routes.map((r) => ({ route: r[0] })));

  // Build radix3
  const radix = new Radix3Adapter();
  radix.addBatch(routes.map((r) => ({ route: r[0] })));

  mem("After build:");

  await runOne("Radix Engine", aether as any, requests);
  await runOne("Regex Router", regex as any, requests);
  await runOne("find-my-way (Fastify)", fmw as any, requests);
  await runOne("Hono TrieRouter", hono as any, requests);
  await runOne("radix3", radix as any, requests);

  mem("End:");
  console.log("\n" + "=".repeat(80));
}

comprehensiveExample().catch(console.error);
