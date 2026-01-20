// routes.ts
export type Route = { method: string; path: string };

export const ROUTES: Route[] = [
  // short static
  { method: 'GET', path: '/user' },
  { method: 'GET', path: '/status' },
  { method: 'GET', path: '/health' },

  // static with same radix
  { method: 'GET', path: '/user/profile' },
  { method: 'GET', path: '/user/settings' },
  { method: 'GET', path: '/user/sessions' },

  // dynamic
  { method: 'GET', path: '/product/:id' },
  { method: 'GET', path: '/order/:orderId/item/:itemId' },

  // long static
  { method: 'GET', path: '/this/is/a/very/long/static/path/for/testing' },

  // wildcard
  { method: 'GET', path: '/static/*' },

  // mixed and catch-all
  { method: 'GET', path: '/blog/:year/:month/:slug' },
  { method: 'POST', path: '/user/:id/action' },

  // more entries to increase trie density (you can expand as needed)
  ...Array.from({ length: 200 }).map((_, i) => ({ method: 'GET', path: `/x/item-${i}` }))
];

export type RouterAdapter = {
  name: string;
  create(): Promise<{ register: (m: string, p: string, h: Function) => void; lookup: (m: string, p: string) => any }>;
  createServer?: () => { listen: (port: number) => Promise<{ close: () => Promise<void> }>, handler: (req: Request, res: Response) => void };
};