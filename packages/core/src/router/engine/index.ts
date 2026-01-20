/**
 * RadixEngine<T> discovery engine (standalone, zero-dependency, Bun/JSC oriented).
 *
 * Major optimizations in this version:
 * - Global transitions pool: a single Uint32Array backing all nodes' 128-wide ASCII jump tables.
 *   This eliminates per-node typed-array allocations and improves cache locality.
 * - finalize(): optional freeze + drop of intern maps for memory savings.
 *
 * Priority rules:
 *   Static transition > Param edges (up to 4 variants) > Wildcard edge.
 *
 * Wildcard rule:
 *   Only supported as trailing segment "/*" (i.e. template ends with '*', and preceding char must be '/').
 *   Wildcard does NOT create a capture; router may derive "rest" from wildcardStart/wildcardEnd if needed.
 */

export type SearchResult<T> = {
  found: boolean;
  value?: T;
  nodeIndex?: number;
  paramCount?: number;
  wildcardStart?: number; // index in `path` where '*' began matching
  wildcardEnd?: number; // usually path.length
};

const enum NodeFlags {
  TERMINAL = 1 << 0,
  HAS_PARAM_EDGE = 1 << 1,
  HAS_WILDCARD_EDGE = 1 << 2,
}

const enum Op {
  MATCH_LITERAL = 1, // [op|char<<8]
  MATCH_LITERAL_SEQ = 2, // [op|len<<8] [strOff]
  CAPTURE_UNTIL = 3, // [op|stop<<8] [captureIndex]
  END = 5, // [op]
}

const ASCII_SLASH = 47; // '/'
const ASCII_LBRACE = 123; // '{'
const ASCII_RBRACE = 125; // '}'
const ASCII_BACKSLASH = 92; // '\'
const ASCII_STAR = 42; // '*'

// Allowed delimiters for path separation.
// Kept as an allowlist to avoid surprising template ambiguity and to keep the engine's
// semantics easy to reason about across integrations.
const enum DelimAscii {
  SLASH = 47,      // '/'
  DOT = 46,        // '.'
  COLON = 58,      // ':'
  PIPE = 124,      // '|'
  SEMICOLON = 59,  // ';'
  COMMA = 44,      // ','
  TILDE = 126,     // '~'
  UNDERSCORE = 95, // '_'
  DASH = 45,       // '-'
}

const AsciiMap = {
  [DelimAscii.SLASH]: '/',
  [DelimAscii.DOT]: '.',
  [DelimAscii.COLON]: ':',
  [DelimAscii.PIPE]: '|',
  [DelimAscii.SEMICOLON]: ';',
  [DelimAscii.COMMA]: ',',
  [DelimAscii.TILDE]: '~',
  [DelimAscii.UNDERSCORE]: '_',
  [DelimAscii.DASH]: '-',
} as const

const Delimiter = {
  SLASH: AsciiMap[DelimAscii.SLASH],
  COLON: AsciiMap[DelimAscii.COLON],
  PIPE: AsciiMap[DelimAscii.PIPE],
} as const;

export type AllowedDelimiter = typeof Delimiter[keyof typeof Delimiter];

export type RadixEngineOptions = {
  nodePoolSizeHint?: number;
  delimiter?: AllowedDelimiter;
  assumeAscii?: boolean;
};

/**
 * Runtime guard for delimiter ASCII codepoints.
 * Useful for JS consumers or defensive checks.
 *
 * `cc` must be an integer 0..127 (ASCII).
 */
export function isAllowedDelimiterAscii(cc: number): boolean {
  switch (cc | 0) {
    case DelimAscii.SLASH:  // '/'
    case DelimAscii.COLON:  // ':'
    case DelimAscii.PIPE: // '|'
      return true;
    default:
      return false;
  }
}

export function isAllowedDelimiter(d: string): d is AllowedDelimiter {
  return d.length === 1 && isAllowedDelimiterAscii(d.charCodeAt(0));
}

const MAX_PARAM_EDGES_PER_NODE = 4;
const TRANSITIONS_WIDTH = 128;

class Node {
  // Index into engine.transitionsPool where this node's 128-slot table begins.
  transBase: number;

  valueIndex: number; // index into values pool (0 = none)
  paramCount: number; // number of params/captures on terminal route
  paramKeysIndex: number; // start index in global paramKeyPool
  flags: number;

  // Up to 4 param edges (variant programs) at the same node.
  paramEdgeCount: number;
  paramChild0: number; paramInstr0: number;
  paramChild1: number; paramInstr1: number;
  paramChild2: number; paramInstr2: number;
  paramChild3: number; paramInstr3: number;

  // wildcard edge (trailing "/*" only)
  wildcardChild: number;

