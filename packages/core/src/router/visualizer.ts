/**
 * Visualizer
 * --------------------
 */

import { PatternMachine } from "./pattern-machine";
import { RadixNode } from "./radix-node";
import { NodeType } from "./types";

// Constants for tree drawing
const SYMBOLS = {
  branch: "├── ",
  lastBranch: "└── ",
  vertical: "│   ",
  space: "    ",
};

export function printTree<T>(
  machine: PatternMachine<T> | RadixNode<T>,
): string {
  // Allow passing either the machine instance or a raw root node
  const root =
    machine instanceof PatternMachine
      ? // @ts-ignore - Accessing private root for visualization purposes
        machine.root
      : machine;

  return traverse(root, "", true);
}

function traverse<T>(
  node: RadixNode<T>,
  prefix: string,
  isTail: boolean,
): string {
  let output = "";

  // 1. Render the current node's label
  const label = getNodeLabel(node);

  // Don't print the root connector for the very first node if it's empty
  if (node.part === "" && node.type === NodeType.STATIC && prefix === "") {
    output += `ROOT\n`;
  } else {
    // Determine the connector symbol based on whether this is the last sibling
    const connector = isTail ? SYMBOLS.lastBranch : SYMBOLS.branch;
    output += `${prefix}${connector}${label}\n`;
  }

  // 2. Prepare the prefix for children
  // If we were the last child, our children don't need a vertical bar from us
  const childPrefix = prefix + (isTail ? SYMBOLS.space : SYMBOLS.vertical);

  // 3. Collect all children to iterate over them safely
  const children: { node: RadixNode<T>; type: string }[] = [];

  // Static Children
  // Sort them alphabetically for consistent output
  const sortedKeys = Array.from(node.staticChildren.keys()).sort();
  for (const key of sortedKeys) {
    children.push({ node: node.staticChildren.get(key)!, type: "STATIC" });
  }

  // Dynamic Children
  if (node.paramChild) children.push({ node: node.paramChild, type: "PARAM" });
  if (node.wildcardChild)
    children.push({ node: node.wildcardChild, type: "WILDCARD" });
  if (node.wildcardRecursiveChild)
    children.push({ node: node.wildcardRecursiveChild, type: "RECURSIVE" });

  // 4. Recurse
  for (let i = 0; i < children.length; i++) {
    const isLastChild = i === children.length - 1;
    if (children[i] && children[i]?.node)
      output += traverse(children[i]!.node, childPrefix, isLastChild);
  }

  return output;
}

function getNodeLabel<T>(node: RadixNode<T>): string {
  let text = "";

  switch (node.type) {
    case NodeType.STATIC:
      text = node.part || "(root)";
      break;
    case NodeType.PARAM:
      text = `{${node.paramName}}`;
      break;
    case NodeType.WILDCARD:
      text = "*";
      break;
    case NodeType.WILDCARD_RECURSIVE:
      text = "** (Recursive)";
      break;
  }

  // Append data indicator if this node is a match endpoint
  if (node.endData.length > 0) {
    text += `  ➔ [MATCH: ${node.endData.length}]`;
    // You could JSON.stringify(node.endData) if concise
  }

  return text;
}
