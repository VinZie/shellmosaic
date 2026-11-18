import { describe, expect, it } from "vitest";
import {
  autoInsert,
  contains,
  equalize,
  insertOuter,
  insertPane,
  leaf,
  leaves,
  mapPanes,
  normalize,
  removePane,
  replacePane,
  setSizes,
  swapPanes,
  type LayoutNode,
  type LayoutSplit,
} from "./layout";

const split = (dir: "row" | "col", children: LayoutNode[], sizes?: number[], id = "s"): LayoutSplit => ({
  kind: "split",
  id,
  dir,
  children,
  sizes: sizes ?? children.map(() => 1 / children.length),
});

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Every split has one size per child, sizes sum to 1 and no split has a single child. */
function expectValid(node: LayoutNode | null) {
  if (!node || node.kind === "leaf") return;
  expect(node.children.length).toBeGreaterThan(1);
  expect(node.sizes).toHaveLength(node.children.length);
  expect(sum(node.sizes)).toBeCloseTo(1);
  node.children.forEach(expectValid);
}

describe("leaves / contains", () => {
  it("lists panes in order", () => {
    const tree = split("row", [leaf("a"), split("col", [leaf("b"), leaf("c")])]);
    expect(leaves(tree)).toEqual(["a", "b", "c"]);
    expect(leaves(null)).toEqual([]);
    expect(contains(tree, "c")).toBe(true);
    expect(contains(tree, "z")).toBe(false);
  });
});

describe("normalize", () => {
  it("collapses single-child splits", () => {
    expect(normalize(split("row", [leaf("a")]))).toEqual(leaf("a"));
  });

  it("merges nested splits of the same direction and keeps proportions", () => {
    const tree = split("row", [leaf("a"), split("row", [leaf("b"), leaf("c")], [0.5, 0.5], "inner")], [0.5, 0.5]);
    const out = normalize(tree) as LayoutSplit;
    expect(leaves(out)).toEqual(["a", "b", "c"]);
    expect(out.children.every((c) => c.kind === "leaf")).toBe(true);
    expect(out.sizes).toEqual([0.5, 0.25, 0.25]);
  });

  it("rescales sizes that don't sum to 1", () => {
    const out = normalize(split("col", [leaf("a"), leaf("b")], [2, 6])) as LayoutSplit;
    expect(out.sizes).toEqual([0.25, 0.75]);
  });
});

describe("insertPane", () => {
  it("creates a leaf in an empty tab", () => {
    expect(insertPane(null, null, "a")).toEqual(leaf("a"));
  });

  it("splits a leaf on the requested side", () => {
    const right = insertPane(leaf("a"), "a", "b", "right") as LayoutSplit;
    expect(right.dir).toBe("row");
    expect(leaves(right)).toEqual(["a", "b"]);
    const top = insertPane(leaf("a"), "a", "b", "top") as LayoutSplit;
    expect(top.dir).toBe("col");
    expect(leaves(top)).toEqual(["b", "a"]);
  });

  it("shares the target's space within a same-direction split", () => {
    const tree = split("row", [leaf("a"), leaf("b")], [0.5, 0.5]);
    const out = insertPane(tree, "b", "c", "right") as LayoutSplit;
    expect(leaves(out)).toEqual(["a", "b", "c"]);
    expect(out.sizes).toEqual([0.5, 0.25, 0.25]);
  });

  it("nests a split across the other axis", () => {
    const tree = split("row", [leaf("a"), leaf("b")]);
    const out = insertPane(tree, "b", "c", "bottom");
    expect(leaves(out)).toEqual(["a", "b", "c"]);
    expectValid(out);
    const inner = (out as LayoutSplit).children[1] as LayoutSplit;
    expect(inner.dir).toBe("col");
  });

  it("falls back to the outer edge for an unknown target", () => {
    const out = insertPane(leaf("a"), "missing", "b", "left");
    expect(leaves(out)).toEqual(["b", "a"]);
  });
});

