// The Docs tree (roadmap 22j): pages under pages by their parent, folders first, skills in a folder of their own; the
// headings a reader's table of contents lists; a slug from a Vietnamese title.
import { keyPrefix, type DocSummary } from "@xdev-hive/core";

export interface TreeNode {
  key: string;
  title: string;
  /** null: a page made on this device and not saved yet (only its draft exists). */
  doc: DocSummary | null;
  folder: boolean;
  children: TreeNode[];
  /** The titles above it, top first. */
  path: string[];
}

const isSkill = (key: string) => /^(org|project\/[^/]+)\/skills\//.test(key);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const order = (a: TreeNode, b: TreeNode) => Number(b.folder || b.children.length > 0) - Number(a.folder || a.children.length > 0) || collator.compare(a.title, b.title);

/**
 * The pages of one space as a tree. `extra` are pages that exist only as drafts here (new, with their parent). A page
 * whose parent is gone (or in another space) sits at the top. Skills go in a folder of their own (`skillsLabel`).
 */
export function buildTree(docs: DocSummary[], extra: Array<{ key: string; title: string; parent: string | null }> = [], skillsLabel = "skills"): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  const parentOf = new Map<string, string | null>();
  for (const d of docs) {
    nodes.set(d.key, { key: d.key, title: d.title || d.key.slice(keyPrefix(d.key).length), doc: d, folder: d.folder ?? false, children: [], path: [] });
    parentOf.set(d.key, d.parent ?? null);
  }
  for (const e of extra) {
    if (nodes.has(e.key)) continue;
    nodes.set(e.key, { key: e.key, title: e.title || e.key.slice(keyPrefix(e.key).length), doc: null, folder: false, children: [], path: [] });
    parentOf.set(e.key, e.parent);
  }
  const top: TreeNode[] = [];
  const skills: TreeNode[] = [];
  for (const n of nodes.values()) {
    if (isSkill(n.key)) {
      skills.push(n);
      continue;
    }
    const p = parentOf.get(n.key);
    const parent = p && p !== n.key ? nodes.get(p) : undefined;
    (parent && !isSkill(parent.key) ? parent.children : top).push(n);
  }
  // A loop (only possible in data written by hand) would hide its pages: they go to the top.
  const placed = new Set<string>();
  const walk = (list: TreeNode[], path: string[]) => {
    list.sort(order);
    for (const n of list) {
      placed.add(n.key);
      n.path = path;
      walk(n.children, [...path, n.title]);
    }
  };
  walk(top, []);
  for (const n of nodes.values()) {
    if (placed.has(n.key) || isSkill(n.key)) continue;
    for (const other of nodes.values()) other.children = other.children.filter((c) => c.key !== n.key);
    top.push(n);
    walk(top, []);
  }
  if (skills.length) {
    const prefix = keyPrefix(skills[0]!.key);
    const folder: TreeNode = { key: `${prefix}skills`, title: skillsLabel, doc: null, folder: true, children: skills.sort(order), path: [] };
    for (const s of skills) s.path = [skillsLabel];
    top.push(folder);
  }
  return top;
}

/** Every node, depth first. */
export function flatten(tree: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/** The chain from the top to `key` (both included); [] when it is not in the tree. */
export function trail(tree: TreeNode[], key: string): TreeNode[] {
  for (const n of tree) {
    if (n.key === key) return [n];
    const below = trail(n.children, key);
    if (below.length) return [n, ...below];
  }
  return [];
}

/** The pages `key` may go under: of its space, not itself or below it, not skills, not the skills folder. */
export function parentChoices(tree: TreeNode[], key: string): TreeNode[] {
  const self = flatten(tree).find((n) => n.key === key);
  const below = new Set(self ? flatten(self.children).map((n) => n.key) : []);
  return flatten(tree).filter((n) => n.doc && n.key !== key && !below.has(n.key) && !isSkill(n.key));
}

/** "Quy trình deploy" → "quy-trinh-deploy": the slug part of a doc key. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

/** `slug`, or `slug-2`, `slug-3`… when the key is taken. */
export function freeSlug(prefix: string, slug: string, taken: (key: string) => boolean): string {
  const base = slug || "trang";
  if (!taken(prefix + base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken(`${prefix}${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36)}`;
}

export interface Heading {
  depth: 2 | 3;
  text: string;
  id: string;
  /** 1-based line in the Markdown: how the rendered heading finds its id. */
  line: number;
}

/** The ## and ### headings outside code: what the reader's table of contents lists. */
export function docHeadings(md: string): Heading[] {
  const out: Heading[] = [];
  const used = new Map<string, number>();
  let fence: string | null = null;
  for (const [i, line] of md.split("\n").entries()) {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) {
      fence = fence === null ? f[1]! : fence === f[1] ? null : fence;
      continue;
    }
    if (fence) continue;
    const m = /^(##|###)\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const text = m[2]!.replace(/[*_`[\]]/g, "");
    out.push({ depth: m[1]!.length as 2 | 3, text, id: headingId(text, used), line: i + 1 });
  }
  return out;
}

/** The id a heading gets, the same in the table of contents and the rendered page (`used` counts repeats). */
export function headingId(text: string, used: Map<string, number>): string {
  const base = `h-${slugify(text) || "muc"}`;
  const n = used.get(base) ?? 0;
  used.set(base, n + 1);
  return n ? `${base}-${n + 1}` : base;
}
