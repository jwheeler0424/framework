import { Http2ServerRequest as Http2Request } from 'node:http2';
import { v7 as uuidv7 } from "uuid";
import type { UUIDv7 } from "../types";
import { EVENT_METHODS, HTTP_METHODS, isEventMethod, isHttpMethod, isStreamMethod, STREAM_METHODS, type BaseContext, type ContextOptions, type EventContext, type EventMethod, type Http2Context, type HttpContext, type HttpMethod, type Protocol, type ResponseCookieOptions, type StreamContext, type StreamMethod } from "./types";

export function generateId(): UUIDv7 {
  return uuidv7() as UUIDv7;
}

export function getHttpMethod(method: string): HttpMethod | null {
  return isHttpMethod(method)
    ? HTTP_METHODS[method]
    : null
}

export function getEventMethod(method: string): EventMethod | null {
  return isEventMethod(method)
    ? EVENT_METHODS[method]
    : null;
}

export function getStreamMethod(method: string): StreamMethod | null {
  return isStreamMethod(method)
    ? STREAM_METHODS[method]
    : null;
}

export function getMethod(method: string): HttpMethod | EventMethod | StreamMethod | null {
  return getHttpMethod(method) ?? getEventMethod(method) ?? getStreamMethod(method) ?? null;
}

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

async function readHttp2Body(
  req: Http2Request,
  contentType?: string
): Promise<any> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(
      typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    );
  }

  const buffer = Buffer.concat(chunks);
  if (!buffer.length) return undefined;

  if (contentType?.includes('application/json')) {
    return JSON.parse(buffer.toString('utf8'));
  }

  if (contentType?.startsWith('text/')) {
    return buffer.toString('utf8');
  }

  return buffer;
}

export function createBaseContext<
  TContext extends BaseContext<TParams>,
  TParams extends Record<PropertyKey, string>
>(
  params: TParams,
) {
  // ---- response state ----
  let response: Response | null = null;

  const ctx: TContext = {
    id: generateId(),
    params,
    store: new Map(),
  } as TContext;

  return { ctx, getResponse: () => response };
}

export async function createHttpContext<
  TBody = any,
  TParams extends Record<PropertyKey, string> = Record<PropertyKey, string>
>(
  options: {
    req: Request,
    url: URL,
    params: TParams,
    next?: () => Promise<void>
  }
): Promise<HttpContext<TBody, TParams>> {
  const { req, url, params, next } = options;
  const { ctx } = createBaseContext<HttpContext<TBody, TParams>, TParams>(
    params,
  );

  const headers = new Headers();

  const method = getHttpMethod(req.method);
  if (!method) {
    throw new Error(`Unsupported HTTP method: ${req.method}`);
  }

  // --- body parsing (explicit and deterministic) ---
  let body: TBody;
  const contentType = req.headers.get('content-type') ?? '';

  if (method !== 'GET' && method !== 'HEAD') {
    if (contentType.includes('application/json')) {
      body = await req.json();
    } else if (contentType.includes('text/')) {
      body = await req.text() as any;
    } else {
      body = undefined as any;
    }
  } else {
    body = undefined as any;
  }

  // --- internal response state ---
  let statusCode = 200;
  let response: Response | null = null;

  const httpContext: HttpContext<TBody, TParams> = {
    ...ctx,
    request: req,
    method,
    query: url.searchParams,
    body,
    ip:
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      '127.0.0.1',
    store: new Map(),
    set: {
      status(code: number) {
        statusCode = code;
        return httpContext;
      },
      header(name: string, value: string) {
        headers.set(name, value);
        return httpContext;
      },
      cookie(name: string, value: string, options?: ResponseCookieOptions) {
        let cookie = `${name}=${value}`;
        if (options) {
          if (options.maxAge !== undefined) cookie += `; Max-Age=${options.maxAge}`;
          if (options.domain) cookie += `; Domain=${options.domain}`;
          if (options.path) cookie += `; Path=${options.path}`;
          if (options.expires) cookie += `; Expires=${options.expires.toUTCString()}`;
          if (options.httpOnly) cookie += `; HttpOnly`;
          if (options.secure) cookie += `; Secure`;
          if (options.sameSite) cookie += `; SameSite=${options.sameSite}`;
        }
        headers.append('Set-Cookie', cookie);
        return httpContext;
      }
    },
    json(data: any) {
      if (response) return response;
      response = Response.json(data, { status: statusCode, headers });
      return response;
    },
    text(data: string) {
      if (response) return response;
      response = new Response(data, { status: statusCode, headers });
      return response;
    },
    async next() {
      if (response || !next) return;
      await next();
    }
  }

  return httpContext;
}

export async function createHttp2Context<
  TBody = any,
  TParams extends Record<PropertyKey, string> = Record<PropertyKey, string>
