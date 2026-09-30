import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DocSummary } from "@xdev-hive/core";
import { buildTree, docHeadings, flatten, freeSlug, parentChoices, slugify, trail } from "#ui/lib/doctree.ts";

const doc = (key: string, title: string, extra: Partial<DocSummary> = {}): DocSummary => ({
  key,
  scope: key.startsWith("org/") ? "org" : "project",
  project: key.startsWith("project/") ? key.split("/")[1]! : null,
  title,
  version: 1,
  includeInAgents: false,
  paths: [],
  parent: null,
  folder: false,
  updatedBy: "duy",
  updatedAt: "2026-09-30T00:00:00Z",
  ...extra,
});

const docs = [
  doc("project/app/overview", "Tổng quan"),
  doc("project/app/arch", "Kiến trúc", { folder: true }),
  doc("project/app/adr-10", "ADR-010", { parent: "project/app/adr" }),
  doc("project/app/adr-2", "ADR-002", { parent: "project/app/adr" }),
  doc("project/app/adr", "Quyết định", { folder: true }),
  doc("project/app/arch-sys", "Sơ đồ hệ thống", { parent: "project/app/arch" }),
  doc("project/app/arch-db", "Cơ sở dữ liệu", { parent: "project/app/arch-sys" }),
  doc("project/app/orphan", "Mồ côi", { parent: "project/app/gone" }),
  doc("project/app/skills/deploy", "deploy"),
];

describe("docs tree", () => {
  it("puts pages under their parent, folders first, numbers in order, skills in their own folder", () => {
    const tree = buildTree(docs, [{ key: "project/app/new-page", title: "Trang mới", parent: "project/app/arch" }], "Skill");
    assert.deepEqual(
      tree.map((n) => n.title),
      ["Kiến trúc", "Quyết định", "Mồ côi", "Tổng quan", "Skill"],
      "a page whose parent is gone sits at the top",
    );
    const arch = tree[0]!;
    assert.deepEqual(
      arch.children.map((n) => [n.title, n.doc ? "saved" : "draft"]),
      [
        ["Sơ đồ hệ thống", "saved"],
        ["Trang mới", "draft"],
      ],
      "a page with pages under it sorts with the folders",
    );
    assert.deepEqual(tree[1]!.children.map((n) => n.title), ["ADR-002", "ADR-010"]);
    assert.deepEqual(trail(tree, "project/app/arch-db").map((n) => n.title), ["Kiến trúc", "Sơ đồ hệ thống", "Cơ sở dữ liệu"]);
    assert.deepEqual(flatten(tree).find((n) => n.key === "project/app/arch-db")?.path, ["Kiến trúc", "Sơ đồ hệ thống"]);
    assert.deepEqual(tree.at(-1)!.children.map((n) => n.key), ["project/app/skills/deploy"]);
  });

  it("offers as parents every page but the page itself, the pages under it and skills", () => {
    const tree = buildTree(docs);
    const keys = parentChoices(tree, "project/app/arch").map((n) => n.key);
    assert.ok(!keys.includes("project/app/arch") && !keys.includes("project/app/arch-sys") && !keys.includes("project/app/arch-db"));
    assert.ok(keys.includes("project/app/adr") && keys.includes("project/app/overview"));
    assert.ok(!keys.some((k) => k.includes("/skills/")));
  });

  it("does not lose pages that point at each other", () => {
    const tree = buildTree([doc("org/a", "A", { parent: "org/b" }), doc("org/b", "B", { parent: "org/a" })]);
    assert.deepEqual(flatten(tree).map((n) => n.key).sort(), ["org/a", "org/b"]);
  });

  it("makes a slug from a Vietnamese title, and a free one when it is taken", () => {
    assert.equal(slugify("Quy trình deploy — Đợt 2"), "quy-trinh-deploy-dot-2");
    assert.equal(slugify("  ###  "), "");
    const taken = new Set(["org/bao-mat", "org/bao-mat-2"]);
    assert.equal(freeSlug("org/", "bao-mat", (k) => taken.has(k)), "bao-mat-3");
    assert.equal(freeSlug("org/", "", () => false), "trang");
  });

  it("lists ## and ### headings outside code, with ids that stay apart", () => {
    const md = "# Tiêu đề\n## Cài đặt\ntext\n```\n## not a heading\n```\n### Bước **1**\n## Cài đặt";
    assert.deepEqual(docHeadings(md), [
      { depth: 2, text: "Cài đặt", id: "h-cai-dat", line: 2 },
      { depth: 3, text: "Bước 1", id: "h-buoc-1", line: 7 },
      { depth: 2, text: "Cài đặt", id: "h-cai-dat-2", line: 8 },
    ]);
  });
});
