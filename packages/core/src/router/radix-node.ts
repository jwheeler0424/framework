/**
 * Radix Node
 * --------------------
 */

import { NodeType } from "./types";

export class RadixNode<T> {
  public part: string;
  public type: NodeType;
  public paramName: string | null;

  // Optimization: Map is slightly slower than Object for small sets,
  // but safer for arbitrary string keys.
  public staticChildren: Map<string, RadixNode<T>>;
  public paramChild: RadixNode<T> | null;
  public wildcardChild: RadixNode<T> | null;
  public wildcardRecursiveChild: RadixNode<T> | null;

  public endData: T[];

  constructor(
    part: string = "",
    type: NodeType = NodeType.STATIC,
    paramName: string | null = null,
  ) {
    this.part = part;
    this.type = type;
    this.paramName = paramName;
    this.staticChildren = new Map();
    this.paramChild = null;
    this.wildcardChild = null;
    this.wildcardRecursiveChild = null;
    this.endData = [];
  }

  addResult(data: T) {
    this.endData.push(data);
  }

  get isMergeable(): boolean {
    // A node can be merged if:
    // 1. It is a STATIC node
    // 2. It has exactly ONE static child
    // 3. It has NO param, wildcard, or recursive children
    // 4. It is NOT an endpoint (no endData)
    return (
      this.type === NodeType.STATIC &&
      this.staticChildren.size === 1 &&
      this.paramChild === null &&
      this.wildcardChild === null &&
      this.wildcardRecursiveChild === null &&
      this.endData.length === 0
    );
  }
}