  constructor(transBase: number) {
    this.transBase = transBase | 0;

    this.valueIndex = 0;
    this.paramCount = 0;
    this.paramKeysIndex = 0;
    this.flags = 0;

    this.paramEdgeCount = 0;
    this.paramChild0 = 0; this.paramInstr0 = 0;
    this.paramChild1 = 0; this.paramInstr1 = 0;
    this.paramChild2 = 0; this.paramInstr2 = 0;
    this.paramChild3 = 0; this.paramInstr3 = 0;

    this.wildcardChild = 0;
  }

  getParamChild(slot: number): number {
    switch (slot | 0) {
      case 0: return this.paramChild0 | 0;
      case 1: return this.paramChild1 | 0;
      case 2: return this.paramChild2 | 0;
      case 3: return this.paramChild3 | 0;
      default: return 0;
    }
  }

  getParamInstr(slot: number): number {
    switch (slot | 0) {
      case 0: return this.paramInstr0 | 0;
      case 1: return this.paramInstr1 | 0;
      case 2: return this.paramInstr2 | 0;
      case 3: return this.paramInstr3 | 0;
      default: return 0;
    }
  }

  setParamEdge(slot: number, instr: number, child: number): void {
    instr |= 0; child |= 0;
    switch (slot | 0) {
      case 0: this.paramInstr0 = instr; this.paramChild0 = child; return;
      case 1: this.paramInstr1 = instr; this.paramChild1 = child; return;
      case 2: this.paramInstr2 = instr; this.paramChild2 = child; return;
      case 3: this.paramInstr3 = instr; this.paramChild3 = child; return;
      default: return;
    }
  }
}

export class RadixEngine<T> {
  private nodes: Node[];
  private values: (T | undefined)[];

  // Global transitions pool: nodes are 1-based; nodeIndex N owns [N*128 .. N*128+127]
  private transitionsPool: Uint32Array;
  private transitionsCapNodes: number;

  private instr: Uint32Array;
  private instrLen: number; // next write index; 0 reserved as none

  private literalPool: string;
  private paramKeyPool: string[];

  private routeTemplateToNode: Map<string, number> | null;
  private _scratchTemplateSet: Set<string>;

  private _execCursor: number;
  private _execCap: number;

  private _maxParamCount: number;
  private _defaultMemoryPool: Uint32Array;
  private _defaultOut: SearchResult<T>;

  private _frozen: boolean;
  private _delim: number;
  private _assumeAscii: boolean;

  constructor(opts?: RadixEngineOptions) {
    // Node indices are 1-based. We'll keep nodes[0] unused sentinel.
    this.nodes = [new Node(0)];
    this.values = [undefined];

    this.transitionsCapNodes = Math.max(16, (opts?.nodePoolSizeHint ?? 16) | 0);
    // transitionsPool is sized in "nodes", but we index by nodeIndex * 128.
    this.transitionsPool = new Uint32Array(this.transitionsCapNodes * TRANSITIONS_WIDTH);

    // Create root at index 1
    this._newNode(); // index 1

    this.instr = new Uint32Array(256);
    this.instrLen = 1;

    this.literalPool = "";
    this.paramKeyPool = [];

    this.routeTemplateToNode = new Map();
    this._scratchTemplateSet = new Set();

    this._execCursor = 0;
    this._execCap = 0;

    this._maxParamCount = 0;
    this._defaultMemoryPool = new Uint32Array(0);
    this._defaultOut = { found: false };

    this._frozen = false;
    this._assumeAscii = !!opts?.assumeAscii;

    // Configurable path delimiter.
    // Must be in an allowlist. Default '/'.
    const d = opts?.delimiter ?? Delimiter.SLASH;
    const cc = d.charCodeAt(0);

    // defensive validation (constructor-only cost)
    if ((cc & 0x7f) !== cc) throw new Error("delimiter must be ASCII");
    if (!isAllowedDelimiterAscii(cc)) {
      throw new Error(`delimiter '${d}' is not allowed`);
    }

    this._delim = cc & 0x7f;

  }

  finalize(opts?: { freeze?: boolean; dropInternMap?: boolean }): void {
    if (opts?.dropInternMap) {
      // drops delete-by-template capability; keeps trie intact
      this.routeTemplateToNode = null;
    }
    if (opts?.freeze) {
      this._frozen = true;
    }
  }

