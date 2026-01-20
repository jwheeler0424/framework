// ============================================================================
// AETHER ROUTER - MULTI-ENGINE ORCHESTRATOR
// ============================================================================
// import type { EngineMetrics } from "./engine";
import RadixEngine, { isAllowedDelimiter, type AllowedDelimiter, type RadixEngineOptions, type SearchResult } from "./engine";

type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
type Handler = (ctx: RouteContext) => any;
type Middleware = (ctx: RouteContext, next: () => Promise<void>) => any;
type Pipeline = Array<Middleware | Handler>;

interface RouteContext {
  params: Record<string, string>;
  query: Record<string, string>;
  path: string;
  method: string;
  [key: string]: any;
}

type Match<T> =
  | { found: true; value: T; params: Record<string, string> }
  | { found: false }

interface RouteGroup {
  prefix: string;
  middleware: Middleware[];
}
const MAX_PARAMS = 8;

/**
 * AetherRouter: HTTP-specific router using multiple engines
 * Each HTTP method gets its own engine for optimal performance
 */
export class AetherRouter {
  private _engines: Map<HTTPMethod | string, RadixEngine<Pipeline>>;
  private _currentGroup: RouteGroup | null;
  private _queryPointer: number = 0;
  private _queryPool: number[] = [];
  private _delimiter: AllowedDelimiter;

  constructor(private config: RadixEngineOptions & {
    cacheSize?: number;
    enableMetrics?: boolean;
  } = {}) {
    if (config.delimiter && !isAllowedDelimiter(config.delimiter)) {
      throw new Error(`Invalid delimiter: ${config.delimiter}`);
    }
    this._engines = new Map();
    this._currentGroup = null;
    this._delimiter = config.delimiter || '/';
  }

  private getEngine(method: HTTPMethod | string): RadixEngine<Pipeline> {
    if (!this._engines.has(method)) {
      this._engines.set(method, new RadixEngine<Pipeline>(this.config));
    }
    return this._engines.get(method) as RadixEngine<Pipeline>;
  }

  // ==========================================================================
  // ROUTE REGISTRATION
  // ==========================================================================

  group(prefix: string, middleware: Middleware[], callback: () => void): void {
    const previousGroup = this._currentGroup;

    const fullPrefix = previousGroup
      ? this.normalizePath(previousGroup.prefix + this._delimiter + prefix)
      : this.normalizePath(prefix);

    const fullMiddleware = previousGroup
      ? [...previousGroup.middleware, ...middleware]
      : middleware;

    this._currentGroup = { prefix: fullPrefix, middleware: fullMiddleware };
    callback();
    this._currentGroup = previousGroup;
  }

  private normalizePath(path: string): string {
    if (!path || path === this._delimiter) return '';

    let result = '';
    let lastWasSlash = false;

    for (let i = 0; i < path.length; i++) {
      const ch = path[i];
      if (ch === this._delimiter) {
        if (!lastWasSlash && result.length > 0) {
          result += ch;
        }
        lastWasSlash = true;
      } else {
        result += ch;
        lastWasSlash = false;
      }
    }

    if (result.length > 1 && result[result.length - 1] === this._delimiter) {
      result = result.slice(0, -1);
    }

    return result;
  }

  get(pattern: string, ...pipeline: Pipeline): void {
    this.register('GET', pattern, pipeline);
  }

  post(pattern: string, ...pipeline: Pipeline): void {
    this.register('POST', pattern, pipeline);
  }

  put(pattern: string, ...pipeline: Pipeline): void {
    this.register('PUT', pattern, pipeline);
  }

  delete(pattern: string, ...pipeline: Pipeline): void {
    this.register('DELETE', pattern, pipeline);
  }

  patch(pattern: string, ...pipeline: Pipeline): void {
    this.register('PATCH', pattern, pipeline);
  }

  head(pattern: string, ...pipeline: Pipeline): void {
    this.register('HEAD', pattern, pipeline);
  }

