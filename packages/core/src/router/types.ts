// ═══════════════════════════════════════════════════════════════════════════
// FIXED-SIZE INSTRUCTION STRUCTURE
// ═══════════════════════════════════════════════════════════════════════════

import type { OpCode } from "./constants";

/**
 * Fixed-size instruction for better cache locality
 * All instructions fit in 64 bytes (cache line size)
 */
export interface Instruction {
  op: OpCode;
  data: Uint8Array | number;
  paramName?: string;
  length?: number; // Cache literal length to avoid .length lookups
}