  insert(pathTemplate: string, value: T): void {
    if (this._frozen) throw new Error("RadixEngine is frozen (finalize({freeze:true}))");

    const delim = this._delim | 0;
    if (pathTemplate.length === 0 || (pathTemplate.charCodeAt(0) & 0x7f) !== delim) {
      throw this._err(`Template must start with delimiter '${String.fromCharCode(delim)}'`, 0);
    }
    if (this.routeTemplateToNode && this.routeTemplateToNode.has(pathTemplate)) {
      throw this._err("Duplicate route template (already inserted)", 0);
    }

    const seenParamNames = new Set<string>();
    const routeParamKeys: string[] = [];
    let captureCount = 0;

    let nodeIndex = 1;
    let i = 0;
    const templateLen = pathTemplate.length | 0;

    const ensureChild = (from: number, ch: number): number => {
      const fromNode = this.nodes[from]!;
      const base = fromNode.transBase | 0;
      const slot = (base + (ch & 0x7f)) | 0;
      const existing = this.transitionsPool[slot]! | 0;
      if (existing !== 0) return existing;
      const newIndex = this._newNode();
      this.transitionsPool[slot] = newIndex;
      return newIndex;
    };

    while (i < templateLen) {
      const cc = pathTemplate.charCodeAt(i);

      if (cc === ASCII_BACKSLASH) {
        if (i + 1 >= templateLen) throw this._err("Trailing escape '\\' in template", i);
        const next = pathTemplate.charCodeAt(i + 1);
        if ((next & 0x7f) !== next) throw this._err("Non-ASCII escaped literal in template", i);
        nodeIndex = ensureChild(nodeIndex, next);
        i += 2;
        continue;
      }

      // Only wildcard syntax supported: trailing "<delim>*"
      if (cc === ASCII_STAR) {
        if (i + 1 !== templateLen) throw this._err("Wildcard '*' must be trailing", i);
        const prev = i > 0 ? pathTemplate.charCodeAt(i - 1) : 0;
        if ((prev & 0x7f) !== delim) {
          throw this._err(`Wildcard '*' must appear as trailing segment '${String.fromCharCode(delim)}*'`, i);
        }

        const startNode = this.nodes[nodeIndex]!;
        if ((startNode.flags & NodeFlags.HAS_WILDCARD_EDGE) !== 0) {
          throw this._err("Conflicting wildcard edge at same position", i);
        }

        const destNode = this._newNode();
        startNode.flags |= NodeFlags.HAS_WILDCARD_EDGE;
        startNode.wildcardChild = destNode;

        nodeIndex = destNode;
        i = templateLen;
        continue;
      }

      if (cc === ASCII_LBRACE) {
        const compiled = this._compileParamEdge(pathTemplate, i, delim, seenParamNames, routeParamKeys, captureCount);
        captureCount = compiled.captureCount | 0;

        const startNode = this.nodes[nodeIndex]!;
        const child = this._installParamEdgeVariant(startNode, compiled.instrStart, compiled.destNode, i);
        nodeIndex = child | 0;
        i = compiled.nextIndex | 0;
        continue;
      }

      if (cc === ASCII_RBRACE) throw this._err("Unmatched '}'", i);
      if ((cc & 0x7f) !== cc) throw this._err("Non-ASCII character in template (engine requires ASCII)", i);

      nodeIndex = ensureChild(nodeIndex, cc);
      i++;
    }

    const term = this.nodes[nodeIndex]!;
    if ((term.flags & NodeFlags.TERMINAL) !== 0) {
      throw this._err("Route already exists at this terminal (would override)", templateLen - 1);
    }

    const valueIndex = this._newValue(value);
    term.valueIndex = valueIndex;
    term.flags |= NodeFlags.TERMINAL;

    if (routeParamKeys.length > 0) {
      term.paramCount = routeParamKeys.length | 0;
      term.paramKeysIndex = this.paramKeyPool.length | 0;
      for (let k = 0; k < routeParamKeys.length; k++) this.paramKeyPool.push(routeParamKeys[k]!);
    } else {
      term.paramCount = 0;
      term.paramKeysIndex = 0;
    }

    // Grow internal default pool for DX search()
    const pc = term.paramCount | 0;
    if (pc > this._maxParamCount) {
      this._maxParamCount = pc;
      const needed = (pc << 1) | 0;
      if (this._defaultMemoryPool.length < needed) {
        let cap = this._defaultMemoryPool.length | 0;
        if (cap === 0) cap = 2;
        while (cap < needed) cap = (cap << 1) | 0;
        this._defaultMemoryPool = new Uint32Array(cap);
      }
    }

    if (this.routeTemplateToNode) this.routeTemplateToNode.set(pathTemplate, nodeIndex);
  }

  delete(pathTemplate: string): void {
    if (this._frozen) throw new Error("RadixEngine is frozen (finalize({freeze:true}))");
    if (!this.routeTemplateToNode) {
      throw new Error("delete(template) unavailable: finalize({dropInternMap:true}) was used");
    }

    const idx = this.routeTemplateToNode.get(pathTemplate);
    if (idx === undefined) return;

    const nodeIndex = idx | 0;
    const term = this.nodes[nodeIndex]!;
    if ((term.flags & NodeFlags.TERMINAL) !== 0) {
      term.flags &= ~NodeFlags.TERMINAL;
      term.valueIndex = 0;
      term.paramCount = 0;
      term.paramKeysIndex = 0;
    }
    this.routeTemplateToNode.delete(pathTemplate);
  }

  search(path: string): SearchResult<T> {
    this.searchInto(path, this._defaultMemoryPool, this._defaultOut);
    return this._defaultOut;
  }

