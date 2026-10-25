// Pure operations on a tab's split tree. A tree is either a leaf (one pane) or a
// split whose children are laid out in a row (side by side) or a column (stacked).
import { uid } from "../lib/util";

export type Id = string;
export type SplitDir = "row" | "col";
export type Side = "left" | "right" | "top" | "bottom";

export interface LayoutLeaf {
  kind: "leaf";
  pane: Id;
}

export interface LayoutSplit {
  kind: "split";
  id: Id;
  dir: SplitDir;
  children: LayoutNode[];
  /** Fractions that sum to 1, one per child. */
  sizes: number[];
}

export type LayoutNode = LayoutLeaf | LayoutSplit;

export const leaf = (pane: Id): LayoutLeaf => ({ kind: "leaf", pane });

export function leaves(node: LayoutNode | null): Id[] {
  if (!node) return [];
  if (node.kind === "leaf") return [node.pane];
  return node.children.flatMap(leaves);
}

export function contains(node: LayoutNode | null, pane: Id): boolean {
  return leaves(node).includes(pane);
}

function normSizes(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return sizes.map((s) => s / total);
}

/** Collapse single-child splits, merge nested splits of the same direction, fix sizes. */
export function normalize(node: LayoutNode): LayoutNode {
  if (node.kind === "leaf") return node;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const n = normalize(c);
    const s = node.sizes[i] ?? 1 / node.children.length;
    if (n.kind === "split" && n.dir === node.dir) {
      n.children.forEach((cc, j) => {
        children.push(cc);
        sizes.push(s * n.sizes[j]);
      });
    } else {
      children.push(n);
      sizes.push(s);
    }
  });
  if (children.length === 1) return children[0];
  return { ...node, children, sizes: normSizes(sizes) };
}

export function removePane(node: LayoutNode | null, pane: Id): LayoutNode | null {
  if (!node) return null;
  if (node.kind === "leaf") return node.pane === pane ? null : node;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const r = removePane(c, pane);
    if (r) {
      children.push(r);
      sizes.push(node.sizes[i]);
    }
  });
  if (children.length === 0) return null;
  return normalize({ ...node, children, sizes: normSizes(sizes) });
}

const axisOf = (side: Side): SplitDir => (side === "left" || side === "right" ? "row" : "col");
const isBefore = (side: Side) => side === "left" || side === "top";

/** Put `newPane` next to `target` on the given side (splitting the target's space). */
export function insertPane(root: LayoutNode | null, target: Id | null, newPane: Id, side: Side = "right"): LayoutNode {
  if (!root) return leaf(newPane);
  if (!target || !contains(root, target)) return insertOuter(root, newPane, side);
  const axis = axisOf(side);
  const before = isBefore(side);

  const rec = (node: LayoutNode): LayoutNode => {
    if (node.kind === "leaf") {
      if (node.pane !== target) return node;
      const n = leaf(newPane);
      return { kind: "split", id: uid(), dir: axis, children: before ? [n, node] : [node, n], sizes: [0.5, 0.5] };
    }
    const idx = node.children.findIndex((c) => c.kind === "leaf" && c.pane === target);
    if (idx >= 0 && node.dir === axis) {
      const children = [...node.children];
      const sizes = [...node.sizes];
      const half = sizes[idx] / 2;
      sizes[idx] = half;
      const at = before ? idx : idx + 1;
      children.splice(at, 0, leaf(newPane));
      sizes.splice(at, 0, half);
      return { ...node, children, sizes };
    }
    return { ...node, children: node.children.map(rec) };
  };
  return normalize(rec(root));
}

/** Insert at the edge of the whole tab, spanning its full height/width. */
export function insertOuter(root: LayoutNode | null, newPane: Id, side: Side): LayoutNode {
  if (!root) return leaf(newPane);
  const axis = axisOf(side);
  const before = isBefore(side);
  if (root.kind === "split" && root.dir === axis) {
    const n = root.children.length + 1;
    const sizes = root.sizes.map((s) => (s * (n - 1)) / n);
    const children = before ? [leaf(newPane), ...root.children] : [...root.children, leaf(newPane)];
    return normalize({ ...root, children, sizes: before ? [1 / n, ...sizes] : [...sizes, 1 / n] });
  }
  const n = leaf(newPane);
  return normalize({
    kind: "split",
    id: uid(),
    dir: axis,
    children: before ? [n, root] : [root, n],
    sizes: before ? [0.35, 0.65] : [0.65, 0.35],
  });
}

/** Add a pane without a specific target: split the given pane along its longer axis. */
export function autoInsert(root: LayoutNode | null, focused: Id | null, newPane: Id, wide = true): LayoutNode {
  return insertPane(root, focused ?? leaves(root)[0] ?? null, newPane, wide ? "right" : "bottom");
}

export function swapPanes(node: LayoutNode, a: Id, b: Id): LayoutNode {
  if (node.kind === "leaf") {
    if (node.pane === a) return leaf(b);
    if (node.pane === b) return leaf(a);
    return node;
  }
  return { ...node, children: node.children.map((c) => swapPanes(c, a, b)) };
}

export function replacePane(node: LayoutNode, oldId: Id, newId: Id): LayoutNode {
  if (node.kind === "leaf") return node.pane === oldId ? leaf(newId) : node;
  return { ...node, children: node.children.map((c) => replacePane(c, oldId, newId)) };
}

export function setSizes(node: LayoutNode, splitId: Id, sizes: number[]): LayoutNode {
  if (node.kind === "leaf") return node;
  if (node.id === splitId && sizes.length === node.children.length) return { ...node, sizes: normSizes(sizes) };
  return { ...node, children: node.children.map((c) => setSizes(c, splitId, sizes)) };
}

/** Reset every split in the tree to equal sizes. */
export function equalize(node: LayoutNode): LayoutNode {
  if (node.kind === "leaf") return node;
  return { ...node, sizes: node.children.map(() => 1 / node.children.length), children: node.children.map(equalize) };
}

/** Deep-copy a tree, mapping pane ids (used when duplicating tabs). */
export function mapPanes(node: LayoutNode, fn: (id: Id) => Id): LayoutNode {
  if (node.kind === "leaf") return leaf(fn(node.pane));
  return { ...node, id: uid(), children: node.children.map((c) => mapPanes(c, fn)) };
}
