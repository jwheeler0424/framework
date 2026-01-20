import { createBaseContext } from './context';
import RadixEngine, { AllowedDelimiterMap, type AllowedDelimiter, type SearchResult } from "./engine"; // Assuming your engine is in index.ts
import { type BaseContext, type ContextRecord, type EventContext, type EventMethod, type Handler, type Http2Context, type HttpContext, type HttpMethod, type Match, type Middleware, type Pipeline, type Protocol, type RouteContext, type RouteGroup, type StreamContext, type StreamMethod } from "./types";

type ConfigOptions = {
  eventDelimiter?: AllowedDelimiter;
  cacheSize?: number;
  enableMetrics?: boolean;
}

export class AetherRouter {
  private _engines: Map<HttpMethod | EventMethod | StreamMethod, RadixEngine<ContextRecord<RouteContext>>>;
  private _currentGroup: RouteGroup<RouteContext> | null;
  private _queryPointer: number = 0;
  private _queryPool: number[] = [];
  // private engines = new Map<string, RadixEngine<RouteRecord<any>>>();
  private _groupStack: RouteGroup<RouteContext>[] = [{ prefix: '', middleware: [] }];
  // Reusable search artifacts (Zero-Allocation matching)
  private _pool = new Uint32Array(32);
  private _out: SearchResult<ContextRecord<RouteContext>> = { found: false };

  constructor(private config: ConfigOptions = { eventDelimiter: ':' }) {
    this._engines = new Map();
    this._currentGroup = null;
  }

  // ==========================================================================
  // ROUTE REGISTRATION
  // ==========================================================================

  group(prefix: string, middleware: Middleware<RouteContext>[], callback: () => void): void {
    const previousGroup = this._currentGroup;

    const fullPrefix = previousGroup
      ? this.normalizePath(previousGroup.prefix + prefix)
      : this.normalizePath(prefix);

    const fullMiddleware = previousGroup
      ? [...previousGroup.middleware, ...middleware]
      : middleware;

    this._currentGroup = { prefix: fullPrefix, middleware: fullMiddleware };
    this._groupStack.push({ prefix: fullPrefix, middleware: fullMiddleware });
    callback();
    this._groupStack.pop();
    this._currentGroup = previousGroup;
  }

  // --- Public API ---
  get(pattern: string, ...pipeline: Pipeline<(...args: any) => void>): void {
    this.register('GET', pattern, pipeline);
  }

  post(pattern: string, ...pipeline: Pipeline<HttpContext | Http2Context>): void {
    this.register('POST', pattern, pipeline);
  }

  put(pattern: string, ...pipeline: Pipeline<HttpContext | Http2Context>): void {
    this.register('PUT', pattern, pipeline);
  }

  delete(pattern: string, ...pipeline: Pipeline<HttpContext | Http2Context>): void {
    this.register('DELETE', pattern, pipeline);
  }

  patch(pattern: string, ...pipeline: Pipeline<HttpContext | Http2Context>): void {
    this.register('PATCH', pattern, pipeline);
  }

  head(pattern: string, ...pipeline: Pipeline<HttpContext | Http2Context>): void {
    this.register('HEAD', pattern, pipeline);
  }

  options(pattern: string, ...pipeline: Pipeline<HttpContext | Http2Context>): void {
    this.register('OPTIONS', pattern, pipeline);
  }

  sse(pattern: string, ...pipeline: Pipeline<StreamContext>): void {
    this.register('GET', pattern, pipeline, true);
  }

  stream(pattern: string, ...pipeline: Pipeline<StreamContext>): void {
    this.register('STREAM', pattern, pipeline);
  }

  /**
   * Register routes for custom method/event type
   */
  on(pattern: string, ...pipeline: Pipeline<EventContext>): void {
    this.register("ON", pattern, pipeline);
  }

  call(pattern: string, ...pipeline: Pipeline<EventContext>): void {
    this.register("CALL", pattern, pipeline);
  }

  subscribe(pattern: string, ...pipeline: Pipeline<EventContext>): void {
    this.register("SUBSCRIBE", pattern, pipeline);
  }

  unsubscribe(pattern: string, ...pipeline: Pipeline<EventContext>): void {
    this.register("UNSUBSCRIBE", pattern, pipeline);
  }

