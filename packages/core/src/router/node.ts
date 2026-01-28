import { NodeType } from "./types";

// The Optimized Node
// --------------------
// We use a class to ensure V8 creates a consistent Hidden Class.
// All properties are initialized in the constructor.
export class RadixNode<T> {
  // The string fragment this node represents (e.g., "api/v1/")
  public part: string;

  // Type of this specific node segment
  public type: NodeType;

  // Name of the parameter if type is PARAM (e.g., "userId")
  public paramName: string | null;

  // Buckets for children. Separating them avoids iterating mixed lists.
  // Using Map for static children gives us O(1) access.
  public staticChildren: Map<string, RadixNode<T>>;
  public paramChild: RadixNode<T> | null;
  public wildcardChild: RadixNode<T> | null;

  // If this node marks the end of a pattern, we store the payload here.
  // An array because multiple patterns might end at the same node.
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
    this.endData = [];
  }

  // Helper to keep code clean: Add data to this node
  addResult(data: T) {
    this.endData.push(data);
  }
}
