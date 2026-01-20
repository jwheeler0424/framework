// ============================================================================
// 1. RICH CONTEXT INTERFACES
// ============================================================================

import type { Http2ServerRequest as Http2Request } from 'node:http2';
import type { UUIDv7 } from "../types";

export type Protocol = 'HTTP' | 'HTTP2' | 'WS' | 'EVENT' | 'SSE' | 'STREAM';
export interface BaseContext<TParams = Record<PropertyKey, string>> {
  readonly id: UUIDv7;
  readonly params: TParams;
  readonly store: Map<PropertyKey, any>;
}

/** * Standard HTTP Context
 * Used for HTTP/1.1 and general Web API interactions.
 */
export interface HttpContext<TBody = any, TParams = Record<PropertyKey, string>> extends BaseContext<TParams> {
  readonly id: UUIDv7;
  readonly request: Request; // Standard Web API Request
  readonly method: HttpMethod
  readonly params: TParams;
  readonly query: URLSearchParams;

  // Helpers to avoid boilerplate
  readonly body: TBody;
  readonly ip: string;

  // Fluent Response API
  set: {
    status: (code: number) => HttpContext<TBody, TParams>;
    header: (name: string, value: string) => HttpContext<TBody, TParams>;
    cookie: (name: string, value: string, options?: any) => HttpContext<TBody, TParams>;
  };

  // Terminal methods
  json(data: any): Response;
  text(data: string): Response;
  next(): Promise<void>; // For middleware chains
}



/**
 * HTTP/2 Stream Context
 * Represents a single HTTP/2 stream within a multiplexed connection.
 */
export interface Http2Context<
  TBody = any,
  TParams = Record<PropertyKey, string>
> extends BaseContext<TParams> {

  /** Unique identifier for this request */
  readonly id: UUIDv7;

  /** Incoming HTTP/2 request */
  readonly request: Http2Request;

  /** HTTP method */
  readonly method: HttpMethod;

  /** Route parameters */
  readonly params: TParams;

  /** Query parameters */
  readonly query: URLSearchParams;

  /** HTTP/2 stream identifier */
  readonly streamId?: number;

  /** Parsed request body */
  readonly body: TBody;

  /** Client IP (as resolved by the server) */
  readonly ip: string;

  /** Per-stream scratchpad */
  readonly store: Map<PropertyKey, any>;

  /* ---------------- Response Builder ---------------- */

  set: {
    status(code: number): Http2Context<TBody, TParams>;
    header(name: string, value: string): Http2Context<TBody, TParams>;
    cookie(
      name: string,
      value: string,
      options?: ResponseCookieOptions
    ): Http2Context<TBody, TParams>;
  };

  json(data: any): Response;
  text(data: string): Response;

  /** Continue middleware chain */
  next(): Promise<void>;

  /* ---------------- HTTP/2 Capabilities ---------------- */

  /**
   * Initiates HTTP/2 server push for a related resource.
   */
  push(path: string): Promise<void>;

  /**
   * Adjusts stream priority.
   */
  setPriority(options: {
    weight: number;
    dependency?: number;
    exclusive?: boolean;
  }): void;
}


export interface StreamContext<TParams = Record<PropertyKey, string>> {
  readonly id: UUIDv7;

  /**
   * The originating HTTP request.
   */
  readonly request: Request;

  /**
   * Route parameters.
   */
  readonly params: TParams;

  /**
   * Per-connection scratchpad.
   */
  readonly store: Map<PropertyKey, any>;

  /**
   * True if the stream is still open.
   */
  readonly open: boolean;

  /**
   * The last event ID sent by the client (from headers).
   */
  readonly lastEventId?: string;

  /**
   * Sends an SSE message.
   */
  send(data: string | object, event?: string, id?: string): void;

  /**
   * Instructs the client when to retry the connection.
   */
  retry(ms: number): void;

  /**
   * Gracefully closes the SSE stream.
   */
  close(): void;

  /**
   * Optional hook for cleanup when the client disconnects.
   * Router-controlled, not transport-leaking.
   */
  onClose(callback: () => void): void;

  /** Continue middleware chain */
  next(): Promise<void>;
}

