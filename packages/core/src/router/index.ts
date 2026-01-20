import RadixEngine, { type AllowedDelimiter, type SearchResult } from "./engine"; // Assuming your engine is in index.ts
import type { EventContext, Handler, HttpContext, Pipeline, RouteContext, RouteRecord, SseContext } from "./types";

// ============================================================================
// 3. THE UNIFIED AETHER ROUTER
// ============================================================================
type ConfigOptions = {
  eventDelimiter: AllowedDelimiter;
}
export class AetherRouter {
  private engines = new Map<string, RadixEngine<RouteRecord<any>>>();
  private groupStack: { prefix: string; middleware: Handler<any>[] }[] = [{ prefix: '', middleware: [] }];

  // Reusable search artifacts (Zero-Allocation matching)
  private _pool = new Uint32Array(32);
  private _out: SearchResult<RouteRecord<any>> = { found: false };

  constructor(private config: ConfigOptions = { eventDelimiter: ':' }) {}

  private getEngine(key: string, delimiter: AllowedDelimiter): RadixEngine<RouteRecord<any>> {
    if (!this.engines.has(key)) {
      this.engines.set(key, new RadixEngine({ delimiter }));
    }
    return this.engines.get(key)!;
  }

  // --- Registration Helpers ---

  group(prefix: string, middleware: Handler<any>[], callback: () => void) {
    const parent = this.groupStack[this.groupStack.length - 1]!;
    this.groupStack.push({
      prefix: parent.prefix + prefix,
      middleware: [...parent.middleware, ...middleware]
    });
    callback();
    this.groupStack.pop();
  }

  private register<T extends RouteContext>(method: string, pattern: string, handlers: Handler<T>[], isSse = false) {
    const current = this.groupStack[this.groupStack.length - 1]!;
    const isEvent = !['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method);
    const engine = this.getEngine(method, isEvent ? this.config.eventDelimiter : '/');

    engine.insert(current.prefix + pattern, {
      pipeline: [...current.middleware, ...handlers] as any,
      isSse
    });
  }

  // --- Public API ---

  get(path: string, ...h: Handler<HttpContext>[]) { this.register('GET', path, h); }
  post(path: string, ...h: Handler<HttpContext>[]) { this.register('POST', path, h); }
  on(event: string, ...h: Handler<EventContext>[]) { this.register(event.split(this.config.eventDelimiter)[0]!, event, h); }

  sse(path: string, ...h: Handler<SseContext>[]) {
    this.register('GET', path, h, true);
  }

  // --- The Dispatcher (The "Engine" bridge) ---

  async handle(req: Request): Promise<Response | void> {
    const url = new URL(req.url);
    const engine = this.engines.get(req.method);
    if (!engine) return new Response("Method Not Allowed", { status: 405 });

    const ok = engine.searchInto(url.pathname, this._pool, this._out);
    if (!ok || !this._out.found) return new Response("Not Found", { status: 404 });

    const record = this._out.value!;
    const params = this.extractParams(url.pathname, engine, this._out);

    if (record.isSse) {
      return this.handleSse(req, params, record.pipeline);
    }

    const ctx = await this.createHttpContext(req, url, params);
    await this.runPipeline(ctx, record.pipeline);
    return (ctx as any)._response || new Response("OK");
  }

  handleEvent(ws: any, message: any) {
    const data = JSON.parse(message);
    const eventName = data.event || '';
    const engine = this.engines.get(eventName.split(this.config.eventDelimiter)[0]);

    if (engine && engine.searchInto(eventName, this._pool, this._out)) {
      const params = this.extractParams(eventName, engine, this._out);
      const ctx = this.createEventContext(ws, data, eventName, params);
      this.runPipeline(ctx, this._out.value!.pipeline);
    }
  }

  // --- Internal Factories ---

  private extractParams(path: string, engine: RadixEngine<any>, out: SearchResult<any>): Record<string, string> {
    const params: Record<string, string> = {};
    if (out.nodeIndex !== undefined && out.paramCount) {
      const keys = engine.getParamKeysForNode(out.nodeIndex);
      for (let i = 0; i < out.paramCount; i++) {
        params[keys[i]!] = path.substring(this._pool[i * 2]!, this._pool[i * 2 + 1]);
      }
    }
    return params;
  }

  private async createHttpContext(req: Request, url: URL, params: Record<string, string>): Promise<HttpContext> {
    const headers = new Headers();
    const ctx: any = {
      id: crypto.randomUUID(),
      protocol: req.headers.get('upgrade') ? 'HTTP/1.1' : 'HTTP/2',
      request: req,
      method: req.method,
      query: url.searchParams,
      params,
      store: new Map(),
      ip: req.headers.get('x-forwarded-for') || '127.0.0.1',
      set: {
        status: (c: number) => { ctx._status = c; return ctx; },
        header: (n: string, v: string) => { headers.set(n, v); return ctx; }
      },
      json: (d: any) => { ctx._response = Response.json(d, { status: ctx._status, headers }); return ctx._response; },
      text: (d: string) => { ctx._response = new Response(d, { status: ctx._status, headers }); return ctx._response; }
    };
    return ctx;
  }

  private handleSse(req: Request, params: Record<string, string>, pipeline: Pipeline<SseContext>): Response {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const ctx: SseContext = {
      id: crypto.randomUUID(),
      protocol: 'SSE',
      request: req,
      params,
      store: new Map(),
      send: (data, event, id) => {
        if (id) writer.write(encoder.encode(`id: ${id}\n`));
        if (event) writer.write(encoder.encode(`event: ${event}\n`));
        writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      },
      close: () => writer.close(),
      onClose: (cb) => req.signal.addEventListener('abort', cb)
    };

    this.runPipeline(ctx, pipeline);

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      }
    });
  }

  private createEventContext(ws: any, data: any, pattern: string, params: Record<string, string>): EventContext {
    return {
      id: crypto.randomUUID(),
      protocol: 'WS',
      pattern,
      params,
      payload: data.data,
      metadata: new Map(Object.entries(data.metadata || {})),
      socket: ws,
      store: new Map(),
      reply: (event, d) => ws.send(JSON.stringify({ event, data: d })),
      broadcast: (event, d) => ws.publish('global', JSON.stringify({ event, data: d })),
      to: (room, event, d) => ws.publish(room, JSON.stringify({ event, data: d })),
      ack: (d) => ws.send(JSON.stringify({ event: `${pattern}:ack`, data: d }))
    };
  }

  private async runPipeline(ctx: any, pipeline: Pipeline<any>) {
    let index = 0;
    const next = async () => {
      if (index < pipeline.length) {
        await pipeline[index++]!(ctx, next);
      }
    };
    await next();
  }
}