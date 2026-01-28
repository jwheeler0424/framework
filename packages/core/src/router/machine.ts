import { RadixNode } from "./node";
import { NodeType, type Token } from "./types";

// --- The Matcher Interfaces ---

// A lightweight Linked List node to track params without object allocation
interface ParamLinkedList {
  key: string;
  value: string;
  next: ParamLinkedList | null;
}

// The state of our traversal cursor
interface StackFrame<T> {
  node: RadixNode<T>;
  cursor: number;
  params: ParamLinkedList | null;
}

// The final output format
interface MatchResult<T> {
  params: Record<string, string>;
  data: T;
}

interface MachineConfig {
  delimiter?: string;
  ignoreTrailingDelimiter?: boolean;
  ignoreDuplicateDelimiter?: boolean;
  maxParamLength?: number;
  caseSensitive?: boolean;
}

// The Machine
// --------------------
export class PatternMachine<T> {
  private root: RadixNode<T>;
  private readonly config: Required<MachineConfig>;

  constructor(config: MachineConfig = {}) {
    this.config = {
      delimiter: config.delimiter ?? "/",
      ignoreTrailingDelimiter: config.ignoreTrailingDelimiter ?? true,
      ignoreDuplicateDelimiter: config.ignoreDuplicateDelimiter ?? true,
      maxParamLength: config.maxParamLength ?? 1024,
      caseSensitive: config.caseSensitive ?? true,
    };
    this.root = new RadixNode<T>();
  }

  // --- PRE-PROCESSING ---

  private normalize(path: string): string {
    let result = path;

    if (!this.config.caseSensitive) {
      result = result.toLowerCase();
    }

    if (this.config.ignoreDuplicateDelimiter) {
      // Replaces multiple delimiters (e.g., //) with one
      const d = this.config.delimiter;
      // We avoid Regex here for performance; using a simple loop
      while (result.includes(d + d)) {
        result = result.split(d + d).join(d);
      }
    }

    if (
      this.config.ignoreTrailingDelimiter &&
      result.endsWith(this.config.delimiter)
    ) {
      result = result.slice(0, -1);
    }

    return result;
  }

  // --- COMPILER PHASE (Insertion) ---

  /**
   * Insert a pattern into the tree.
   * Format: "user/profile", "user/{id}", "files/*"
   */
  public add(pattern: string, data: T): void {
    const normalized = this.normalize(pattern);
    const tokens = this.tokenize(normalized);
    this.insert(this.root, tokens, data);
  }

  /**
   * Finds all patterns that match the input string.
   */
  public match(input: string): MatchResult<T>[] {
    const normalizedInput = this.normalize(input);
    const results: MatchResult<T>[] = [];
    const stack: StackFrame<T>[] = [
      { node: this.root, cursor: 0, params: null },
    ];

    const delim = this.config.delimiter;

    while (stack.length > 0) {
      const { node, cursor, params } = stack.pop()!;

      // End of string reached
      if (cursor >= normalizedInput.length) {
        if (node.endData.length > 0) {
          results.push(this.buildResult(node.endData, params));
        }
        continue;
      }

      // 1. Static Match
      const char = normalizedInput[cursor] ?? "";
      const staticChild = node.staticChildren.get(char);
      if (staticChild && normalizedInput.startsWith(staticChild.part, cursor)) {
        stack.push({
          node: staticChild,
          cursor: cursor + staticChild.part.length,
          params: params,
        });
      }

      // 2. Wildcard Match
      if (node.wildcardChild) {
        let nextDelim = normalizedInput.indexOf(delim, cursor);
        if (nextDelim === -1) nextDelim = normalizedInput.length;

        stack.push({
          node: node.wildcardChild,
          cursor: nextDelim,
          params: params,
        });
      }

      // 3. Parameter Match
      if (node.paramChild) {
        let nextDelim = normalizedInput.indexOf(delim, cursor);
        if (nextDelim === -1) nextDelim = normalizedInput.length;

        const valLen = nextDelim - cursor;
        if (valLen <= this.config.maxParamLength) {
          const paramValue = normalizedInput.slice(cursor, nextDelim);
          stack.push({
            node: node.paramChild,
            cursor: nextDelim,
            params: {
              key: node.paramChild.paramName!,
              value: paramValue,
              next: params,
            },
          });
        }
      }
    }

    return results;
  }