/**
 * Bridging to the Runtime (Bun Example)
 * When a message hits your Bun server, you would instantiate this context like this:
 *
 * TypeScript
 *
 * // Inside Bun.serve({ websocket: { message(ws, msg) { ... } } })
 * const incoming = JSON.parse(msg); // simplified
 *
 * const ctx: EventContext = {
 *   id: crypto.randomUUID(),
 *   protocol: 'WS',
 *   pattern: incoming.event,
 *   payload: incoming.data,
 *   params: myEngine.extractParams(incoming.event), // from your routing engine
 *   store: new Map(),
 *   socket: ws,
 *   metadata: new Map([['ip', ws.remoteAddress]]),
 *   open: !ws.isClosed,
 *   reply: (event, data) => ws.send(JSON.stringify({ event, data })),
 *   broadcast: (event, data) => ws.publish('global_room', JSON.stringify({ event, data })),
 *   to: (room, event, data) => ws.publish(room, JSON.stringify({ event, data })),
 *   // ...
 * };
 */
export interface EventContext<
  TPayload = any,
  TParams = Record<PropertyKey, string>
> {
  /**
   * Unique identifier for this specific event instance (useful for tracing).
   */
  readonly id: UUIDv7;

  /**
   * Parameters extracted from the pattern (e.g., "rooms.:roomId" -> { roomId: "123" }).
   */
  readonly params: TParams;

  /**
   * The actual data/body of the event.
   */
  readonly payload: TPayload;

  /**
   * Per-event scratchpad (lives for the duration of this dispatch).
   */
  readonly store: Map<PropertyKey, any>;

  /**
   * Connection / event metadata (auth, timestamps, client info).
   */
  readonly metadata: Map<PropertyKey, any>;

  /**
   * Transport handle (intentionally opaque).
   */
  readonly socket: any;

  /**
   * True if the underlying connection is still active.
   */
  readonly open: boolean;

  /**
   * Sends a message back ONLY to the client who triggered this event.
   */
  reply(event: string, data: any): void;

  /**
   * Sends a message to everyone EXCEPT the sender.
   */
  broadcast(event: string, data: any): void;

  /**
   * Sends a message to a specific room or topic.
   */
  to(room: string, event: string, data: any): void;

  /**
   * For RPC-style events: specifically acknowledges receipt or returns a value.
   */
  ack(data?: any): void;

  /**
   * Gracefully terminate the connection.
   */
  close(code?: number, reason?: string): void;

  /** Continue middleware chain */
  next(): Promise<void>;
}

// ============================================================================
// 2. TYPES & INTERNAL STRUCTURES
// ============================================================================

export type Handler<C extends unknown = any> = (ctx: C, next?: () => Promise<void> | void) => Promise<void> | void;
export type Middleware<C extends unknown = any> = (ctx: C, next?: () => Promise<void> | void) => any;
export type ErrorHandler<C extends unknown = any> = (error: Error, ctx: C) => void | Promise<void>;
export type Pipeline<C extends unknown = any> = (Handler<C> | Middleware<C>)[];

export interface RouteRecord<C extends HttpContext | Http2Context | StreamContext | BaseContext> {
  pipeline: Pipeline<C>;
  isSse?: boolean;
}

export interface NamespaceRecord<C extends EventContext | BaseContext> {
  pipeline: Pipeline<C>;
  isSse?: boolean;
}

export interface ContextRecord<C extends RouteContext> extends RouteRecord<C>, NamespaceRecord<C> {}

export type RouteContext = HttpContext | Http2Context | EventContext | StreamContext | BaseContext;

export type Match<T> =
  | { found: true; value: T; params: Record<PropertyKey, string> }
  | { found: false; value: undefined; params: undefined }

export interface RouteGroup<C extends RouteContext> {
  prefix: string;
  middleware: Middleware<C>[];
}

export const HTTP_METHODS = {
  GET: "GET",
  POST: "POST",
  PUT: "PUT",
  PATCH: "PATCH",
  DELETE: "DELETE",
  OPTIONS: "OPTIONS",
  HEAD: "HEAD",
} as const;

export type HttpMethod = typeof HTTP_METHODS[keyof typeof HTTP_METHODS];

export const STREAM_METHODS = {
  SSE: "SSE",
  STREAM: "STREAM",
} as const;
export type StreamMethod = typeof STREAM_METHODS[keyof typeof STREAM_METHODS];

export const EVENT_METHODS = {
  ON: "ON",
  CALL: "CALL",
  SUBSCRIBE: "SUBSCRIBE",
  UNSUBSCRIBE: "UNSUBSCRIBE",
  CONNECT: "CONNECT",
  DISCONNECT: "DISCONNECT",
} as const;

export type EventMethod = typeof EVENT_METHODS[keyof typeof EVENT_METHODS];

export function isHttpMethod(method: string): method is HttpMethod {
  return Object.values(HTTP_METHODS).includes(method as HttpMethod);
}

