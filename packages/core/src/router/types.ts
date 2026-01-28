// Types
// --------------------

// Represents the type of segment we are dealing with
export enum NodeType {
  STATIC,
  PARAM, // {id}
  WILDCARD, // *
}

// The bucket to hold the user's data when a match is found
export interface Match<T> {
  params: Record<string, string>;
  data: T;
}

// Internal Token Interface
export interface Token {
  type: NodeType;
  value: string;
}
