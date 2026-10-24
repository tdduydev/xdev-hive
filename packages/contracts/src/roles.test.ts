import { describe, expect, it } from "vitest";
import {
  DANGEROUS_PERMISSIONS,
  PERMISSION_TREE,
  PERMISSIONS,
  SYSTEM_ROLE_PERMISSIONS,
  type SystemRoleId,
} from "./roles.ts";

const DELIVERY_TEAM = ["ci.view", "ci.operate", "deploy.run", "deploy.approve", "servers.manage"];
const DELIVERY = [...DELIVERY_TEAM, "ci.connections.manage"];

const deliveryOf = (role: SystemRoleId) => SYSTEM_ROLE_PERMISSIONS[role].filter((k) => DELIVERY.includes(k)).sort();

describe("quyền CI/CD và triển khai (specs/020 FR-030)", () => {
  it("cây quyền có nhánh delivery chứa đủ sáu quyền", () => {
    const delivery = PERMISSION_TREE.find((n) => n.key === "delivery");
    expect(delivery).toBeDefined();
    for (const key of DELIVERY) expect(PERMISSIONS).toContain(key);
  });

  it("servers.manage và ci.connections.manage là quyền nguy hiểm", () => {
    expect(DANGEROUS_PERMISSIONS).toContain("servers.manage");
    expect(DANGEROUS_PERMISSIONS).toContain("ci.connections.manage");
    expect(DANGEROUS_PERMISSIONS).not.toContain("deploy.run");
  });

  it("quản trị đội có mọi quyền của đội, không có quyền kết nối của tổ chức", () => {
    expect(deliveryOf("team-admin")).toEqual([...DELIVERY_TEAM].sort());
  });

  it("thành viên đội xem, thao tác CI và chạy triển khai, không duyệt, không sửa máy chủ", () => {
    expect(deliveryOf("team-member")).toEqual(["ci.operate", "ci.view", "deploy.run"]);
  });

  it("vai trò chỉ xem của đội chỉ có ci.view", () => {
    expect(deliveryOf("team-viewer")).toEqual(["ci.view"]);
  });

  it("thành viên tổ chức ngoài đội chỉ xem; BA/PO không có quyền nào", () => {
    expect(deliveryOf("member")).toEqual(["ci.view"]);
    expect(deliveryOf("team-ba")).toEqual([]);
  });

  it("quyền khác của thành viên tổ chức và thành viên đội không đổi", () => {
    const others = (role: SystemRoleId) => SYSTEM_ROLE_PERMISSIONS[role].filter((k) => !DELIVERY.includes(k));
    expect(others("member")).toEqual(others("team-member"));
  });

  it("chủ sở hữu và quản trị tổ chức có cả quyền kết nối", () => {
    expect(deliveryOf("owner")).toEqual([...DELIVERY].sort());
    expect(deliveryOf("admin")).toEqual([...DELIVERY].sort());
  });

  it("Tester không có quyền CI/CD nào ngoài ci.view", () => {
    expect(deliveryOf("team-tester")).toEqual(["ci.view"]);
  });

  it("khoá quyền không trùng nhau, kể cả với khoá nhánh", () => {
    const keys: string[] = [];
    const walk = (nodes: typeof PERMISSION_TREE) => {
      for (const n of nodes) {
        keys.push(n.key);
        if (n.children) walk(n.children);
      }
    };
    walk(PERMISSION_TREE);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

const QA = ["qa.read", "qa.cases.write", "qa.record", "qa.rounds.manage"];
const qaOf = (role: SystemRoleId) => SYSTEM_ROLE_PERMISSIONS[role].filter((k) => QA.includes(k)).sort();

describe("quyền kiểm thử (specs/036 FR-010…FR-014)", () => {
  it("nhánh testing có đủ bốn quyền, không quyền nào nguy hiểm", () => {
    expect(PERMISSION_TREE.find((n) => n.key === "testing")).toBeDefined();
    for (const key of QA) {
      expect(PERMISSIONS).toContain(key);
      expect(DANGEROUS_PERMISSIONS).not.toContain(key);
    }
  });

  it("Tester có đúng bộ quyền của FR-012", () => {
    expect([...SYSTEM_ROLE_PERMISSIONS["team-tester"]].sort()).toEqual(
      [...QA, "docs.read", "proposals.create", "tasks.read", "runs.read", "ci.view"].sort(),
    );
  });

  it("Tester không có quyền nào ở FR-013", () => {
    const forbidden = [
      "tasks.create",
      "tasks.assign",
      "tasks.delete",
      "runs.retry",
      "runs.cancel",
      "merge.enqueue",
      "merge.force",
      "deploy.run",
      "deploy.approve",
      "ci.operate",
      "servers.manage",
      "machines.register",
      "machines.remove",
      "leader.terminal",
      "members.invite",
      "members.lock",
      "members.role",
      "teams.manage",
      "sdlc.override",
      "docs.write",
    ];
    for (const key of forbidden) expect(SYSTEM_ROLE_PERMISSIONS["team-tester"], key).not.toContain(key);
  });

  it("vai trò có sẵn nhận quyền kiểm thử theo FR-014", () => {
    for (const role of ["owner", "admin", "team-admin"] as const) expect(qaOf(role), role).toEqual([...QA].sort());
    for (const role of ["member", "team-member"] as const) expect(qaOf(role), role).toEqual(["qa.read", "qa.record"]);
    expect(qaOf("team-viewer")).toEqual(["qa.read"]);
    expect(qaOf("team-ba")).toEqual(["qa.read"]);
  });
});
