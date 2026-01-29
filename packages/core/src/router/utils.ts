/**
 * Utility functions
 * --------------------
 */

import type { MachineConfig } from "./types";

export function normalizeInput(
  input: string,
  config: Required<MachineConfig>,
): string {
  let result = input;

  if (!config.caseSensitive) {
    result = result.toLowerCase();
  }

  if (config.ignoreDuplicateDelimiter) {
    const d = config.delimiter;
    // Fast loop to replace double delimiters
    while (result.includes(d + d)) {
      result = result.split(d + d).join(d);
    }
  }

  if (
    config.ignoreTrailingDelimiter &&
    result.length > 1 &&
    result.endsWith(config.delimiter)
  ) {
    result = result.slice(0, -1);
  }

  return result;
}

export function getCommonPrefixLength(s1: string, s2: string): number {
  let i = 0;
  const len = Math.min(s1.length, s2.length);
  while (i < len && s1.charCodeAt(i) === s2.charCodeAt(i)) i++;
  return i;
}
