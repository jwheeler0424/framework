/**
 * Types
 * --------------------
 */

export enum NodeType {
  STATIC,
  PARAM, // {id}
  WILDCARD, // *
  WILDCARD_RECURSIVE, // **
}

export interface MachineConfig {
  /** The separator between segments. Default: "/" */
  delimiter?: string;
  /** Remove trailing delimiter from patterns/inputs? Default: true */
  ignoreTrailingDelimiter?: boolean;
  /** Treat "//" as "/"? Default: true */
  ignoreDuplicateDelimiter?: boolean;
  /** Max characters a parameter can hold. Default: 1024 */
  maxParamLength?: number;
  /** Case sensitive matching? Default: true */
  caseSensitive?: boolean;
  /** * Safety Valve: Maximum number of steps the matcher can take.
   * Prevents CPU lockup on extremely ambiguous patterns.
   * Default: 10,000
   */
  executionLimit?: number;
}

export interface MatchResult<T> {
  params: Record<string, string>;
  data: T;
}

// Internal linked list for zero-allocation param tracking
export interface ParamLinkedList {
  key: string;
  value: string;
  next: ParamLinkedList | null;
}

// Internal stack frame for traversal
export interface StackFrame<T> {
  node: any; // Typed as RadixNode<T> in implementation
  cursor: number;
  params: ParamLinkedList | null;
}

// The "Frozen" representation of a node
export interface SerializedNode<T> {
  part: string;
  type: NodeType;
  paramName: string | null;
  // Maps are converted to Objects for JSON: { "u": Node, "a": Node }
  staticChildren: Record<string, SerializedNode<T>>;
  paramChild: SerializedNode<T> | null;
  wildcardChild: SerializedNode<T> | null;
  wildcardRecursiveChild: SerializedNode<T> | null;
  endData: T[];
}

// The "Frozen" representation of the whole machine
export interface SerializedMachine<T> {
  config: MachineConfig;
  root: SerializedNode<T>;
}
