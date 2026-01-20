// ═══════════════════════════════════════════════════════════════════════════
// PIPELINE
// ═══════════════════════════════════════════════════════════════════════════

import type { ErrorHandler, Handler, RouteContext } from "./types";



export interface PipelineConfig<C extends RouteContext> {
  beforeHandle?: Handler<C>[];
  handler: Handler<C>;
  afterHandle?: Handler<C>[];
  onError?: ErrorHandler<C>;
}

export class AetherPipeline<C extends RouteContext> {
  private stack: Handler<C>[];
  private stackLength: number; // Cache length
  private errorHandler: ErrorHandler<C> | null;

  constructor(config: PipelineConfig<C>) {
    this.stack = [
      ...(config.beforeHandle || []),
      config.handler,
      ...(config.afterHandle || [])
    ];
    this.stackLength = this.stack.length;
    this.errorHandler = config.onError || null;
  }

  reset(config: PipelineConfig<C>): void {
    this.stack.length = 0;
    this.stack.push(
      ...(config.beforeHandle || []),
      config.handler,
      ...(config.afterHandle || [])
    );
    this.stackLength = this.stack.length;
    this.errorHandler = config.onError || null;
  }

  /**
   * Use cached length, avoid try/catch in hot path
   */
  async execute(ctx: C): Promise<void> {
    const len = this.stackLength;
    const stack = this.stack;

    if (this.errorHandler === null) {
      // Fast path: no error handler
      for (let i = 0; i < len; i++) {
        await stack[i]?.(ctx);
      }
    } else {
      // Slow path: with error handling
      try {
        for (let i = 0; i < len; i++) {
          await stack[i]?.(ctx);
        }
      } catch (error) {
        await this.errorHandler(error as Error, ctx);
      }
    }
  }

  /**
   * Synchronous execution path for non-async handlers
   * Avoids Promise overhead when all handlers are sync
   */
  executeSync(ctx: C): void {
    const len = this.stackLength;
    const stack = this.stack;

    if (this.errorHandler === null) {
      for (let i = 0; i < len; i++) {
        (stack[i] as any)(ctx);
      }
    } else {
      try {
        for (let i = 0; i < len; i++) {
          (stack[i] as any)(ctx);
        }
      } catch (error) {
        (this.errorHandler as any)(error as Error, ctx);
      }
    }
  }

  prependMiddleware(middleware: Handler<C>): void {
    this.stack.unshift(middleware);
    this.stackLength = this.stack.length;
  }

  appendMiddleware(middleware: Handler<C>): void {
    this.stack.push(middleware);
    this.stackLength = this.stack.length;
  }
}