  connect(pattern: string, ...pipeline: Pipeline<EventContext>): void {
    this.register("CONNECT", pattern, pipeline);
  }

  disconnect(pattern: string, ...pipeline: Pipeline<EventContext>): void {
    this.register("DISCONNECT", pattern, pipeline);
  }

  private register<C extends RouteContext>(method: HttpMethod | EventMethod | StreamMethod, pattern: string, pipeline: Pipeline<any>, isSse = false): void {
    // const fullPattern = this._currentGroup
    //   ? this.normalizePath(this._currentGroup.prefix + pattern)
    //   : this.normalizePath(pattern);

    const fullPattern = this._currentGroup
      ? this._currentGroup.prefix + pattern
      : pattern;

    const fullPipeline = this._currentGroup
      ? [...this._currentGroup.middleware, ...pipeline]
      : pipeline;

    const engine = this.getEngine(method);
    const fullRecord: ContextRecord<C> = {
      pipeline: fullPipeline,
      isSse
    };
    engine.insert(fullPattern, fullRecord as ContextRecord<RouteContext>);
  }

  // ==========================================================================
  // QUERY STRING PARSING
  // ==========================================================================

  private parseQuery(fullPath: string, queryStart: number): Record<PropertyKey, string> {
    this._queryPointer = 0;
    const len = fullPath.length;

    if (queryStart >= len) return {};

    let cursor = queryStart + 1;

    while (cursor < len) {
      const keyStart = cursor;
      while (cursor < len && fullPath.charCodeAt(cursor) !== 61 && fullPath.charCodeAt(cursor) !== 38) {
        cursor++;
      }
      const keyEnd = cursor;

      let valStart = cursor;
      let valEnd = cursor;

      if (cursor < len && fullPath.charCodeAt(cursor) === 61) {
        cursor++;
        valStart = cursor;
        while (cursor < len && fullPath.charCodeAt(cursor) !== 38) {
          cursor++;
        }
        valEnd = cursor;
      }

      if (this._queryPointer < this._queryPool.length - 3) {
        this._queryPool[this._queryPointer++] = keyStart;
        this._queryPool[this._queryPointer++] = keyEnd;
        this._queryPool[this._queryPointer++] = valStart;
        this._queryPool[this._queryPointer++] = valEnd;
      }

      if (cursor < len && fullPath.charCodeAt(cursor) === 38) {
        cursor++;
      }
    }

    const query: Record<PropertyKey, string> = {};
    const pairCount = this._queryPointer >> 2;

    for (let i = 0; i < pairCount; i++) {
      const keyStart = this._queryPool[i * 4];
      const keyEnd = this._queryPool[i * 4 + 1];
      const valStart = this._queryPool[i * 4 + 2];
      const valEnd = this._queryPool[i * 4 + 3];

      const key = fullPath.substring(keyStart ?? 0, keyEnd);
      const val = fullPath.substring(valStart ?? 0, valEnd);

      query[decodeURIComponent(key)] = decodeURIComponent(val);
    }

    return query;
  }

  // ==========================================================================
  // ROUTE MATCHING & EXECUTION
  // ==========================================================================

  find<C extends RouteContext, TParams extends Record<PropertyKey, string>, TQuery extends Record<PropertyKey, string>>(fullPath: string, method: HttpMethod | EventMethod | StreamMethod = 'GET'): {
    record: ContextRecord<C> | null;
    params: TParams | null;
    query: TQuery | null;
  } {
    // Split path and query
    let queryStart = -1;
    for (let i = 0; i < fullPath.length; i++) {
      if (fullPath.charCodeAt(i) === 63) {
        queryStart = i;
        break;
      }
    }

    const path = queryStart === -1 ? fullPath : fullPath.substring(0, queryStart);
    const query = queryStart === -1 ? null : this.parseQuery(fullPath, queryStart);

    const engine = this._engines.get(method);
    if (!engine) {
      return { record: null, params: null, query: null };
    }

    const result = this.matchRoute<ContextRecord<C>>(engine, path, this._pool, this._out);

    const { value, params } = result.found ? result : { value: null, params: null };
    return { record: value, params: params as TParams, query: query as TQuery };
  }