  searchInto(path: string, memoryPool: Uint32Array, out: SearchResult<T>): boolean {
    out.found = false;
    out.value = undefined;
    out.nodeIndex = undefined;
    out.paramCount = undefined;
    out.wildcardStart = undefined;
    out.wildcardEnd = undefined;

    // Enforce "already-decoded ASCII path" contract:
    // - rejects any non-ASCII code unit
    // - (does not attempt URI decoding)
    //
    // If you want maximum perf and can guarantee ASCII upstream, pass {assumeAscii:true}
    // to skip this scan.
    if (!this._assumeAscii) {
      for (let j = 0, n = path.length | 0; j < n; j++) {
        const cc = path.charCodeAt(j);
        if ((cc & 0x7f) !== cc) return false;
      }
    }

    let cap = 0;
    let nodeIndex = 1;
    let cursor = 0;
    const len = path.length | 0;

    while (true) {
      if (cursor === len) {
        const node = this.nodes[nodeIndex]!;
        if ((node.flags & NodeFlags.TERMINAL) !== 0) {
          out.found = true;
          out.nodeIndex = nodeIndex;
          out.paramCount = node.paramCount | 0;
          out.value = this.values[node.valueIndex];
          return true;
        }
        if ((node.flags & NodeFlags.HAS_WILDCARD_EDGE) !== 0) {
          const destIndex = node.wildcardChild | 0;
          const dest = this.nodes[destIndex]!;
          if ((dest.flags & NodeFlags.TERMINAL) !== 0) {
            out.found = true;
            out.nodeIndex = destIndex;
            out.paramCount = dest.paramCount | 0;
            out.value = this.values[dest.valueIndex];
            out.wildcardStart = cursor;
            out.wildcardEnd = len;
            return true;
          }
        }
        return false;
      }

      const node = this.nodes[nodeIndex]!;
      const cc = path.charCodeAt(cursor);
      const ch = cc & 0x7f;

      // Static branch
      const next = this.transitionsPool[(node.transBase + ch) | 0]! | 0;
      if (next !== 0 && cc === ch) {
        nodeIndex = next;
        cursor++;
        continue;
      }

      // Param variants (up to 4)
      if ((node.flags & NodeFlags.HAS_PARAM_EDGE) !== 0) {
        const ec = node.paramEdgeCount | 0;

        // slot 0
        if (ec > 0) {
          if (this._execInstr(node.paramInstr0 | 0, path, cursor, memoryPool, cap)) {
            cap = this._execCap | 0;
            cursor = this._execCursor | 0;
            nodeIndex = node.paramChild0 | 0;
            continue;
          }
        }
        // slot 1
        if (ec > 1) {
          if (this._execInstr(node.paramInstr1 | 0, path, cursor, memoryPool, cap)) {
            cap = this._execCap | 0;
            cursor = this._execCursor | 0;
            nodeIndex = node.paramChild1 | 0;
            continue;
          }
        }
        // slot 2
        if (ec > 2) {
          if (this._execInstr(node.paramInstr2 | 0, path, cursor, memoryPool, cap)) {
            cap = this._execCap | 0;
            cursor = this._execCursor | 0;
            nodeIndex = node.paramChild2 | 0;
            continue;
          }
        }
        // slot 3
        if (ec > 3) {
          if (this._execInstr(node.paramInstr3 | 0, path, cursor, memoryPool, cap)) {
            cap = this._execCap | 0;
            cursor = this._execCursor | 0;
            nodeIndex = node.paramChild3 | 0;
            continue;
          }
        }
      }

      // Wildcard (lowest priority): trailing wildcard consumes rest; no capture
      if ((node.flags & NodeFlags.HAS_WILDCARD_EDGE) !== 0) {
        const destIndex = node.wildcardChild | 0;
        const dest = this.nodes[destIndex]!;
        if ((dest.flags & NodeFlags.TERMINAL) !== 0) {
          out.found = true;
          out.nodeIndex = destIndex;
          out.paramCount = dest.paramCount | 0;
          out.value = this.values[dest.valueIndex];
          out.wildcardStart = cursor;
          out.wildcardEnd = len;
          return true;
        }
      }

      return false;
    }
  }

  isPrefix(prefix: string): boolean {
    let nodeIndex = 1;
    let i = 0;
    const len = prefix.length | 0;
    while (i < len) {
      const cc = prefix.charCodeAt(i);
      const ch = cc & 0x7f;
      if (cc !== ch) return false;
      const node = this.nodes[nodeIndex]!;
      const next = this.transitionsPool[(node.transBase + ch) | 0]! | 0;
      if (next === 0) return false;
      nodeIndex = next;
      i++;
    }
    return true;
  }

  prefixSearch(prefix: string): T[] {
    let nodeIndex = 1;
    let i = 0;
    const len = prefix.length | 0;
    while (i < len) {
      const cc = prefix.charCodeAt(i);
      const ch = cc & 0x7f;
      if (cc !== ch) return [];
      const node = this.nodes[nodeIndex]!;
      const next = this.transitionsPool[(node.transBase + ch) | 0]! | 0;
      if (next === 0) return [];
      nodeIndex = next;
      i++;
    }
    const out: T[] = [];
    this._dfsCollect(nodeIndex, out);
    return out;
  }

