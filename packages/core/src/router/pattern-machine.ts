/**
 * Pattern Machine
 * --------------------
 */

import { RadixNode } from "./radix-node";
import type {
  MachineConfig,
  MatchResult,
  ParamLinkedList,
  SerializedMachine,
  SerializedNode,
  StackFrame,
} from "./types";
import { NodeType } from "./types";
import { normalizeInput, getCommonPrefixLength } from "./utils";

interface Token {
  type: NodeType;
  value: string;
}

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
      executionLimit: config.executionLimit ?? 10000,
    };
    this.root = new RadixNode<T>();
  }

  // --- PUBLIC API ---

  public add(pattern: string, data: T): void {
    const normalized = normalizeInput(pattern, this.config);
    const tokens = this.tokenize(normalized);
    this.insert(this.root, tokens, data);
  }

  public match(input: string): MatchResult<T>[] {
    const normalizedInput = normalizeInput(input, this.config);
    const results: MatchResult<T>[] = [];

    const stack: StackFrame<T>[] = [
      { node: this.root, cursor: 0, params: null },
    ];
    const delim = this.config.delimiter;

    // SAFETY VALVE
    let steps = 0;
    const maxSteps = this.config.executionLimit;

    while (stack.length > 0) {
      // 1. Check Budget
      steps++;
      if (steps > maxSteps) {
        console.warn(
          `[PatternMachine] Execution limit (${maxSteps}) exceeded for input: "${input}"`,
        );
        break; // Or throw error depending on preference
      }

      const { node, cursor, params } = stack.pop()!;

      // -------------------------------------------------
      // Success Check
      // -------------------------------------------------
      // If we are at the end, checks for data.
      // NOTE: ** can match the very end of a string too.
      if (cursor >= normalizedInput.length) {
        if (node.endData.length > 0) {
          results.push(this.buildResult(node.endData, params));
        }
        // If this is a recursive node, it might have matched "everything up to here",
        // so it is valid to stop here.
      }

      // -------------------------------------------------
      // Special Handling for Recursive Node (The "Self-Loop")
      // -------------------------------------------------
      if (node.type === NodeType.WILDCARD_RECURSIVE) {
        // Option 1: Consume a segment and recurse (Stay on this node)
        // Find next delimiter
        let nextDelim = normalizedInput.indexOf(delim, cursor);

        // If there is a delimiter, consume it and everything before it.
        // e.g. "a/b/c", cursor at "b", delim at after "b".
        // New cursor: "c"
        if (nextDelim !== -1) {
          // Push self back to stack, advanced to next segment
          stack.push({
            node: node,
            cursor: nextDelim + delim.length, // jump over delimiter
            params: params,
          });
        }
        // If no delimiter, but we have chars left (e.g. "file.png"), consume it all.
        else if (cursor < normalizedInput.length) {
          stack.push({
            node: node,
            cursor: normalizedInput.length,
            params: params,
          });
        }
      }

      // -------------------------------------------------
      // Standard Children Matching (The "Exit" Strategy)
      // -------------------------------------------------
      // Whether we are a Static node, or a Recursive node trying to "stop" and match a child:

      const char = normalizedInput[cursor]; // Undefined if at end, harmless

      // 1. Static Children
      const staticChild = node.staticChildren.get(char);
      if (staticChild) {
        if (normalizedInput.startsWith(staticChild.part, cursor)) {
          stack.push({
            node: staticChild,
            cursor: cursor + staticChild.part.length,
            params: params,
          });
        }
      }

      // 2. Wildcard Child (*)
      if (node.wildcardChild) {
        let nextDelim = normalizedInput.indexOf(delim, cursor);
        if (nextDelim === -1) nextDelim = normalizedInput.length;
        stack.push({
          node: node.wildcardChild,
          cursor: nextDelim,
          params: params,
        });
      }

      // 3. Param Child ({id})
      if (node.paramChild) {
        let nextDelim = normalizedInput.indexOf(delim, cursor);
        if (nextDelim === -1) nextDelim = normalizedInput.length;
        const valLen = nextDelim - cursor;
        if (valLen <= this.config.maxParamLength) {
          stack.push({
            node: node.paramChild,
            cursor: nextDelim,
            params: {
              key: node.paramChild.paramName!,
              value: normalizedInput.slice(cursor, nextDelim),
              next: params,
            },
          });
        }
      }

      // 4. Recursive Child (**)
      // This is for transitioning FROM a normal node TO a recursive node
      if (node.wildcardRecursiveChild) {
        stack.push({
          node: node.wildcardRecursiveChild,
          cursor: cursor, // Do not consume anything yet. Let the Rec node handle consumption.
          params: params,
        });
      }
    }

    return results;
  }

  // --- COMPILER (INSERTION) ---

  private insert(node: RadixNode<T>, tokens: Token[], data: T): void {
    if (tokens.length === 0) {
      node.addResult(data);
      return;
    }

    const token = tokens[0];
    const remainingTokens = tokens.slice(1);

    if (!token) {
      node.addResult(data);
      return;
    }

    const tokenValue = token.value[0] ?? "";

    // Wildcard Recursive: Dedicated Slot
    if (token.type === NodeType.WILDCARD_RECURSIVE) {
      if (!node.wildcardRecursiveChild) {
        node.wildcardRecursiveChild = new RadixNode<T>(
          "",
          NodeType.WILDCARD_RECURSIVE,
        );
      }
      this.insert(node.wildcardRecursiveChild, remainingTokens, data);
      return;
    }

    // Param/Wildcard: These occupy their own dedicated slots
    if (token.type === NodeType.PARAM) {
      if (!node.paramChild) {
        node.paramChild = new RadixNode<T>("", NodeType.PARAM, token.value);
      }
      this.insert(node.paramChild, remainingTokens, data);
      return;
    }

    if (token.type === NodeType.WILDCARD) {
      if (!node.wildcardChild) {
        node.wildcardChild = new RadixNode<T>("", NodeType.WILDCARD);
      }
      this.insert(node.wildcardChild, remainingTokens, data);
      return;
    }

    // Static: Radix Compression Logic
    const edge = node.staticChildren.get(tokenValue);

    if (edge) {
      const commonLen = getCommonPrefixLength(edge.part, token.value);

      // Case 1: Full Match (Go deeper)
      if (commonLen === edge.part.length && commonLen === token.value.length) {
        this.insert(edge, remainingTokens, data);
        return;
      }

      // Case 2: Partial Match -> Split the Edge
      if (commonLen < edge.part.length) {
        const commonPart = edge.part.slice(0, commonLen);
        const remainderEdge = edge.part.slice(commonLen);
        const remainderToken = token.value.slice(commonLen);

        const splitNode = new RadixNode<T>(commonPart, NodeType.STATIC);
        const newChild = new RadixNode<T>(remainderEdge, NodeType.STATIC);

        // Move existing children to newChild
        newChild.staticChildren = edge.staticChildren;
        newChild.paramChild = edge.paramChild;
        newChild.wildcardChild = edge.wildcardChild;
        newChild.endData = edge.endData;

        const remainderValue = remainderEdge[0];
        const commonValue = commonPart[0];
        if (!remainderValue) throw new Error("Remainder edge cannot be empty");
        splitNode.staticChildren.set(remainderValue, newChild);
        if (!commonValue) throw new Error("Common part cannot be empty");
        node.staticChildren.set(commonValue, splitNode);

        if (remainderToken.length > 0) {
          tokens[0] = { ...token, value: remainderToken };
          this.insert(splitNode, tokens, data);
        } else {
          this.insert(splitNode, remainingTokens, data);
        }
        return;
      }

      // Case 3: Token is longer than Edge (Go deeper)
      if (commonLen === edge.part.length && commonLen < token.value.length) {
        tokens[0] = { ...token, value: token.value.slice(commonLen) };
        this.insert(edge, tokens, data);
        return;
      }
    }

    // Case 4: No Match -> New Branch
    if (!tokenValue) throw new Error("Token value cannot be empty");
    const newNode = new RadixNode<T>(token.value, NodeType.STATIC);
    node.staticChildren.set(tokenValue, newNode);
    this.insert(newNode, remainingTokens, data);
  }

  // --- SERIALIZATION (The Freeze) ---

  public toJSON(): SerializedMachine<T> {
    return {
      config: this.config,
      root: this.serializeNode(this.root),
    };
  }

  private serializeNode(node: RadixNode<T>): SerializedNode<T> {
    // Convert Map<string, Node> -> Record<string, SerializedNode>
    const staticChildrenObj: Record<string, SerializedNode<T>> = {};
    for (const [key, child] of node.staticChildren.entries()) {
      staticChildrenObj[key] = this.serializeNode(child);
    }

    return {
      part: node.part,
      type: node.type,
      paramName: node.paramName,
      staticChildren: staticChildrenObj,
      paramChild: node.paramChild ? this.serializeNode(node.paramChild) : null,
      wildcardChild: node.wildcardChild
        ? this.serializeNode(node.wildcardChild)
        : null,
      wildcardRecursiveChild: node.wildcardRecursiveChild
        ? this.serializeNode(node.wildcardRecursiveChild)
        : null,
      endData: node.endData,
    };
  }

  // --- HYDRATION (The Thaw) ---

  public static fromJSON<T>(json: SerializedMachine<T>): PatternMachine<T> {
    // 1. Create a new blank machine with the restored config
    const machine = new PatternMachine<T>(json.config);

    // 2. Recursively rebuild the node structure
    machine.root = PatternMachine.deserializeNode(json.root);

    return machine;
  }

  private static deserializeNode<T>(data: SerializedNode<T>): RadixNode<T> {
    // Re-instantiate the class to ensure proper object shape and methods
    const node = new RadixNode<T>(data.part, data.type, data.paramName);

    // Restore Data
    node.endData = data.endData;

    // Restore Static Children (Object -> Map)
    for (const key in data.staticChildren) {
      const childData = data.staticChildren[key];
      if (childData)
        node.staticChildren.set(key, PatternMachine.deserializeNode(childData));
    }

    // Restore Dynamic Children
    if (data.paramChild) {
      node.paramChild = PatternMachine.deserializeNode(data.paramChild);
    }
    if (data.wildcardChild) {
      node.wildcardChild = PatternMachine.deserializeNode(data.wildcardChild);
    }
    if (data.wildcardRecursiveChild) {
      node.wildcardRecursiveChild = PatternMachine.deserializeNode(
        data.wildcardRecursiveChild,
      );
    }

    return node;
  }

  // --- HELPERS ---

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
        while (i < pattern.length && pattern[i] !== "}") {
          buffer += pattern[i];
          i++;
        }
        tokens.push({ type: NodeType.PARAM, value: buffer });
        buffer = "";
        i++;
      } else if (char === "*") {
        if (buffer) tokens.push({ type: NodeType.STATIC, value: buffer });
        buffer = "";

        // Check for double wildcard
        if (i + 1 < pattern.length && pattern[i + 1] === "*") {
          tokens.push({ type: NodeType.WILDCARD_RECURSIVE, value: "**" });
          i += 2;
        } else {
          tokens.push({ type: NodeType.WILDCARD, value: "*" });
          i++;
        }
      } else {
        buffer += char;
        i++;
      }
    }
    if (buffer) tokens.push({ type: NodeType.STATIC, value: buffer });
    return tokens;
  }

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
    // Returning the first data match for this path
    return { params, data: dataList[0] as T };
  }
}
