// ============================================================================
// 1. RICH CONTEXT INTERFACES
// ============================================================================
export type Protocol = 'HTTP' | 'HTTP2' | 'WS' | 'EVENT' | 'SSE';
export interface BaseContext {
  readonly id: string;
  readonly params: Record<string, string>;
  readonly store: Map<string, any>;
  readonly protocol: Protocol;
}

/** * Standard HTTP Context
 * Used for HTTP/1.1 and general Web API interactions.
 */

export interface HttpContext<TBody = any, TParams = Record<string, string>> {
  readonly id: string;
  readonly protocol: 'HTTP' | 'HTTP2';
  readonly request: Request; // Standard Web API Request
  readonly params: TParams;
  readonly query: URLSearchParams;

  // Helpers to avoid boilerplate
  readonly body: TBody;
  readonly ip: string;

  // Fluent Response API
  set: {
    status: (code: number) => HttpContext;
    header: (name: string, value: string) => HttpContext;
    cookie: (name: string, value: string, options?: any) => HttpContext;
  };

  // Terminal methods
  json(data: any): Response;
  text(data: string): Response;
  next(): Promise<void>; // For middleware chains
}



/** * HTTP/2 Specific Context
 * Extends HTTP with multiplexing and streaming features.
 */
export interface Http2Context<TBody = any, TParams = Record<string, string>> extends HttpContext<TBody, TParams> {
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

export interface SseContext<TParams = Record<string, string>> {
  id: string;
  protocol: 'SSE';
  readonly request: Request;
  readonly params: TParams;
  readonly store: Map<string, any>;

  /**
   * Sends a data packet to the client.
   * Format: `data: {message}\n\n`
   */
  send(data: string | object, event?: string, id?: string): void;

  /**
   * Properly closes the stream.
   */
  close(): void;

  /**
   * Hook for when the client disconnects.
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
 *   socket: ws,
 *   reply: (event, data) => ws.send(JSON.stringify({ event, data })),
 *   broadcast: (event, data) => ws.publish('global_room', JSON.stringify({ event, data })),
 *   to: (room, event, data) => ws.publish(room, JSON.stringify({ event, data })),
 *   // ...
 * };
 */
export interface EventContext<TPayload = any, TParams = Record<string, string>> {
  /**
   * Unique identifier for this specific event instance (useful for tracing).
   */
  readonly id: string;

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
  readonly store: Map<string, any>;

  /**
   * The actual data/body of the event.
   */
  readonly payload: TPayload;

  /**
   * Metadata (headers equivalent) like auth tokens, timestamps, or client info.
   */
  readonly metadata: Map<string, any>;

  /**
   * The underlying socket connection.
   * In Bun, this would be ServerWebSocket<unknown>.
   */
  readonly socket: any;

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
}

// ============================================================================
// 2. TYPES & INTERNAL STRUCTURES
// ============================================================================

export type Handler<T extends RouteContext> = (ctx: T, next?: () => Promise<void>) => Promise<void> | void;
export type Middleware<T extends RouteContext> = (ctx: T, next: () => Promise<void>) => any;
export type ErrorHandler<C extends RouteContext> = (error: Error, ctx: C) => void | Promise<void>;
export type Pipeline<T extends RouteContext> = (Handler<T> | Middleware<T>)[];

export interface RouteRecord<T extends RouteContext> {
  pipeline: Pipeline<T>;
  isSse?: boolean;
}

export type RouteContext = HttpContext | Http2Context | EventContext | SseContext | BaseContext;

export type Match<T> =
  | { found: true; value: T; params: Record<string, string> }
  | { found: false }

export interface RouteGroup {
  prefix: string;
  middleware: Middleware<any>[];
}

// export const HTTP_METHODS = {
//   GET: "GET",
//   POST: "POST",
//   PUT: "PUT",
//   PATCH: "PATCH",
//   DELETE: "DELETE",
//   OPTIONS: "OPTIONS",
//   HEAD: "HEAD",
//   TRACE: "TRACE",
//   CONNECT: "CONNECT",
// } as const;

// export type HttpMethod = typeof HTTP_METHODS[keyof typeof HTTP_METHODS];

// export const EVENT_METHODS = {
//   INIT: "init",
//   START: "start",
//   STOP: "stop",
//   DESTROY: "destroy",

//   BEFORE: "before",
//   AFTER: "after",

//   ERROR: "error",
//   TIMEOUT: "timeout",

//   EMIT: "emit",
//   LISTEN: "listen",
//   UNLISTEN: "unlisten",
// } as const;

// export type EventMethod = typeof EVENT_METHODS[keyof typeof EVENT_METHODS];


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
