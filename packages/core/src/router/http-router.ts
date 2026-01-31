import { PatternMachine } from "./pattern-machine";
import type { MachineConfig, MatchResult } from "./types";

export interface HttpRouterConfig extends MachineConfig {
  /** * String to insert between Method and Path.
   * Default: "" (Relies on path starting with delimiter, e.g. "GET/users")
   */
  methodSeparator?: string;
}

export class HttpRouter<T> {
  private machine: PatternMachine<T>;
  private methodSeparator: string;

  constructor(config: HttpRouterConfig = {}) {
    this.methodSeparator = config.methodSeparator ?? "";

    // Pass the standard machine config down
    this.machine = new PatternMachine<T>(config);
  }

  // --- STANDARD HTTP METHODS ---

  public get(path: string, data: T): void {
    this.register("GET", path, data);
  }

  public post(path: string, data: T): void {
    this.register("POST", path, data);
  }

  public put(path: string, data: T): void {
    this.register("PUT", path, data);
  }

  public patch(path: string, data: T): void {
    this.register("PATCH", path, data);
  }

  public delete(path: string, data: T): void {
    this.register("DELETE", path, data);
  }

  public all(path: string, data: T): void {
    // Convenience to match ANY method (register for all standard ones)
    ["GET", "POST", "PUT", "PATCH", "DELETE"].forEach((m) =>
      this.register(m, path, data),
    );
  }

  // --- CORE API ---

  /**
   * Universal register method if you have custom verbs (e.g. OPTIONS, HEAD)
   */
  public register(method: string, path: string, data: T): void {
    const pattern = this.createKey(method, path);
    this.machine.add(pattern, data);
  }

  /**
   * Lookup a route based on Method + URL
   */
  public lookup(method: string, url: string): MatchResult<T>[] {
    const key = this.createKey(method, url);
    return this.machine.match(key);
  }

  /**
   * Helper: constructs the internal key (e.g., "GET/api/users")
   */
  private createKey(method: string, path: string): string {
    // Uppercase method for consistency
    const prefix = method.toUpperCase() + this.methodSeparator;

    // Ensure we don't accidentally double-slash if separator is "/" and path is "/..."
    // But since the machine normalizes, we can often just concat.
    // However, if the user configures no separator, and path has no slash, it might merge "GETusers".
    // This is why we rely on the user providing a sensible path (usually starting with /).
    return prefix + path;
  }

  // Expose serialization and visualization proxies
  public toJSON() {
    return this.machine.toJSON();
  }

  public getMachine() {
    return this.machine; // Escape hatch for visualizer
  }
}
