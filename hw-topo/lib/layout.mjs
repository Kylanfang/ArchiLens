// Deterministic layered layout for the topology SVG.
//
// Nodes are placed once each. Primary parent = the first instance edge that
// reaches a child (spec order); all other instance edges render as dashed
// cross edges. Vendor primitives / unresolved types are forced into the
// bottom band so the design reads top-down: tops -> modules -> primitives.

const NODE_W = 200;
const NODE_H = 62;
const GAP_X = 44;
const LEVEL_H = 132;
const MARGIN = 48;
const TITLE_H = 76;
const BAND_GAP = 64; // extra gap above the forced bottom band

export function layoutTopology(spec) {
  const nodes = new Map(spec.nodes.map((n) => [n.id, { ...n }]));
  const edges = (spec.instances || []).map((e) => ({ ...e }));

  // children map (by primary reach order), cross edges
  const childrenOf = new Map();
  const placedByEdge = new Set(); // child ids already attached to a primary parent
  const primaryEdges = [];
  const crossEdges = [];
  for (const edge of edges) {
    if (!nodes.has(edge.parent) || !nodes.has(edge.child) || edge.parent === edge.child) {
      crossEdges.push({ ...edge, __unattached: !nodes.has(edge.parent) || !nodes.has(edge.child) });
      continue;
    }
    if (!placedByEdge.has(edge.child)) {
      placedByEdge.add(edge.child);
      primaryEdges.push(edge);
      if (!childrenOf.has(edge.parent)) childrenOf.set(edge.parent, []);
      childrenOf.get(edge.parent).push(edge.child);
    } else {
      crossEdges.push(edge);
    }
  }

  // Depth via BFS from roots.
  const depth = new Map();
  const roots = [...nodes.keys()].filter((id) => !placedByEdge.has(id));
  const queue = [...roots];
  for (const r of roots) depth.set(r, 0);
  while (queue.length) {
    const cur = queue.shift();
    for (const child of childrenOf.get(cur) || []) {
      if (!depth.has(child)) {
        depth.set(child, depth.get(cur) + 1);
        queue.push(child);
      }
    }
  }
  // Cycle/stray fallback: anything unreached sinks to depth 1.
  let maxDepth = 0;
  for (const id of nodes.keys()) {
    if (!depth.has(id)) depth.set(id, 1);
    maxDepth = Math.max(maxDepth, depth.get(id));
  }

  // Force primitives/unknown to the bottom band.
  const bandDepth = maxDepth + 1;
  for (const node of nodes.values()) {
    if (node.kind === 'primitive' || node.kind === 'unknown') depth.set(node.id, bandDepth);
  }
  maxDepth = bandDepth;

  // Group children by depth level (preserving spec order).
  const levels = [];
  for (let d = 0; d <= maxDepth; d++) levels.push([]);
  for (const node of spec.nodes) {
    if (!nodes.has(node.id)) continue;
    levels[depth.get(node.id)].push(node.id);
  }

  // Subtree sizes drive ordering: bigger subtrees to the left of each level.
  // Primary edges are *almost* a forest — a↔b mutual instantiation makes
  // both edges primary — so every walk carries a cycle guard.
  const subtreeSize = new Map();
  const sizing = new Set();
  function sizeOf(id) {
    if (subtreeSize.has(id)) return subtreeSize.get(id);
    if (sizing.has(id)) return 0; // back-edge: contributes nothing extra
    sizing.add(id);
    let size = 1;
    for (const child of childrenOf.get(id) || []) size += sizeOf(child);
    sizing.delete(id);
    subtreeSize.set(id, size);
    return size;
  }
  for (const id of nodes.keys()) sizeOf(id);
  for (const level of levels) {
    level.sort((a, b) => subtreeSize.get(b) - subtreeSize.get(a) || a.localeCompare(b));
  }

  // Leaf packing: leaves take sequential slots; parents center over children.
  const slotOf = new Map();
  let nextSlot = 0;
  const slotting = new Set();
  function assign(id) {
    if (slotOf.has(id) || slotting.has(id)) return; // assigned or back-edge
    slotting.add(id);
    const kids = childrenOf.get(id) || [];
    if (kids.length === 0) {
      slotOf.set(id, nextSlot++);
    } else {
      for (const child of kids) assign(child);
      const first = slotOf.get(kids[0]);
      const last = slotOf.get(kids[kids.length - 1]);
      slotOf.set(id, (first + last) / 2);
    }
    slotting.delete(id);
  }
  const assignRoots = roots.length ? roots : spec.nodes.filter((n) => nodes.has(n.id)).slice(0, 1).map((n) => n.id);
  for (const root of assignRoots) assign(root);
  for (const id of nodes.keys()) if (!slotOf.has(id)) slotOf.set(id, nextSlot++);

  // Position: x by slot (level-local order keeps slots compact), y by depth.
  // To avoid long horizontal stretches, re-slot per level from left to right.
  const position = new Map();
  let y = MARGIN + TITLE_H;
  for (let d = 0; d <= maxDepth; d++) {
    const level = levels[d];
    const gap = d === bandDepth ? BAND_GAP : LEVEL_H;
    if (d > 0) y += gap;
    level.forEach((id, i) => {
      position.set(id, { x: MARGIN + i * (NODE_W + GAP_X), y });
    });
  }

  const maxSlotX = Math.max(0, ...[...position.values()].map((p) => p.x)) + NODE_W + MARGIN;
  const width = Math.max(960, maxSlotX);
  const height = y + NODE_H + MARGIN + 24;

  // Group bounding boxes (before node boxes are drawn).
  const groups = (spec.groups || []).map((group) => {
    const boxes = (group.members || [])
      .filter((m) => position.has(m))
      .map((m) => position.get(m));
    if (!boxes.length) return null;
    const x1 = Math.min(...boxes.map((b) => b.x)) - 18;
    const y1 = Math.min(...boxes.map((b) => b.y)) - 30;
    const x2 = Math.max(...boxes.map((b) => b.x + NODE_W)) + 18;
    const y2 = Math.max(...boxes.map((b) => b.y + NODE_H)) + 18;
    return { ...group, x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }).filter(Boolean);

  return {
    nodes: spec.nodes
      .filter((n) => nodes.has(n.id))
      .map((n) => ({ ...n, x: position.get(n.id).x, y: position.get(n.id).y })),
    primaryEdges,
    crossEdges,
    connections: spec.connections || [],
    groups,
    geometry: { NODE_W, NODE_H, LEVEL_H, MARGIN, bandDepth },
    width,
    height,
    slotOf,
  };
}

export { NODE_W, NODE_H, GAP_X, LEVEL_H, MARGIN, TITLE_H };
