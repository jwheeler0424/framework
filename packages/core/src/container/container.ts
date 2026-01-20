// src/di/container.ts
import { Token } from "./token";

// Type definitions for our container
export type Factory<T> = (container: Container) => T;

export interface Provider<T> {
  token: Token<T>;
  useClass?: new (...args: any[]) => T;
  useValue?: T;
  useFactory?: Factory<T>;
  scope?: "singleton" | "transient";
}

// Interface for classes that declare their own dependencies
export interface InjectableClass {
  inject?: Token<any>[];
  new(...args: any[]): any;
}

export class Container {
  private readonly providers = new Map<Token<any>, Provider<any>>();
  private readonly singletons = new Map<Token<any>, any>();

  // Cycle detection stack
  private readonly resolutionStack = new Set<Token<any>>();

  // Register a provider
  register<T>(provider: Provider<T>): void {
    this.providers.set(provider.token, provider);
  }

  // Helper for simple class registration (Singleton by default)
  bind<T>(token: Token<T>, target: InjectableClass): void {
    this.register({ token, useClass: target, scope: "singleton" });
  }

  // Resolve a token to an instance
  resolve<T>(token: Token<T>): T {
    if (this.resolutionStack.has(token)) {
      throw new Error(`Circular dependency detected for ${token.name}. Stack: ${Array.from(this.resolutionStack).map(t => t.name).join(" -> ")}`);
    }

    // 1. Return existing Singleton
    if (this.singletons.has(token)) {
      return this.singletons.get(token);
    }

    const provider = this.providers.get(token);
    if (!provider) {
      throw new Error(`No provider found for ${token.name}`);
    }

    this.resolutionStack.add(token);

    try {
      let instance: T;

      if (provider.useValue !== undefined) {
        instance = provider.useValue;
      } else if (provider.useFactory) {
        // Injection into factories
        instance = provider.useFactory(this);
      } else if (provider.useClass) {
        // AUTOMATIC INJECTION LOGIC
        const Constructor = provider.useClass as InjectableClass;
        // Read the static 'inject' property
        const dependencies = Constructor.inject || [];

        // Recursively resolve all dependencies
        const args = dependencies.map((depToken) => this.resolve(depToken));

        instance = new Constructor(...args);
      } else {
        throw new Error(`Invalid provider configuration for ${token.name}`);
      }

      // Cache if singleton
      if (provider.scope !== "transient") {
        this.singletons.set(token, instance);
      }

      return instance;
    } finally {
      this.resolutionStack.delete(token);
    }
  }
}