  options(pattern: string, ...pipeline: Pipeline): void {
    this.register('OPTIONS', pattern, pipeline);
  }

  /**
   * Register route for custom method/event type
   */
  on(method: string, pattern: string, ...pipeline: Pipeline): void {
    this.register(method, pattern, pipeline);
  }

  private register(method: string, pattern: string, pipeline: Pipeline): void {
    const fullPattern = this._currentGroup
      ? this.normalizePath(this._currentGroup.prefix + this._delimiter + pattern)
      : this.normalizePath(pattern);

    const fullPipeline = this._currentGroup
      ? [...this._currentGroup.middleware, ...pipeline]
      : pipeline;

    const engine = this.getEngine(method);
    engine.insert(fullPattern, fullPipeline);
  }

  // ==========================================================================
  // QUERY STRING PARSING
  // ==========================================================================

  private parseQuery(fullPath: string, queryStart: number): Record<string, string> {
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

    const query: Record<string, string> = {};
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

  find(fullPath: string, method: HTTPMethod | string = 'GET'): {
    pipeline: Pipeline | null;
    params: Record<string, string>;
    query: Record<string, string>;
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
    const query = queryStart === -1 ? {} : this.parseQuery(fullPath, queryStart);

    const engine = this._engines.get(method);
    if (!engine) {
      return { pipeline: null, params: {}, query };
    }

    const pool = new Uint32Array(MAX_PARAMS * 2); // choose based on your route set
    const out = { found: false };
    const result = this.matchRoute<Pipeline>(engine, path, pool, out);

    const { value, params } = result.found ? result : { value: null, params: {} };
    return { pipeline: value, params, query };
  }

  async execute(fullPath: string, method: HTTPMethod | string = 'GET', context: Partial<RouteContext> = {}): Promise<any> {
    const { pipeline, params, query } = this.find(fullPath, method);

    if (!pipeline) {
      throw new Error(`No route found for: ${method} ${fullPath}`);
    }

    const ctx: RouteContext = {
      params,
      query,
      path: fullPath,
      method,
      ...context
    };

    let index = 0;

    const next = async (): Promise<void> => {
      if (index >= pipeline.length) return;

      const fn = pipeline[index++];

      if (index === pipeline.length) {
        await (fn as Handler)(ctx);
      } else {
        await (fn as Middleware)(ctx, next);
      }
    };

    await next();
    return ctx;
  }

  /**
   * Handle request asynchronously with full middleware pipeline
   */
  async handle(fullPath: string, method: HTTPMethod | string = 'GET', context: Partial<RouteContext> = {}): Promise<RouteContext> {
    return this.execute(fullPath, method, context);
  }

  /**
   * Handle request synchronously - NO async middleware allowed
   * Returns context immediately after all sync handlers execute
   */
  handleSync(fullPath: string, method: HTTPMethod | string = 'GET', context: Partial<RouteContext> = {}): RouteContext {
    const { pipeline, params, query } = this.find(fullPath, method);

    if (!pipeline) {
      throw new Error(`No route found for: ${method} ${fullPath}`);
    }

    const ctx: RouteContext = {
      params,
      query,
      path: fullPath,
      method,
      ...context
    };

    // Synchronous execution - no async/await
    for (const fn of pipeline) {
      const result = (fn as Handler)(ctx);

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
  clearCache(): void {
    this._engines.clear();
  }

  bakeAll(): void {
    for (const engine of this._engines.values()) {
      engine.finalize();
    }
  }

  getEngineCount(): number {
    return this._engines.size;
  }

  getMethods(): string[] {
    return Array.from(this._engines.keys());
  }

  matchRoute<T>(
    engine: RadixEngine<T>,
    path: string,
    pool: Uint32Array,
    out: SearchResult<T>,
  ): Match<T> {
    const ok = engine.searchInto(path, pool, out);
    if (!ok || !out.found) return { found: false };

    const value = out.value as T;
    const paramCount = (out.paramCount || 0) as number;

    if (paramCount === 0) {
      // Avoid allocating params object.
      return { found: true, value, params: Object.create(null) };
      // If you want truly no params allocation in this case:
      // return { found: true, value, params: EMPTY_PARAMS }; (shared frozen empty object)
    }

    const nodeIndex = out.nodeIndex as number;
    const keys = engine.getParamKeysForNode(nodeIndex); // allocates array (OK, not during search)

    // Assemble params (allocates object + substrings; allowed in final phase)
    const params: Record<string, string> = Object.create(null);
    for (let i = 0; i < paramCount; i++) {
      const start = pool[(i << 1)] || 0;
      const end = pool[(i << 1) + 1] || 0;
      params[keys[i]!] = path.substring(start, end);
    }

    return { found: true, value, params };
  }
}

// ============================================================================
// EVENT ROUTER - GENERIC EVENT MATCHING
// ============================================================================

type SyncHandler<T> = (data: T) => void;
type AsyncHandler<T> = (data: T) => Promise<void>;
type EventHandler<T> = SyncHandler<T> | AsyncHandler<T>;

/**
 * EventRouter: Generic event router using single engine
 * For use with event-driven architectures, message buses, etc.
 */
export class EventRouter<T = any> {
  private engine: RadixEngine<EventHandler<T>>;

  constructor(private config: RadixEngineOptions & {
    cacheSize?: number;
    enableMetrics?: boolean;
  } = {}) {
    this.engine = new RadixEngine<EventHandler<T>>(config);
  }

  on(pattern: string, handler: EventHandler<T>): void {
    this.engine.insert(pattern, handler);
  }

  match(event: string): { handler: EventHandler<T> | null; params: Record<string, string> } {
    const pool = new Uint32Array(MAX_PARAMS * 2); // choose based on your route set
    const out = { found: false };
    const result = this.matchNamespace(this.engine, event, pool, out);
    const { value, params } = result.found ? result : { value: null, params: {} };
    return { handler: value, params };
  }

  /**
   * Emit event asynchronously
   */
  async emit(event: string, data: T): Promise<void> {
    const { handler, params } = this.match(event);
    if (!handler) {
      throw new Error(`No handler for event: ${event}`);
    }

    await handler(data);
  }

  /**
   * Emit event synchronously - handler must be sync
   */
  emitSync(event: string, data: T): void {
    const { handler, params } = this.match(event);
    if (!handler) {
      throw new Error(`No handler for event: ${event}`);
    }

    const result = handler(data);

    if (result && typeof result === 'object' && 'then' in result) {
      throw new Error('emitSync cannot execute async handlers - use emit() instead');
    }
  }

  bake(): void {
    this.engine.finalize();
  }

  matchNamespace<T>(
    engine: RadixEngine<T>,
    path: string,
    pool: Uint32Array,
    out: SearchResult<T>,
  ): Match<T> {
    const ok = engine.searchInto(path, pool, out);
    if (!ok || !out.found) return { found: false };

    const value = out.value as T;
    const paramCount = (out.paramCount || 0) as number;

    if (paramCount === 0) {
      // Avoid allocating params object.
      return { found: true, value, params: Object.create(null) };
      // If you want truly no params allocation in this case:
      // return { found: true, value, params: EMPTY_PARAMS }; (shared frozen empty object)
    }

    const nodeIndex = out.nodeIndex as number;
    const keys = engine.getParamKeysForNode(nodeIndex); // allocates array (OK, not during search)

    // Assemble params (allocates object + substrings; allowed in final phase)
    const params: Record<string, string> = Object.create(null);
    for (let i = 0; i < paramCount; i++) {
      const start = pool[(i << 1)] || 0;
      const end = pool[(i << 1) + 1] || 0;
      params[keys[i]!] = path.substring(start, end);
    }

    return { found: true, value, params };
  }
}