  getParamKeysForNode(nodeIndex: number): string[] {
    const n = this.nodes[nodeIndex]!;
    const count = n?.paramCount | 0;
    if (!count) return [];
    const start = n!.paramKeysIndex | 0;
    return this.paramKeyPool.slice(start, start + count);
  }

  insertBatchParallel(templates: string[], values: T[]): void {
    const n = templates.length | 0;
    if ((values.length | 0) !== n) {
      throw new Error("insertBatchParallel: templates.length must equal values.length");
    }
    const seen = this._scratchTemplateSet;
    seen.clear();
    for (let i = 0; i < n; i++) {
      const t = templates[i]!;
      if (seen.has(t)) throw new Error(`insertBatchParallel: duplicate template in batch: ${t}`);
      if (this.routeTemplateToNode && this.routeTemplateToNode.has(t)) throw new Error(`insertBatchParallel: template already inserted: ${t}`);
      seen.add(t);
    }
    for (let i = 0; i < n; i++) this.insert(templates[i]!, values[i]!);
  }

  insertBatch(entries: Array<[pathTemplate: string, value: T]>): void {
    const n = entries.length | 0;
    const seen = this._scratchTemplateSet;
    seen.clear();
    for (let i = 0; i < n; i++) {
      const t = entries[i]![0];
      if (seen.has(t)) throw new Error(`insertBatch: duplicate template in batch: ${t}`);
      if (this.routeTemplateToNode && this.routeTemplateToNode.has(t)) throw new Error(`insertBatch: template already inserted: ${t}`);
      seen.add(t);
    }
    for (let i = 0; i < n; i++) {
      const e = entries[i]!;
      this.insert(e[0], e[1]);
    }
  }

  insertBatchFromObject(routes: Record<string, T>): void {
    const seen = this._scratchTemplateSet;
    seen.clear();
    for (const t in routes) {
      if (!Object.prototype.hasOwnProperty.call(routes, t)) continue;
      if (seen.has(t)) throw new Error(`insertBatchFromObject: duplicate template in batch: ${t}`);
      if (this.routeTemplateToNode && this.routeTemplateToNode.has(t)) throw new Error(`insertBatchFromObject: template already inserted: ${t}`);
      seen.add(t);
    }
    for (const t in routes) {
      if (!Object.prototype.hasOwnProperty.call(routes, t)) continue;
      this.insert(t, routes[t]!);
    }
  }

  // -------------------------
  // Internal: DFS for prefixSearch
  // -------------------------

  private _dfsCollect(nodeIndex: number, out: T[]): void {
    const n = this.nodes[nodeIndex]!;
    if ((n.flags & NodeFlags.TERMINAL) !== 0) {
      const v = this.values[n.valueIndex];
      if (v !== undefined) out.push(v);
    }

    const base = n.transBase | 0;
    for (let c = 0; c < 128; c++) {
      const child = this.transitionsPool[base + c]! | 0;
      if (child !== 0) this._dfsCollect(child, out);
    }
    if ((n.flags & NodeFlags.HAS_PARAM_EDGE) !== 0) {
      const ec = n.paramEdgeCount | 0;
      for (let s = 0; s < ec; s++) this._dfsCollect(n.getParamChild(s), out);
    }
    if ((n.flags & NodeFlags.HAS_WILDCARD_EDGE) !== 0) this._dfsCollect(n.wildcardChild | 0, out);
  }

  // -------------------------
  // Internal: param-edge variant install with program identity check
  // -------------------------

  private _installParamEdgeVariant(startNode: Node, instrStart: number, destNode: number, atIndex: number): number {
    if ((startNode.flags & NodeFlags.HAS_PARAM_EDGE) === 0) {
      startNode.flags |= NodeFlags.HAS_PARAM_EDGE;
      startNode.paramEdgeCount = 1;
      startNode.setParamEdge(0, instrStart, destNode);
      return destNode | 0;
    }

    const ec = startNode.paramEdgeCount | 0;

    for (let slot = 0; slot < ec; slot++) {
      const existingInstr = startNode.getParamInstr(slot) | 0;
      if (this._instrEqual(existingInstr, instrStart)) {
        return startNode.getParamChild(slot) | 0;
      }
    }

    if (ec >= MAX_PARAM_EDGES_PER_NODE) {
      throw this._err(`Too many param edge variants at same position (max ${MAX_PARAM_EDGES_PER_NODE})`, atIndex);
    }

    startNode.setParamEdge(ec, instrStart, destNode);
    startNode.paramEdgeCount = (ec + 1) | 0;
    return destNode | 0;
  }

