import { performance } from "perf_hooks";
import { HttpRouter } from "./";

// --- COMPETITORS ---
import FindMyWay from "find-my-way";
import { createRouter as createNuxtRouter } from "radix3";
import { RegExpRouter } from "hono/router/reg-exp-router";
import { pathToRegexp } from "path-to-regexp";

// =============================================================================
// 1. SETUP THE CONTENDERS
// =============================================================================

// --- A. YOUR ROUTER ---
const myRouter = new HttpRouter<string>();

// --- B. FASTIFY (find-my-way) ---
const fastifyRouter = FindMyWay();

// --- C. NUXT (radix3) ---
const nuxtRouter = createNuxtRouter();

// --- D. HONO ---
const honoRouter = new RegExpRouter<string>();

// --- E. EXPRESS (Simulation) ---
// Express doesn't expose a standalone performant router class easily,
// so we simulate its exact logic: Linear loop + path-to-regexp
const expressRoutes: { regex: RegExp; keys: any[]; handler: string }[] = [];

function addExpress(path: string, handler: string) {
  const keys: any[] = [];
  // Fix: Convert {id} -> :id for path-to-regexp compatibility
  const expressPath = path.replace(/{/g, ":").replace(/}/g, "");

  // @ts-ignore - bypassing strict type checks for benchmark simplicity
  const regex = pathToRegexp(expressPath, keys);

  // Handle case where pathToRegexp returns an object (version dependent) or regex
  const finalRegex = (regex as any).regexp || regex;

  expressRoutes.push({ regex: finalRegex, keys, handler });
}

function matchExpress(path: string) {
  for (const route of expressRoutes) {
    const match = route.regex.exec(path);
    if (match) return route.handler;
  }
  return null;
}

// =============================================================================
// 2. DEFINE THE DATASET
// =============================================================================

const staticRoutes = [
  "/api/v1/users",
  "/api/v1/posts",
  "/api/v1/comments",
  "/health",
  "/contact",
  "/about/team/management",
  "/products/categories/electronics/phones",
];

const paramRoutes = [
  "/api/v1/users/{id}",
  "/api/v1/posts/{id}/comments",
  "/products/{category}/{id}",
  "/files/{path}",
];

// Helper: Fastify/Nuxt/Hono use :id syntax, You use {id}
function toColon(path: string) {
  return path.replace(/{/g, ":").replace(/}/g, "");
}

console.log("Loading routes...");

const handler = "HANDLER";

// 1. Load Static
for (const route of staticRoutes) {
  myRouter.get(route, handler);
  fastifyRouter.on("GET", route, () => {});
  nuxtRouter.insert(route, { handler });
  honoRouter.add("GET", route, handler);
  addExpress(route, handler);
}

// 2. Load Dynamic
for (const route of paramRoutes) {
  myRouter.get(route, handler);

  const colonRoute = toColon(route);

  fastifyRouter.on("GET", colonRoute, () => {});
  nuxtRouter.insert(colonRoute, { handler });
  honoRouter.add("GET", colonRoute, handler);
  addExpress(route, handler);
}

// 3. Stress Load (500 routes)
for (let i = 0; i < 500; i++) {
  const r = `/stress/test/route-${i}`;
  myRouter.get(r, handler);
  fastifyRouter.on("GET", r, () => {});
  nuxtRouter.insert(r, { handler });
  honoRouter.add("GET", r, handler);
  addExpress(r, handler);
}

console.log(`Routes loaded: ${staticRoutes.length + paramRoutes.length + 500}`);

// =============================================================================
// 3. GENERATE TRAFFIC
// =============================================================================

const requests = [
  "/api/v1/users",
  "/products/categories/electronics/phones",
  "/api/v1/users/12345",
  "/products/laptops/macbook-pro",
  "/api/v1/unknown",
  "/admin/hidden/page",
  "/stress/test/route-250",
];

// =============================================================================
// 4. THE BENCHMARK
// =============================================================================

function bench(name: string, fn: () => void) {
  const start = performance.now();
  const ITERATIONS = 100_000;

  for (let i = 0; i < ITERATIONS; i++) {
    fn();
  }

  const total = performance.now() - start;
  const ops = Math.round((ITERATIONS / total) * 1000);

  console.log(
    `${name.padEnd(25)} | ${ops.toLocaleString().padStart(12)} ops/sec | ${total.toFixed(2)}ms`,
  );
}
console.log("Optimizing tree...");
myRouter.getMachine().optimize();

console.log("Starting benchmark...");

console.log("\n--- BENCHMARK RESULTS (Higher is Better) ---");
console.log("Router                    | Speed             | Total Time");
console.log("--------------------------|-------------------|-----------");

// Warmup
myRouter.lookup("GET", "/");

// 1. YOUR ROUTER
bench("Your HttpRouter", () => {
  for (const req of requests) myRouter.lookup("GET", req);
});

// 2. FASTIFY (Fix: use .find() instead of .lookup() to avoid 404/response logic)
bench("Fastify (find-my-way)", () => {
  for (const req of requests) fastifyRouter.find("GET", req);
});

// 3. NUXT (radix3)
bench("Nuxt (radix3)", () => {
  for (const req of requests) nuxtRouter.lookup(req);
});

// // 4. HONO (RegExpRouter)
// bench("Hono (Safe Match)", () => {
//   for (const req of requests) {
//     try {
//       honoRouter.match("GET", req);
//     } catch (e) {
//       // If Hono fails to match a specific complex path, we keep going
//     }
//   }
// });

// 5. EXPRESS (Linear)
bench("Express (Linear)", () => {
  for (const req of requests) matchExpress(req);
});