describe("insertOuter", () => {
  it("adds a full-height pane along the root's axis", () => {
    const tree = split("row", [leaf("a"), leaf("b")]);
    const out = insertOuter(tree, "c", "right") as LayoutSplit;
    expect(leaves(out)).toEqual(["a", "b", "c"]);
    expect(out.sizes[2]).toBeCloseTo(1 / 3);
    expectValid(out);
  });

  it("wraps the root when the axis differs", () => {
    const out = insertOuter(split("row", [leaf("a"), leaf("b")]), "c", "bottom") as LayoutSplit;
    expect(out.dir).toBe("col");
    expect(out.sizes).toEqual([0.65, 0.35]);
    expect(leaves(out)).toEqual(["a", "b", "c"]);
  });
});

describe("autoInsert", () => {
  it("splits the focused pane, or the first pane when none is focused", () => {
    const tree = split("row", [leaf("a"), leaf("b")]);
    expect(leaves(autoInsert(tree, "a", "c"))).toEqual(["a", "c", "b"]);
    expect(leaves(autoInsert(tree, null, "c", false))).toEqual(["a", "c", "b"]);
  });
});

describe("removePane", () => {
  it("removes and collapses", () => {
    const tree = split("row", [leaf("a"), split("col", [leaf("b"), leaf("c")])]);
    const out = removePane(tree, "c");
    expect(leaves(out)).toEqual(["a", "b"]);
    expectValid(out);
    expect(removePane(leaf("a"), "a")).toBeNull();
    expect(removePane(null, "a")).toBeNull();
  });

  it("gives the removed pane's space to its siblings", () => {
    const out = removePane(split("row", [leaf("a"), leaf("b"), leaf("c")], [0.5, 0.25, 0.25]), "a") as LayoutSplit;
    expect(out.sizes).toEqual([0.5, 0.5]);
  });

  it("stays valid through many inserts and removals", () => {
    let tree: LayoutNode | null = null;
    const sides = ["left", "right", "top", "bottom"] as const;
    for (let i = 0; i < 20; i++) {
      const panes = leaves(tree);
      tree = insertPane(tree, panes[i % Math.max(panes.length, 1)] ?? null, `p${i}`, sides[i % 4]);
      expectValid(tree);
    }
    for (let i = 0; i < 20; i += 2) {
      tree = removePane(tree, `p${i}`);
      expectValid(tree);
    }
    expect(leaves(tree)).toHaveLength(10);
  });
});

describe("other operations", () => {
  const tree = split(
    "row",
    [leaf("a"), split("col", [leaf("b"), leaf("c")], [0.3, 0.7], "inner")],
    [0.4, 0.6],
    "outer",
  );

  it("swapPanes / replacePane", () => {
    expect(leaves(swapPanes(tree, "a", "c"))).toEqual(["c", "b", "a"]);
    expect(leaves(replacePane(tree, "b", "z"))).toEqual(["a", "z", "c"]);
  });

  it("setSizes only applies when the count matches", () => {
    const out = setSizes(tree, "inner", [1, 1]) as LayoutSplit;
    expect((out.children[1] as LayoutSplit).sizes).toEqual([0.5, 0.5]);
    expect(setSizes(tree, "inner", [1, 1, 1])).toEqual(tree);
  });

  it("equalize resets every split", () => {
    const out = equalize(tree) as LayoutSplit;
    expect(out.sizes).toEqual([0.5, 0.5]);
    expect((out.children[1] as LayoutSplit).sizes).toEqual([0.5, 0.5]);
  });

  it("mapPanes copies with new ids", () => {
    const out = mapPanes(tree, (id) => id + "2") as LayoutSplit;
    expect(leaves(out)).toEqual(["a2", "b2", "c2"]);
    expect(out.id).not.toBe("outer");
    expect(leaves(tree)).toEqual(["a", "b", "c"]);
  });
});