  private _instrEqual(aStart: number, bStart: number): boolean {
    let a = aStart | 0;
    let b = bStart | 0;

    while (true) {
      const wa = this.instr[a]! | 0;
      const wb = this.instr[b]! | 0;
      const opa = wa & 0xff;
      const opb = wb & 0xff;
      if (opa !== opb) return false;

      if (opa === Op.MATCH_LITERAL || opa === Op.CAPTURE_UNTIL) {
        if ((wa >>> 8) !== (wb >>> 8)) return false;
        a += 2; b += 2;
        continue;
      }

      if (opa === Op.MATCH_LITERAL_SEQ) {
        if ((wa >>> 8) !== (wb >>> 8)) return false;
        const offA = this.instr[a + 1]! | 0;
        const offB = this.instr[b + 1]! | 0;
        if (offA !== offB) return false;
        a += 2; b += 2;
        continue;
      }

      if (opa === Op.END) return true;
      return false;
    }
  }

  // -------------------------
  // Internal: instruction execution (no allocations)
  // -------------------------

  private _execInstr(instrStart: number, path: string, cursorIn: number, memoryPool: Uint32Array, capIn: number): boolean {
    let ip = instrStart | 0;
    let cursor = cursorIn | 0;
    let cap = capIn | 0;
    const len = path.length | 0;

    // Fast-path: CAPTURE_UNTIL(<delim>) ; END
    const w0 = this.instr[ip]! | 0;
    const delim = this._delim | 0;
    if ((w0 & 0xff) === Op.CAPTURE_UNTIL && (((w0 >>> 8) & 0xff) === (delim & 0xff))) {
      const wNext = this.instr[ip + 2]! | 0;
      if ((wNext & 0xff) === Op.END) {
        const start = cursor | 0;
        while (cursor < len) {
          const cc = path.charCodeAt(cursor);
          const ch = cc & 0x7f;
          if (cc !== ch) return false;
          if (ch === delim) break;
          cursor++;
        }
        const end = cursor | 0;

        const base = (cap << 1) | 0;
        if (base + 1 >= memoryPool.length) return false;
        memoryPool[base] = start >>> 0;
        memoryPool[base + 1] = end >>> 0;

        this._execCursor = cursor | 0;
        this._execCap = (cap + 1) | 0;
        return true;
      }
    }

    // Fast-path: "{a}.{b}" inside a segment:
    //   CAPTURE_UNTIL('.') ; MATCH_LITERAL('.') ; CAPTURE_UNTIL('/') ; END
    //
    // Common for file extension routing: "/files/{name}.{ext}"
    const wA = w0 | 0;
    if ((wA & 0xff) === Op.CAPTURE_UNTIL && (((wA >>> 8) & 0xff) === 46 /* '.' */)) {
      const w1 = this.instr[ip + 2]! | 0;
      const w2 = this.instr[ip + 3]! | 0;
      const w3 = this.instr[ip + 5]! | 0;
      if (
        ((w1 & 0xff) === Op.MATCH_LITERAL) &&
        (((w1 >>> 8) & 0xff) === 46 /* '.' */) &&
        ((w2 & 0xff) === Op.CAPTURE_UNTIL) &&
        (((w2 >>> 8) & 0xff) === ASCII_SLASH) &&
        ((w3 & 0xff) === Op.END)
      ) {
        // capture 0 until '.'
        const start0 = cursor | 0;
        while (cursor < len) {
          const cc = path.charCodeAt(cursor);
          const ch = cc & 0x7f;
          if (cc !== ch) return false;
          if (ch === 46 /* '.' */) break;
          cursor++;
        }
        const end0 = cursor | 0;
        if (cursor >= len) return false;
        // must match '.'
        if (path.charCodeAt(cursor) !== 46 /* '.' */) return false;
        cursor++;

        // capture 1 until '/'
        const start1 = cursor | 0;
        while (cursor < len) {
          const cc = path.charCodeAt(cursor);
          const ch = cc & 0x7f;
          if (cc !== ch) return false;
          if (ch === ASCII_SLASH) break;
          cursor++;
        }
        const end1 = cursor | 0;

        const base0 = (cap << 1) | 0;
        const base1 = ((cap + 1) << 1) | 0;
        if (base1 + 1 >= memoryPool.length) return false;
        memoryPool[base0] = start0 >>> 0;
        memoryPool[base0 + 1] = end0 >>> 0;
        memoryPool[base1] = start1 >>> 0;
        memoryPool[base1 + 1] = end1 >>> 0;

        this._execCursor = cursor | 0;
        this._execCap = (cap + 2) | 0;
        return true;
      }
    }

    while (true) {
      const w = this.instr[ip]! | 0;
      const op = w & 0xff;

      if (op === Op.MATCH_LITERAL) {
        const lit = (w >>> 8) & 0xff;
        if (cursor >= len) return false;
        const cc = path.charCodeAt(cursor);
        if ((cc & 0x7f) !== cc) return false;
        if (cc !== lit) return false;
        cursor++;
        ip++;
        continue;
      }

      if (op === Op.MATCH_LITERAL_SEQ) {
        const seqLen = (w >>> 8) & 0xffff;
        const off = this.instr[ip + 1]! | 0;
        let k = 0;
        while (k < seqLen) {
          if (cursor >= len) return false;
          const cc = path.charCodeAt(cursor);
          const lc = this.literalPool.charCodeAt(off + k);
          if ((cc & 0x7f) !== cc) return false;
          if (cc !== lc) return false;
          cursor++;
          k++;
        }
        ip += 2;
        continue;
      }

      if (op === Op.CAPTURE_UNTIL) {
        const stop = (w >>> 8) & 0xff;

        const start = cursor | 0;
        while (cursor < len) {
          const cc = path.charCodeAt(cursor);
          const ch = cc & 0x7f;
          if (cc !== ch) return false;
          if (ch === stop) break;
          cursor++;
        }
        const end = cursor | 0;

        const base = (cap << 1) | 0;
        if (base + 1 >= memoryPool.length) return false;
        memoryPool[base] = start >>> 0;
        memoryPool[base + 1] = end >>> 0;
        cap++;

        ip += 2;
        continue;
      }

      if (op === Op.END) {
        this._execCursor = cursor | 0;
        this._execCap = cap | 0;
        return true;
      }

      return false;
    }
  }

