// // bench/micro.ts
// import { performance } from 'perf_hooks';
// import { ROUTES } from './routes';

// // You will probably need to change the import path below to point at your router module:
// import { AetherRouter } from '../index'; // <-- edit this when you re-upload

// // External routers
// import FindMyWay, { type HTTPMethod } from 'find-my-way';
// import { TrieRouter } from 'hono/router/trie-router';
// import radix3 from 'radix3';

// type LookupFn = (method: string, path: string) => any;

// async function buildFindMyWayAdapter() {
//   const router = FindMyWay();
//   for (const r of ROUTES) router.on(r.method as HTTPMethod, r.path, (_req, _res, params) => params ?? {});
//   return (m: string, p: string) => router.find(m as HTTPMethod, p);
// }

// async function buildHonoTrieAdapter() {
//   const router = new TrieRouter();
//   // Hono routers expect a handler function; we register a noop handler.
//   for (const r of ROUTES) router.add(r.path, r.method as any, (_req: any, _res: any, _next: any) => {});
//   return (m: string, p: string) => router.match(m, p);
// }

// async function buildRadix3Adapter() {
//   // radix3 API: create router and add routes
//   const r = radix3();
//   for (const route of ROUTES) {
//     r.add(route.path, { method: route.method }, () => {});
//   }
//   return (m: string, p: string) => r.match(p, { method: m });
// }

// function buildRegexAdapter() {
//   // naive array of {method, regex, keys, handler}
//   const compiled = ROUTES.map(r => {
//     // convert :param to capture groups
//     const keys: any[] = [];
//     let rePath = r.path.replace(/:([^/]+)/g, (_m, name) => {
//       keys.push(name);
//       return '([^/]+)';
//     }).replace(/\*/g, '(.*)');
//     const re = new RegExp('^' + rePath + '$');
//     return { method: r.method, re, keys };
//   });

//   return (m: string, p: string) => {
//     for (const e of compiled) {
//       if (e.method !== m) continue;
//       const mo = e.re.exec(p);
//       if (!mo) continue;
//       const params: Record<string,string> = {};
//       for (let i = 0; i < e.keys.length; i++) params[e.keys[i]] = mo[i+1]!;
//       return { params };
//     }
//     return null;
//   };
// }

// async function run() {
//   // Build adapters
//   const adapters: { name: string; lookup: LookupFn }[] = [];

//   adapters.push({ name: 'find-my-way', lookup: await buildFindMyWayAdapter() });
//   adapters.push({ name: 'hono-trie', lookup: await buildHonoTrieAdapter() });
//   adapters.push({ name: 'radix3', lookup: await buildRadix3Adapter() });
//   adapters.push({ name: 'regex', lookup: buildRegexAdapter() });

//   // Optional: your router (attempt to import and build)
//   try {
//     // You must export a `createRouterAdapter(ROUTES)` that returns a `lookup` function.
//     // Example: export function createRouterAdapter(routes) { ... return (m,p)=>... }
//     // Adjust the path to your actual module when you re-upload.
//     // eslint-disable-next-line @typescript-eslint/no-var-requires
//     // const myAdapterModule = await import('../path/to/your-router.js');
//     // adapters.push({ name: 'my-router', lookup: await myAdapterModule.createRouterAdapter(ROUTES) });
//   } catch (e) {
//     // skip if not present
//   }

//   // Create a list of test paths (some static, some dynamic)
//   const testPaths = [
//     '/user', '/status', '/product/123', '/order/321/item/11',
//     '/this/is/a/very/long/static/path/for/testing', '/static/assets/js/app.js',
//     '/blog/2024/12/hello-world', '/x/item-12'
//   ];

//   const ITER = 2_000_000; // tune down if your machine is small
//   console.log(`Running ${ITER} lookups per adapter (warmup + measured).`);

//   for (const ad of adapters) {
//     // Warmup
//     for (let i = 0; i < 10000; i++) ad.lookup('GET', testPaths[i % testPaths.length]!);

//     // GC snapshot before
//     if ((globalThis as any).gc) (globalThis as any).gc();

//     const t0 = performance.now();
//     for (let i = 0; i < ITER; i++) {
//       ad.lookup(i % 2 ? 'GET' : 'POST', testPaths[i % testPaths.length]!);
//     }
//     const t1 = performance.now();
//     const sec = (t1 - t0) / 1000;
//     const ops = Math.round(ITER / sec);
//     console.log(`${ad.name.padEnd(16)} — ${ops.toLocaleString()} ops/sec (total ${Math.round(ITER).toLocaleString()} in ${sec.toFixed(3)}s)`);
//   }
// }

// run().catch(err => { console.error(err); process.exit(1); });