// ============================================================================
// 1. RICH CONTEXT INTERFACES

import type { UUIDv7 } from "../types";

// ============================================================================
export type Protocol = 'HTTP' | 'HTTP2' | 'WS' | 'EVENT' | 'SSE' | 'STREAM';
export interface BaseContext<TParams = Record<PropertyKey, string>> {
  readonly id: UUIDv7;
  readonly params: TParams;
  readonly store: Map<PropertyKey, any>;
  readonly protocol: Protocol;
}

/** * Standard HTTP Context
 * Used for HTTP/1.1 and general Web API interactions.
 */
export interface HttpContext<TBody = any, TParams = Record<PropertyKey, string>> extends BaseContext<TParams> {
  readonly id: UUIDv7;
  readonly protocol: 'HTTP' | 'HTTP2';
  readonly request: Request; // Standard Web API Request
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



/** * HTTP/2 Specific Context
 * Extends HTTP with multiplexing and streaming features.
 */
export interface Http2Context<TBody = any, TParams = Record<PropertyKey, string>> extends HttpContext<TBody, TParams> {
  readonly protocol: 'HTTP2';
  readonly streamId: number; // The H2 Stream ID

  /**
   * Pushes a resource to the client (Server Push).
   * Note: Useful for server-to-server or specific H2 clients.
   */
  push(path: string): Promise<void>;

  /**
   * Adjusts the priority of the current stream.
   */
  setPriority(weight: number, dependency: number): void;
}

export interface StreamContext<TParams = Record<PropertyKey, string>> {
  readonly id: UUIDv7;
  readonly protocol: 'SSE' | 'STREAM';

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
   * The protocol identifier.
   */
  readonly protocol: 'WS' | 'EVENT';

  /**
   * The raw event name or topic (e.g., "chat.message.sent").
   */
  readonly pattern: string;

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
}

// ============================================================================
// 2. TYPES & INTERNAL STRUCTURES
// ============================================================================

export type Handler<C extends RouteContext> = (ctx: C, next?: () => Promise<void>) => Promise<void> | void;
export type Middleware<C extends RouteContext> = (ctx: C, next?: () => Promise<void>) => any;
export type ErrorHandler<C extends RouteContext> = (error: Error, ctx: C) => void | Promise<void>;
export type Pipeline<C extends RouteContext> = (Handler<C> | Middleware<C>)[];

export interface RouteRecord<C extends RouteContext> {
  pipeline: Pipeline<C>;
  isSse?: boolean;
}

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
}
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