  // -------------------------
  // Internal: template compilation
  // -------------------------

  private _compileParamEdge(
    template: string,
    lbraceIndex: number,
    delim: number,
    seen: Set<string>,
    routeParamKeys: string[],
    captureCountIn: number,
  ): { instrStart: number; destNode: number; nextIndex: number; captureCount: number } {
    const len = template.length | 0;
    let i = lbraceIndex | 0;
    if (template.charCodeAt(i) !== ASCII_LBRACE) throw this._err("Internal: expected '{'", i);
    i++;

    const nameStart = i;
    while (i < len) {
      const cc = template.charCodeAt(i);
      if (cc === ASCII_RBRACE) break;
      if (cc === ASCII_BACKSLASH) throw this._err("Escapes not allowed in parameter name", i);

      const isAZ = (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122);
      const is09 = cc >= 48 && cc <= 57;
      const isUS = cc === 95;
      if (!(isAZ || is09 || isUS)) throw this._err("Invalid character in parameter name", i);
      i++;
    }
    if (i >= len) throw this._err("Unclosed '{' in template", lbraceIndex);
    if (i === nameStart) throw this._err("Empty parameter name", lbraceIndex);

    const name = template.slice(nameStart, i);
    if (seen.has(name)) throw this._err(`Duplicate parameter name '${name}'`, nameStart);
    seen.add(name);

    if (template.charCodeAt(i) !== ASCII_RBRACE) throw this._err("Unclosed '{' in template", lbraceIndex);
    i++; // past '}'

    const instrStart = this.instrLen | 0;
    let captureCount = captureCountIn | 0;

    routeParamKeys.push(name);

    delim |= 0;
    let stopChar = delim;
    if (i < len) {
      const cc = template.charCodeAt(i);
      if (((cc & 0x7f) === delim)) stopChar = delim;
      else if (cc === ASCII_LBRACE) throw this._err("Adjacent parameters without delimiter are unsupported", i);
      else if (cc === ASCII_STAR) throw this._err("'*' is only supported as trailing wildcard segment", i);
      else if (cc === ASCII_BACKSLASH) {
        if (i + 1 >= len) throw this._err("Trailing escape '\\' in template", i);
        const esc = template.charCodeAt(i + 1);
        if ((esc & 0x7f) !== esc) throw this._err("Non-ASCII escaped literal", i);
        stopChar = esc & 0x7f;
      } else {
        if ((cc & 0x7f) !== cc) throw this._err("Non-ASCII literal in template", i);
        stopChar = cc & 0x7f;
      }
    }
    this._emitCaptureUntil(stopChar, captureCount);
    captureCount++;

    while (i < len) {
      const cc = template.charCodeAt(i);
      if (((cc & 0x7f) === delim)) break;

      if (cc !== ASCII_LBRACE) {
        const litOff = this.literalPool.length | 0;
        let litLen = 0;

        while (i < len) {
          const c2 = template.charCodeAt(i);
          if (((c2 & 0x7f) === delim) || c2 === ASCII_LBRACE) break;
          if (c2 === ASCII_RBRACE) throw this._err("Unmatched '}'", i);
          if (c2 === ASCII_STAR) throw this._err("'*' is only supported as trailing wildcard segment", i);

          if (c2 === ASCII_BACKSLASH) {
            if (i + 1 >= len) throw this._err("Trailing escape '\\' in template", i);
            const esc = template.charCodeAt(i + 1);
            if ((esc & 0x7f) !== esc) throw this._err("Non-ASCII escaped literal", i);
            this.literalPool += String.fromCharCode(esc);
            litLen++;
            i += 2;
            continue;
          }

          if ((c2 & 0x7f) !== c2) throw this._err("Non-ASCII literal in template", i);
          this.literalPool += String.fromCharCode(c2);
          litLen++;
          i++;
        }

        if (litLen === 1) this._emitMatchLiteral(this.literalPool.charCodeAt(litOff));
        else if (litLen > 1) this._emitMatchLiteralSeq(litOff, litLen);
        continue;
      }

      const braceAt = i | 0;
      i++; // skip '{'

      const nameStart2 = i;
      while (i < len) {
        const c3 = template.charCodeAt(i);
        if (c3 === ASCII_RBRACE) break;
        const isAZ = (c3 >= 65 && c3 <= 90) || (c3 >= 97 && c3 <= 122);
        const is09 = c3 >= 48 && c3 <= 57;
        const isUS = c3 === 95;
        if (!(isAZ || is09 || isUS)) throw this._err("Invalid character in parameter name", i);
        i++;
      }
      if (i >= len) throw this._err("Unclosed '{' in template", braceAt);
      if (i === nameStart2) throw this._err("Empty parameter name", braceAt);

      const name2 = template.slice(nameStart2, i);
      if (seen.has(name2)) throw this._err(`Duplicate parameter name '${name2}'`, nameStart2);
      seen.add(name2);

      if (template.charCodeAt(i) !== ASCII_RBRACE) throw this._err("Unclosed '{' in template", braceAt);
      i++; // skip '}'

      routeParamKeys.push(name2);

      let stop2 = delim;
      if (i < len) {
        const nx = template.charCodeAt(i);
        if (((nx & 0x7f) === delim)) stop2 = delim;
        else if (nx === ASCII_LBRACE) throw this._err("Adjacent parameters without delimiter are unsupported", i);
        else if (nx === ASCII_STAR) throw this._err("'*' is only supported as trailing wildcard segment", i);
        else if (nx === ASCII_BACKSLASH) {
          if (i + 1 >= len) throw this._err("Trailing escape '\\' in template", i);
          const esc = template.charCodeAt(i + 1);
          if ((esc & 0x7f) !== esc) throw this._err("Non-ASCII escaped literal", i);
          stop2 = esc & 0x7f;
        } else {
          if ((nx & 0x7f) !== nx) throw this._err("Non-ASCII literal in template", i);
          stop2 = nx & 0x7f;
        }
      }
      this._emitCaptureUntil(stop2, captureCount);
      captureCount++;
    }

    this._emitEnd();
    const destNode = this._newNode();
    return { instrStart, destNode, nextIndex: i, captureCount };
  }

