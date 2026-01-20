// ═══════════════════════════════════════════════════════════════════════════
// STOP CHARACTER LOOKUP TABLE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pre-computed lookup table for stop characters
 * Eliminates charCodeAt calls in hot loops
 */
export const STOP_CHAR_SLASH = 47;       // '/'
export const STOP_CHAR_DASH = 45;        // '-'
export const STOP_CHAR_DOT = 46;         // '.'
export const STOP_CHAR_UNDERSCORE = 95;  // '_'
export const STOP_CHAR_BRACE_OPEN = 123; // '{'
export const STOP_CHAR_BRACE_CLOSE = 125; // '}'
export const STOP_CHAR_BACKSLASH = 92;   // '\'
export const STOP_CHAR_ASTERISK = 42;    // '*'

/**
 * Lookup table for valid stop characters (ASCII 0-127)
 * 1 = valid stop char, 0 = invalid
 */
export const STOP_CHAR_TABLE = new Uint8Array(128);
STOP_CHAR_TABLE[STOP_CHAR_SLASH] = 1;
STOP_CHAR_TABLE[STOP_CHAR_DASH] = 1;
STOP_CHAR_TABLE[STOP_CHAR_DOT] = 1;
STOP_CHAR_TABLE[STOP_CHAR_UNDERSCORE] = 1;

// ═══════════════════════════════════════════════════════════════════════════
// CONST ENUMS FOR ZERO-COST ABSTRACTIONS
// ═══════════════════════════════════════════════════════════════════════════

export const enum OpCode {
  MATCH_LITERAL = 0,
  CAPTURE_UNTIL = 1,
  CAPTURE_REST = 2,
}

export const enum NodeType {
  STATIC = 0,
  PARAM = 1,
  WILDCARD = 2,
}