  private insert(node: RadixNode<T>, tokens: Token[], data: T): void {
    // Base Case: No more tokens? We are at the end.
    if (tokens.length === 0) {
      node.addResult(data);
      return;
    }

    const token = tokens[0];
    const remainingTokens = tokens.slice(1);

    // --- Scenario A: Parameter or Wildcard ---
    // These cannot be compressed like static strings (for simplicity and speed).
    // We just traverse or create the slot.
    if (token?.type === NodeType.PARAM) {
      if (!node.paramChild) {
        node.paramChild = new RadixNode<T>("", NodeType.PARAM, token.value);
      }
      // Note: We ignore the node.part for params, as they match ANY text until the next separator
      this.insert(node.paramChild, remainingTokens, data);
      return;
    }

    if (token?.type === NodeType.WILDCARD) {
      if (!node.wildcardChild) {
        node.wildcardChild = new RadixNode<T>("", NodeType.WILDCARD);
      }
      this.insert(node.wildcardChild, remainingTokens, data);
      return;
    }

    // --- Scenario B: Static String (The Radix Logic) ---
    // We need to look for a child that shares a common prefix.

    // Check if we have an edge starting with the first char of our token
    // Using the first char as a key is a simple heuristic for the Map
    let edge = node.staticChildren.get(token?.value[0]!);

    if (edge) {
      // Calculate common prefix length
      const commonPrefixLen = this.getCommonPrefixLength(
        edge.part,
        token?.value!,
      );

      // CASE 1: Full Match (Go deeper)
      // Edge: "user/", Token: "user/" -> Recurse
      if (
        commonPrefixLen === edge.part.length &&
        commonPrefixLen === token?.value.length
      ) {
        this.insert(edge, remainingTokens, data);
        return;
      }

      // CASE 2: Partial Match (Split the node)
      // Edge: "users", Token: "user"
      // We must split "users" into "user" -> "s"
      if (commonPrefixLen < edge.part.length) {
        const commonPart = edge.part.slice(0, commonPrefixLen);
        const remainderEdge = edge.part.slice(commonPrefixLen);
        const remainderToken = token?.value.slice(commonPrefixLen);

        // 1. Create a new parent node for the split
        const splitNode = new RadixNode<T>(commonPart, NodeType.STATIC);

        // 2. Transfer the current edge's children/data to the new 'remainder' child
        // Essentially pushing the current edge down
        const newChild = new RadixNode<T>(remainderEdge, NodeType.STATIC);
        newChild.staticChildren = edge.staticChildren;
        newChild.paramChild = edge.paramChild;
        newChild.wildcardChild = edge.wildcardChild;
        newChild.endData = edge.endData;

        // 3. Connect splitNode -> newChild
        splitNode.staticChildren.set(remainderEdge[0]!, newChild);

        // 4. Replace the old edge in the current node
        node.staticChildren.set(commonPart[0]!, splitNode);

        // 5. If we have token leftovers ("user" vs "users" -> "s" is handled, but what if token was "user/1"?)
        if (remainderToken && remainderToken.length > 0) {
          // Insert the rest of the token as a sibling
          // This logic actually simplifies by just recursing on the splitNode with updated tokens
          // We modify the token to be just the remainder and retry insertion on the splitNode
          tokens[0] = { ...token, value: remainderToken } as Token;
          this.insert(splitNode, tokens, data);
        } else {
          // If the token matches the split exactly, continue to next token
          this.insert(splitNode, remainingTokens, data);
        }
        return;
      }

      // CASE 3: Token is longer than Edge (Go deeper)
      // Edge: "user", Token: "users" -> Recurse on "user" with "s"
      if (
        commonPrefixLen === edge.part.length &&
        commonPrefixLen < (token?.value.length ?? -1)
      ) {
        tokens[0] = {
          ...token,
          value: token?.value.slice(commonPrefixLen),
        } as Token;
        this.insert(edge, tokens, data);
        return;
      }
    }

    // CASE 4: No Match (Create new branch)
    const newNode = new RadixNode<T>(token?.value, NodeType.STATIC);
    node.staticChildren.set(token?.value[0]!, newNode);
    this.insert(newNode, remainingTokens, data);
  }

  // --- HELPERS ---

  private getCommonPrefixLength(s1: string, s2: string): number {
    let i = 0;
    const len = Math.min(s1.length, s2.length);
    while (i < len && s1[i] === s2[i]) i++;
    return i;
  }

  /**
   * Scans string and identifies {params} and *
   * Returns: [{ type: STATIC, value: "api/" }, { type: PARAM, value: "id" }, ...]
   */
  private tokenize(pattern: string): Token[] {
    const tokens: Token[] = [];
    let buffer = "";
    let i = 0;

    while (i < pattern.length) {
      const char = pattern[i];

      if (char === "{") {
        if (buffer) tokens.push({ type: NodeType.STATIC, value: buffer });
        buffer = "";
        i++;
        // Capture param name
        while (i < pattern.length && pattern[i] !== "}") {
          buffer += pattern[i];
          i++;
        }
        tokens.push({ type: NodeType.PARAM, value: buffer });
        buffer = "";
        i++; // skip }
      } else if (char === "*") {
        if (buffer) tokens.push({ type: NodeType.STATIC, value: buffer });
        tokens.push({ type: NodeType.WILDCARD, value: "*" });
        buffer = "";
        i++;
      } else {
        buffer += char;
        i++;
      }
    }
    if (buffer) tokens.push({ type: NodeType.STATIC, value: buffer });
    return tokens;
  }

  // Faster than input.startsWith(prefix, index) in some V8 versions,
  // but standard startsWith is highly optimized now. We wrap it for clarity.
  private startsWith(input: string, prefix: string, index: number): boolean {
    // Manual loop can be faster for short strings to avoid V8 calling C++ boundary,
    // but for simplicity and reasonable speed, native is good.
    // Let's use the native optimization:
    return input.startsWith(prefix, index);
  }

  // Convert the linked list and data into the final result object
  // This ONLY happens on a successful match.
  private buildResult(
    dataList: T[],
    paramList: ParamLinkedList | null,
  ): MatchResult<T> {
    const params: Record<string, string> = {};
    let current = paramList;
    while (current) {
      params[current.key] = current.value;
      current = current.next;
    }

    // We flatten the results. If multiple patterns point to the same data,
    // we return one result entry per data item.
    // NOTE: Depending on your needs, you might want to return { data: T[], params }
    // but usually users want distinct match objects.
    // For this implementation, let's just return the first one or map them.
    // Let's mapping a single match result for the first data item to keep it simple,
    // or arguably we should return one MatchResult per data item.
    // Let's assume the user wants the first registered pattern's data for this path.
    return {
      params,
      data: dataList[0] as T, // Taking the first match for this specific path
    };
  }
}