  // -------------------------
  // Internal: allocation / emission
  // -------------------------

  private _ensureTransitionsForNodeCount(requiredNodeCount: number): void {
    if (requiredNodeCount < this.transitionsCapNodes) return;
    let cap = this.transitionsCapNodes | 0;
    while (cap <= requiredNodeCount) cap = (cap << 1) | 0;
    const next = new Uint32Array(cap * TRANSITIONS_WIDTH);
    next.set(this.transitionsPool);
    this.transitionsPool = next;
    this.transitionsCapNodes = cap;
  }

  private _newNode(): number {
    const newIndex = this.nodes.length | 0;
    // Ensure transitionsPool can address newIndex * 128 + 127
    this._ensureTransitionsForNodeCount(newIndex + 1);
    const transBase = (newIndex * TRANSITIONS_WIDTH) | 0;
    this.nodes.push(new Node(transBase));
    return newIndex | 0;
  }

  private _newValue(v: T): number {
    this.values.push(v);
    return (this.values.length - 1) | 0;
  }

  private _ensureInstr(n: number): void {
    const need = (this.instrLen + n) | 0;
    if (need < this.instr.length) return;
    let cap = this.instr.length | 0;
    while (cap <= need) cap = (cap << 1) | 0;
    const next = new Uint32Array(cap);
    next.set(this.instr);
    this.instr = next;
  }

  private _emitMatchLiteral(ch: number): void {
    this._ensureInstr(1);
    this.instr[this.instrLen++] = (Op.MATCH_LITERAL | ((ch & 0xff) << 8)) >>> 0;
  }

  private _emitMatchLiteralSeq(off: number, len: number): void {
    this._ensureInstr(2);
    this.instr[this.instrLen++] = (Op.MATCH_LITERAL_SEQ | ((len & 0xffff) << 8)) >>> 0;
    this.instr[this.instrLen++] = off >>> 0;
  }

  private _emitCaptureUntil(stopChar: number, _captureIndex: number): void {
    this._ensureInstr(2);
    this.instr[this.instrLen++] = (Op.CAPTURE_UNTIL | ((stopChar & 0xff) << 8)) >>> 0;
    this.instr[this.instrLen++] = _captureIndex >>> 0;
  }

  private _emitEnd(): void {
    this._ensureInstr(1);
    this.instr[this.instrLen++] = Op.END >>> 0;
  }

  private _err(message: string, index: number): Error {
    const e = new Error(`${message} at index ${index}`);
    (e as any).index = index;
    return e;
  }
}

export default RadixEngine;