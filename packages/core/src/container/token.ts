// src/di/token.ts

export class Token<T> {
  // We use a symbol to ensure uniqueness even if two tokens have the same string name
  private readonly symbol: symbol;

  constructor(public readonly name: string) {
    this.symbol = Symbol(name);
  }

  toString(): string {
    return `Token(${this.name})`;
  }
}