  async execute<
    TContext extends BaseContext<any>,
    TParams extends Record<PropertyKey, string>
  >(fullPath: string, method: HttpMethod | EventMethod | StreamMethod = 'GET', protocol: Protocol, context: Partial<TContext> = {}): Promise<any> {
    const { record, params, query } = this.find(fullPath, method);

    if (!record?.pipeline) {
      throw new Error(`No route found for: ${method} ${fullPath}`);
    }

    // Use the registered pipeline and create a base context; cast the args to satisfy the generic
    const pipeline = record.pipeline as Pipeline<any>;
    const result = await createBaseContext<TContext, TParams>(({ params, query } as unknown) as TParams);
    const ctx = (result as { ctx: TContext }).ctx as TContext;

    let index = 0;

    const next = async (): Promise<void> => {
      if (index >= pipeline.length) return;

      const fn = pipeline[index++];

      if (index === pipeline.length) {
        await (fn as Handler<TContext>)(ctx);
      } else {
        await (fn as Middleware<TContext>)(ctx, next);
      }
    };

    await next();
    return ctx;
  }

  /**
   * Handle request asynchronously with full middleware pipeline
   */
  async handle(fullPath: string, method: HttpMethod | EventMethod | StreamMethod = 'GET', protocol: Protocol, context: Partial<RouteContext> = {}): Promise<RouteContext> {
    return this.execute(fullPath, method, protocol, context);
  }

  /**
   * Handle request synchronously - NO async middleware allowed
   * Returns context immediately after all sync handlers execute
   */
  handleSync<
    TContext extends BaseContext<any>,
    TParams extends Record<PropertyKey, string>
  >(fullPath: string, method: HttpMethod | EventMethod | StreamMethod = 'GET', context: Partial<RouteContext> = {}): RouteContext {
    const { record, params, query } = this.find(fullPath, method);

    if (!record?.pipeline) {
      throw new Error(`No route found for: ${method} ${fullPath}`);
    }

    // Use the registered pipeline and create a base context; cast the args to satisfy the generic
    const pipeline = record.pipeline as Pipeline<any>;
    const result = createBaseContext<TContext, TParams>(({ params, query } as unknown) as TParams);
    const ctx = (result as { ctx: TContext }).ctx as TContext;

    let index = 0;

    // Synchronous execution - no async/await
    for (const fn of pipeline) {
      const result = fn(ctx);

      // Detect if handler returned a Promise
      if (result && typeof result === 'object' && 'then' in result) {
        throw new Error('handleSync cannot execute async handlers - use handle() instead');
      }
    }

    return ctx;
  }

  // ==========================================================================
  // INTROSPECTION & UTILITIES
  // ==========================================================================

  private normalizePath(path: string, delimiter?: AllowedDelimiter): string {
    if (!path || path === "") return '';

    let result = '';
    let lastWasDelimiter = false;

    for (let i = 0; i < path.length; i++) {
      const ch = path[i];
      if (ch === delimiter || Object.values(AllowedDelimiterMap).includes(ch as AllowedDelimiter)) {
        if (!lastWasDelimiter && result.length > 0) {
          result += ch;
        }
        lastWasDelimiter = true;
      } else {
        result += ch;
        lastWasDelimiter = false;
      }
    }

    if (result.length > 1 && (result[result.length - 1] === delimiter || Object.values(AllowedDelimiterMap).includes(result[result.length - 1] as AllowedDelimiter))) {
      result = result.slice(0, -1);
    }

    return result;
  }

  private getEngine(key: HttpMethod | EventMethod | StreamMethod, delimiter?: AllowedDelimiter): RadixEngine<ContextRecord<RouteContext>> {
    if (!this._engines.has(key)) {
      this._engines.set(key, new RadixEngine({ delimiter }));
    }
    return this._engines.get(key)!;
  }

  private clearCache(): void {
    this._engines.clear();
  }

  private matchRoute<T>(
    engine: RadixEngine<T>,
    path: string,
    pool: Uint32Array,
    out: SearchResult<T>,
  ): Match<T> {
    const ok = engine.searchInto(path, pool, out);
    if (!ok || !out.found) return { found: false, value: undefined, params: undefined };

    const value = out.value as T;
    const paramCount = (out.paramCount || 0) as number;

    if (paramCount === 0) {
      // Avoid allocating params object.
      return { found: true, value, params: Object.create(null) };
    }

    const params = this.extractParams(path, engine, out);

    return { found: true, value, params };
  }

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

}