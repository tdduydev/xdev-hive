import { useCallback, useMemo } from "react";
import type { Node, NodeChange, OnNodesChange } from "@xyflow/react";

/** Keep React Flow's measurements when polling rebuilds controlled nodes. */
export function useMeasuredNodes<N extends Node = Node>(onChange?: OnNodesChange<N>, scopeKey = "") {
  // Scope/layer changes can reuse an id for a different card, so measurements belong to one canvas.
  const measured = useMemo(() => new Map<string, NonNullable<Node["measured"]>>(), [scopeKey]);
  const restoreMeasured = useCallback((nodes: N[]): N[] => {
    const ids = new Set(nodes.map((node) => node.id));
    for (const id of measured.keys()) if (!ids.has(id)) measured.delete(id);
    return nodes.map((node) => {
      const size = node.measured ?? measured.get(node.id);
      return size ? { ...node, measured: { ...size } } : node;
    });
  }, [measured]);
  const onNodesChange = useCallback((changes: NodeChange<N>[]) => {
    for (const change of changes) {
      if (change.type === "dimensions" && change.dimensions) measured.set(change.id, { ...change.dimensions });
      if (change.type === "remove") measured.delete(change.id);
    }
    // Position changes still reach the caller, including agent tasks dragged onto a profile.
    onChange?.(changes);
  }, [measured, onChange]);
  return { restoreMeasured, onNodesChange };
}
