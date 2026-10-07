import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { Node, NodeChange, OnNodesChange } from "@xyflow/react";
import { useMeasuredNodes } from "#ui/lib/useMeasuredNodes.ts";

// Mount the hook in React; its callbacks share the same cache across simulated poll rebuilds.
function mount(onChange?: OnNodesChange) {
  let result!: ReturnType<typeof useMeasuredNodes>;
  function Probe() { result = useMeasuredNodes(onChange); return null; }
  renderToString(createElement(Probe));
  return result;
}
const node = (id = "service:payment"): Node => ({ id, type: "service", position: { x: 0, y: 0 }, data: {} });

it("keeps measured dimensions on fresh node objects after repeated polls", () => {
  const hook = mount();
  assert.equal(hook.restoreMeasured([node()])[0]!.measured, undefined);
  hook.onNodesChange([{ id: node().id, type: "dimensions", dimensions: { width: 260, height: 140 } }]);
  for (let poll = 0; poll < 3; poll++) {
    const rebuilt = node();
    const restored = hook.restoreMeasured([rebuilt])[0]!;
    assert.deepEqual(restored.measured, { width: 260, height: 140 });
    assert.equal(rebuilt.measured, undefined, "does not mutate the builder's node");
    restored.measured!.width = 999;
  }
  hook.onNodesChange([{ id: node().id, type: "dimensions", dimensions: { width: 260, height: 180 } }]);
  assert.deepEqual(hook.restoreMeasured([node()])[0]!.measured, { width: 260, height: 180 });
});

it("forwards position and dimensions changes to the existing drag handler", () => {
  let received: NodeChange[] | undefined;
  const hook = mount((changes) => { received = changes; });
  const changes: NodeChange[] = [
    { id: node().id, type: "position", position: { x: 100, y: 200 }, dragging: true },
    { id: node().id, type: "dimensions", dimensions: { width: 260, height: 140 } },
  ];
  hook.onNodesChange(changes);
  assert.equal(received, changes);
  const rebuilt = { ...node(), position: { x: 100, y: 200 } };
  assert.deepEqual(hook.restoreMeasured([rebuilt])[0]!.position, rebuilt.position);
});

it("respects explicit fixed sizes and forgets nodes removed or absent from the canvas", () => {
  const hook = mount();
  const measure = () => hook.onNodesChange([{ id: node().id, type: "dimensions", dimensions: { width: 260, height: 140 } }]);
  measure();
  assert.deepEqual(hook.restoreMeasured([{ ...node(), measured: { width: 300, height: 200 } }])[0]!.measured, { width: 300, height: 200 });
  hook.restoreMeasured([]);
  assert.equal(hook.restoreMeasured([node()])[0]!.measured, undefined);
  measure();
  hook.onNodesChange([{ id: node().id, type: "remove" }]);
  assert.equal(hook.restoreMeasured([node()])[0]!.measured, undefined);
  measure();
  assert.equal(mount().restoreMeasured([node()])[0]!.measured, undefined, "separate canvases do not share dimensions");
});
