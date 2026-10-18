import type { DocTreeItem } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import {
  buildScopeTree,
  defaultFilter,
  type Folder,
  inFilter,
  type MyMembership,
  openByDefault,
  type ScopeNames,
} from "@/pages/knowledge/doc-scope.ts";

const fileCount = (folder: Folder | null | undefined): number =>
  folder ? folder.files.length + [...folder.folders.values()].reduce((sum, f) => sum + fileCount(f), 0) : 0;

const member = (projects: string[], teams: string[] = []): MyMembership => ({
  projectIds: new Set(projects),
  teamIds: new Set(teams),
});

const orgScope = { level: "org", teamId: null, projectId: null } as const;
const teamScope = (teamId: string) => ({ level: "team", teamId, projectId: null }) as const;
const projectScope = (teamId: string, projectId: string) => ({ level: "project", teamId, projectId }) as const;

let seq = 0;
const item = (patch: Partial<DocTreeItem> = {}): DocTreeItem => {
  seq += 1;
  return {
    homeId: "home",
    key: `doc/${seq}`,
    title: `Tài liệu ${seq}`,
    path: `docs/${seq}.md`,
    kind: "doc",
    state: "synced",
    prNumber: null,
    prUrl: null,
    repoUrl: null,
    repoCommit: null,
    docId: `id-${seq}`,
    assetId: null,
    version: 1,
    error: null,
    scope: orgScope,
    ...patch,
  };
};

const names: ScopeNames = {
  teams: new Map([
    ["A", "Đơn vị A"],
    ["B", "Đơn vị B"],
  ]),
  systems: new Map([
    ["S1", { name: "Hệ thống 1", teamId: "A" }],
    ["S2", { name: "Hệ thống 2", teamId: "B" }],
  ]),
  projects: new Map([
    ["P1", { name: "Dự án 1", systemId: "S1", teamId: "A" }],
    ["P2", { name: "Dự án 2", systemId: "S2", teamId: "B" }],
  ]),
};

describe("lọc và gom cây tài liệu", () => {
  it("mặc định Dự án của tôi khi có dự án, Tất cả khi không có", () => {
    expect(defaultFilter(null, member(["p1"]))).toBe("mine");
    expect(defaultFilter("mine", member([]))).toBe("all");
    expect(defaultFilter("all", member(["p1"]))).toBe("all");
    expect(defaultFilter(null, member([]))).toBe("all");
  });

  it("Dự án của tôi giữ tài liệu chung tổ chức, chung đơn vị của đội mình và dự án mình", () => {
    const m = member(["p1"], ["t1"]);
    expect(inFilter(item({ scope: orgScope }), "mine", m)).toBe(true);
    expect(inFilter(item({ scope: teamScope("t1") }), "mine", m)).toBe(true);
    expect(inFilter(item({ scope: teamScope("t2") }), "mine", m)).toBe(false);
    expect(inFilter(item({ scope: projectScope("t1", "p1") }), "mine", m)).toBe(true);
    expect(inFilter(item({ scope: projectScope("t1", "p2") }), "mine", m)).toBe(false);
    expect(inFilter(item({ scope: teamScope("t2") }), "all", m)).toBe(true);
  });

  it("gom theo đơn vị, hệ thống, dự án đúng thứ tự và bỏ nút rỗng", () => {
    const tree = buildScopeTree(
      [
        item({ scope: projectScope("A", "P1") }),
        item({ scope: teamScope("B") }),
        item({ scope: teamScope("A") }),
        item({ scope: orgScope }),
        item({ scope: projectScope("B", "P2") }),
      ],
      names,
    );
    expect(tree.map((n) => n.kind)).toEqual(["org", "team", "team"]);
    expect(tree.map((n) => n.id)).toEqual(["org", "team:A", "team:B"]);
    const [, a] = tree;
    expect(a?.children.map((n) => n.kind)).toEqual(["team-common", "system"]);
    expect(a?.children.map((n) => n.id)).toEqual(["team-common:A", "system:S1"]);
    expect(a?.children[1]?.children.map((n) => n.kind)).toEqual(["project"]);
    expect(a?.children[1]?.children[0]?.id).toBe("project:P1");
    expect(tree[0]?.name).toBe("Chung toàn tổ chức");
    expect(a?.children[0]?.name).toBe("Chung đơn vị");
    expect(a?.count).toBe(2);
    // Nút lá giữ thư mục, nút cha thì không.
    expect(a?.folder).toBeNull();
    expect(fileCount(a?.children[0]?.folder)).toBe(1);
    // Dự án không có tài liệu thì không xuất hiện.
    expect(buildScopeTree([item({ scope: orgScope })], names).map((n) => n.id)).toEqual(["org"]);
  });

  it("dùng nhãn dự phòng khi thiếu tên", () => {
    const tree = buildScopeTree([item({ scope: teamScope("lạ") }), item({ scope: projectScope("A", "lạ") })], names);
    const unknown = tree.find((n) => n.id === "team:lạ");
    expect(unknown?.name).toBe("Đơn vị khác");
    const a = tree.find((n) => n.id === "team:A");
    expect(a?.children.map((n) => n.kind)).toEqual(["other-projects"]);
    expect(a?.children[0]?.id).toBe("other:A");
    expect(a?.children[0]?.name).toBe("Dự án khác");
  });

  it("đính kèm nằm cùng dự án với tài liệu, count chỉ đếm tài liệu", () => {
    const tree = buildScopeTree(
      [
        item({ scope: projectScope("A", "P1") }),
        item({ scope: projectScope("A", "P1"), kind: "asset", docId: null, assetId: "asset", key: null }),
      ],
      names,
    );
    const project = tree[0]?.children[0]?.children[0];
    expect(project?.id).toBe("project:P1");
    expect(project?.count).toBe(1);
    expect(fileCount(project?.folder)).toBe(2);
    expect(tree[0]?.count).toBe(1);
  });

  it("tài liệu đã lưu trữ chưa có nhà vẫn gom theo scope", () => {
    // Giống kết quả của withUnhomedDocs: không nhà, không path, scope lấy từ bản tóm tắt.
    const tree = buildScopeTree(
      [
        item({ homeId: null, path: null, key: "org/cu", scope: orgScope }),
        item({ homeId: null, path: null, key: "p1/cu", scope: projectScope("A", "P1") }),
      ],
      names,
    );
    expect(tree.map((n) => n.id)).toEqual(["org", "team:A"]);
    const everyName: string[] = [];
    const walk = (nodes: typeof tree) => {
      for (const n of nodes) {
        everyName.push(n.name, ...(n.folder ? [n.folder.name] : []));
        walk(n.children);
      }
    };
    walk(tree);
    expect(everyName).not.toContain("Chưa có nhà");
  });

  it("mở sẵn đường tới dự án của tôi, đóng phần còn lại", () => {
    const tree = buildScopeTree(
      [
        item({ scope: orgScope }),
        item({ scope: teamScope("A") }),
        item({ scope: projectScope("A", "P1") }),
        item({ scope: projectScope("B", "P2") }),
      ],
      names,
    );
    expect(openByDefault(tree, member(["P1"], ["A"]))).toEqual(new Set(["team:A", "system:S1", "project:P1"]));
    expect(openByDefault(tree, member([]))).toEqual(new Set());
  });
});
