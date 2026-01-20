// // bench/http.ts
// import autocannon from 'autocannon';
// import FindMyWay from 'find-my-way';
// import { TrieRouter } from 'hono/router/trie-router';
// import http from 'http';
// import * as radix3 from 'radix3';
// import { URL } from 'url';
// import { ROUTES } from './routes';

// // Helper to create small servers exposing identical routes
// async function startFindMyWayServer(port = 0) {
//   const router = FindMyWay();
//   for (const r of ROUTES) {
//     router.on(r.method as any, r.path, (req, res, params) => {
//       res.writeHead(200, { 'content-type': 'application/json' });
//       res.end(JSON.stringify({ params }));
//     });
//   }
//   const srv = http.createServer((req, res) => {
//     const found = router.find((req.method ?? 'GET') as import('find-my-way').HTTPMethod, req.url ?? '/');
//     if (!found) {
//       res.writeHead(404);
//       return res.end('notfound');
//     }
//     // find-my-way will call handler directly; but here we call found.handler
//     // provide a store object and serialize searchParams into a plain object
//     const urlObj = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
//     const searchParams: { [k: string]: string } = {};
//     urlObj.searchParams.forEach((value, key) => {
//       searchParams[key] = value;
//     });
//     found.handler(req, res, found.params, {}, searchParams);
//   });
//   return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
//     const s = srv.listen(0, () => {
//       const p = (s.address() as any).port;
//       resolve({ port: p, close: () => new Promise(r => s.close(r)) });
//     });
//   });
// }

// async function startHonoTrieServer(port = 0) {
//   const router = new TrieRouter();
//   for (const r of ROUTES) {
//     router.add(r.path, r.method as any, (req: any, res: { status: number; body: string; }, next: any) => {
//       res.status = 200;
//       res.body = JSON.stringify({ ok: true });
//       // Hono router returns a handler; for a simple test we can call the handler
//       // but easiest is to map router.match at HTTP layer. Simpler approach:
//     });
//   }
//   // For simplicity in this bench, we construct a tiny dispatcher:
//   const srv = http.createServer((req, res) => {
//     const m = req.method ?? 'GET';
//     const url = req.url ?? '/';
//     const match = router.match(url, { method: m });
//     if (!match) {
//       res.writeHead(404);
//       return res.end('notfound');
//     }
//     res.writeHead(200, { 'content-type': 'application/json' });
//     res.end(JSON.stringify({ params: match.params ?? {} }));
//   });

//   return new Promise<{ port: number; close: () => Promise<void> }>(resolve => {
//     const s = srv.listen(0, () => resolve({ port: (s.address() as any).port, close: () => new Promise(r => s.close(r)) }));
//   });
// }

// async function startRadix3Server() {
//   const r = radix3();
//   for (const route of ROUTES) {
//     r.add(route.path, {}, (ctx: any) => {});
//   }
//   const srv = http.createServer((req, res) => {
//     const m = req.method ?? 'GET';
//     const url = req.url ?? '/';
//     const result = r.match(url, { method: m });
//     if (!result) {
//       res.writeHead(404);
//       return res.end('notfound');
//     }
//     res.writeHead(200, { 'content-type': 'application/json' });
//     res.end(JSON.stringify({ params: result.params ?? {} }));
//   });
//   return new Promise<{ port: number; close: () => Promise<void> }>(resolve => {
//     const s = srv.listen(0, () => resolve({ port: (s.address() as any).port, close: () => new Promise(r => s.close(r)) }));
//   });
// }

// async function runHttpBench() {
//   console.log('Starting servers...');
//   const f = await startFindMyWayServer();
//   const h = await startHonoTrieServer();
//   const r = await startRadix3Server();

//   async function autocannonRun(url: string) {
//     return new Promise<any>((resolve, reject) => {
//       const ac = autocannon({
//         url,
//         connections: 50,
//         duration: 10
//       }, (err: any, res: any) => {
//         if (err) reject(err);
//         else resolve(res);
//       });
//       autocannon.track(ac);
//     });
//   }

//   console.log('find-my-way ->', `http://localhost:${f.port}/user`);
//   console.log('hono-trie   ->', `http://localhost:${h.port}/user`);
//   console.log('radix3      ->', `http://localhost:${r.port}/user`);

//   console.log('Running autocannon for find-my-way...');
//   console.log(await autocannonRun(`http://localhost:${f.port}/user`));

//   console.log('Running autocannon for hono-trie...');
//   console.log(await autocannonRun(`http://localhost:${h.port}/user`));

//   console.log('Running autocannon for radix3...');
//   console.log(await autocannonRun(`http://localhost:${r.port}/user`));

//   await f.close();
//   await h.close();
//   await r.close();
// }

// runHttpBench().catch(e => { console.error(e); process.exit(1) });