>(
  options: {
    req: Http2Request,
    url: URL,
    params: TParams,
    h2: {
      push: (path: string) => Promise<void>;
      setPriority: (options: {
        weight: number;
        dependency?: number;
        exclusive?: boolean;
      }) => void;
    },
    next?: () => Promise<void>
  }
): Promise<Http2Context<TBody, TParams>> {
  const { req, url, params, h2, next } = options;
  const headers = new Headers();

  const method = getHttpMethod(req.method);
  if (!method) {
    throw new Error(`Unsupported HTTP method: ${req.method}`);
  }

  /* ---------- Body parsing ---------- */

  const contentType = getHeader(req.headers, 'content-type') ?? '';;
  const body = await readHttp2Body(req, contentType);


  /* ---------- Response state ---------- */

  let statusCode = 200;
  let response: Response | null = null;

  const ctx: Http2Context<TBody, TParams> = {
    id: generateId(),

    request: req,
    method,

    params,
    query: url.searchParams,
    streamId: req.stream.id,

    body,

    ip:
      getHeader(req.headers, 'x-forwarded-for')
        ?.split(',')[0]
        ?.trim() ?? '127.0.0.1',

    store: new Map(),

    set: {
      status(code: number) {
        statusCode = code;
        return ctx;
      },

      header(name: string, value: string) {
        headers.set(name, value);
        return ctx;
      },

      cookie(name: string, value: string, options?: ResponseCookieOptions) {
        let cookie = `${name}=${value}`;

        if (options) {
          if (options.maxAge !== undefined) cookie += `; Max-Age=${options.maxAge}`;
          if (options.domain) cookie += `; Domain=${options.domain}`;
          if (options.path) cookie += `; Path=${options.path}`;
          if (options.expires) cookie += `; Expires=${options.expires.toUTCString()}`;
          if (options.httpOnly) cookie += `; HttpOnly`;
          if (options.secure) cookie += `; Secure`;
          if (options.sameSite) cookie += `; SameSite=${options.sameSite}`;
        }

        headers.append('Set-Cookie', cookie);
        return ctx;
      }
    },

    json(data: any) {
      if (response) return response;
      response = Response.json(data, { status: statusCode, headers });
      return response;
    },

    text(data: string) {
      if (response) return response;
      response = new Response(data, { status: statusCode, headers });
      return response;
    },

    async next() {
      if (response || !next) return;
      await next();
    },

    async push(path: string) {
      await h2.push(path);
    },

    setPriority(options) {
      h2.setPriority(options);
    }
  };

  return ctx;
}


export function createStreamContext<TParams = Record<PropertyKey, string>>(
  options: {
    req: Request,
    params: TParams,
    controller: ReadableStreamDefaultController<string>,
    next?: () => Promise<void>,
  }
): StreamContext<TParams> {
  const { req, params, controller, next } = options;
  let open = true;
  const closeHandlers = new Set<() => void>();

  const lastEventId =
    req.headers.get('last-event-id') ??
    req.headers.get('Last-Event-ID') ??
    undefined;

  const write = (chunk: string) => {
    if (!open) return;
    controller.enqueue(chunk);
  };

  const ctx: StreamContext<TParams> = {
    id: generateId(),

    request: req,
    params,

    store: new Map(),

    get open() {
      return open;
    },

    lastEventId,

    send(data: string | object, event?: string, id?: string) {
      if (!open) return;

      if (id) write(`id: ${id}\n`);
      if (event) write(`event: ${event}\n`);

      const payload =
        typeof data === 'string' ? data : JSON.stringify(data);

      // SSE requires data lines to be split
      for (const line of payload.split('\n')) {
        write(`data: ${line}\n`);
      }

      write('\n');
    },

    retry(ms: number) {
      if (!open) return;
      write(`retry: ${ms}\n\n`);
    },

    close() {
      if (!open) return;

      open = false;

      for (const fn of closeHandlers) {
        try {
          fn();
        } catch {
          /* swallow */
        }
      }

      closeHandlers.clear();
      controller.close();
    },

    onClose(callback: () => void) {
      if (!open) {
        callback();
        return;
      }

      closeHandlers.add(callback);
    },

    async next() {
      if (!next) return;
      await next();
    }
  };

  return ctx;
}


export function createEventContext<
  TBody = any,
  TParams extends Record<PropertyKey, string> = Record<PropertyKey, string>
>(
  options: {
    payload: TBody;
    pattern: string;
    params: TParams;

    socket?: any;

    send: (event: string, data: any) => void;
    broadcast?: (event: string, data: any) => void;
    to?: (room: string, event: string, data: any) => void;

    close?: (code?: number, reason?: string) => void;
    isOpen?: () => boolean;

    metadata?: Map<PropertyKey, any>;
    next?: () => Promise<void>;
  }
): EventContext<TBody, TParams> {

  const {
    payload,
    pattern,
    params,
    socket,

    send,
    broadcast,
    to,

    close,
    isOpen,
    next,

    metadata
  } = options;

  let open = isOpen ? isOpen() : true;

  const ctx: EventContext<TBody, TParams> = {
    id: generateId(),

    params,
    payload,

    store: new Map(),
    metadata: metadata ?? new Map(),

    socket,

    get open() {
      return isOpen ? isOpen() : open;
    },

    reply(event: string, data: any) {
      if (!ctx.open) return;
      send(event, data);
    },

    broadcast(event: string, data: any) {
      if (!ctx.open || !broadcast) return;
      broadcast(event, data);
    },

    to(room: string, event: string, data: any) {
      if (!ctx.open || !to) return;
      to(room, event, data);
    },

    ack(data?: any) {
      if (!ctx.open) return;
      send(`${pattern}:ack`, data ?? null);
    },

    close(code?: number, reason?: string) {
      if (!ctx.open) return;

      open = false;

      if (close) {
        close(code, reason);
      }
    },
    async next() {
      if (!next) return;
      await next();
    }
  };

  return ctx;
}


export async function createContextFactory<
  TParams extends Record<PropertyKey, string> = Record<PropertyKey, string>
>(
  protocol: Protocol,
  options: ContextOptions<TParams>
) {
  switch (protocol) {
    case 'HTTP':
      return await createHttpContext<TParams>(options as any);
    case 'HTTP2':
      return await createHttp2Context<TParams>(options as any);
    case 'SSE':
    case 'STREAM':
      return await Promise.resolve(createStreamContext<TParams>(options as any));
    case 'WS':
    case 'EVENT':
      return await Promise.resolve(createEventContext<TParams>(options as any));
    default:
      throw new Error(`Unsupported protocol: ${protocol}`);
  }
}