export function isEventMethod(method: string): method is EventMethod {
  return Object.values(EVENT_METHODS).includes(method as EventMethod);
}

export function isStreamMethod(method: string): method is StreamMethod {
  return Object.values(STREAM_METHODS).includes(method as StreamMethod);
}

/**
 * 3. The "Master" Router Helper CatalogTo achieve that Laravel-like
 * developer experience, your Router class should implement these methods.
 * Internally, they all map to your engine's add(method, pattern, handler)
 * logic.
 *
 * HTTP Methods (RESTful)
 * +------------+-----------------------------+---------------------------+
 * | Method     | Usage                       | Description               |
 * +------------+-----------------------------+---------------------------+
 * | .get()     | router.get('/path', h)      | Standard retrieval.       |
 * | .post()    | router.post('/path', h)     | Create resource.          |
 * | .put()     | router.put('/path', h)      | Full update/replace.      |
 * | .patch()   | router.patch('/path', h)    | Partial update.           |
 * | .delete()  | router.delete('/path', h)   | Remove resource.          |
 * | .options() | router.options('/path', h)  | CORS/Pre-flight checks.   |
 * | .head()    | router.head('/path', h)     | Get headers only.         |
 * +------------+-----------------------------+---------------------------+
 *
 * Event Methods (WebSocket/Event-Driven)
 * +----------------+---------------------------------+---------------------------------+
 * | Method         | Usage                           | Description                     |
 * +----------------+---------------------------------+---------------------------------+
 * | .on()          | router.on('user.login', h)      |Standard event listener.         |
 * | .call()        | router.call('get.stats', h)     |RPC style (Request -> Response). |
 * | .subscribe()   | router.subscribe('room.*', h)   |Logic for joining a topic.       |
 * | .unsubscribe() | router.unsubscribe('room.*', h) |Logic for leaving a topic.       |
 * | .connect()     | router.connect(h)               |Global connection handshake.     |
 * | .disconnect()  | router.disconnect(h)            |Global cleanup.                  |
 * +----------------+---------------------------------+---------------------------------+
 *
 * Specialized Real-Time Methods
 * +------------+-----------------------------+-----------------------------------------+
 * | Method     | Usage                       | Description                             |
 * +------------+-----------------------------+-----------------------------------------+
 * | .sse()     | router.sse('/live-feed', h) | Automatically sets headers for SSE.     |
 * | .stream()  | router.stream('/video', h)  | For raw Binary/ReadableStream routing.  |
 * +------------+-----------------------------+-----------------------------------------+
 */

export interface ResponseCookieOptions {
  /**
   * Max-Age attribute in seconds.
   */
  maxAge?: number;

  /**
   * Expiration date of the cookie.
   */
  expires?: Date;

  /**
   * Domain scope of the cookie.
   */
  domain?: string;

  /**
   * URL path scope of the cookie.
   */
  path?: string;

  /**
   * Prevents access to the cookie from JavaScript.
   */
  httpOnly?: boolean;

  /**
   * Ensures the cookie is only sent over HTTPS.
   */
  secure?: boolean;

  /**
   * Controls cross-site cookie behavior.
   */
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export type HttpContextOptions<
  TParams extends Record<PropertyKey, string> = Record<PropertyKey, string>> = {
    req: Request,
    params: TParams,
    next?: () => Promise<void>
  }

export type Http2ContextOptions<
  TParams extends Record<PropertyKey, string> = Record<PropertyKey, string>> = {
    req: Http2Request,
    params: TParams,
    next?: () => Promise<void>
  }

export type StreamContextOptions<
  TParams extends Record<PropertyKey, string> = Record<PropertyKey, string>
> = {
  req: Request,
  params: TParams,
  controller: ReadableStreamDefaultController<string>,
  next?: () => Promise<void>
}

export type EventConextOptions<
  TParams extends Record<PropertyKey, string> = Record<PropertyKey, string>
> = {
  params: TParams;

  socket?: any;

  send: (event: string, data: any) => void;
  broadcast?: (event: string, data: any) => void;
  to?: (room: string, event: string, data: any) => void;

  close?: (code?: number, reason?: string) => void;
  isOpen?: () => boolean;

  metadata?: Map<PropertyKey, any>;

  next?: () => Promise<void>
}

export type ContextOptions<
  TParams extends Record<PropertyKey, string> = Record<PropertyKey, string>
> =
  | HttpContextOptions<TParams>
  | Http2ContextOptions<TParams>
  | StreamContextOptions<TParams>
  | EventConextOptions<TParams>;