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

  it("thành viên tổ chức như thành viên đội; BA/PO không có quyền nào", () => {
    expect(deliveryOf("member")).toEqual(deliveryOf("team-member"));
    expect(deliveryOf("team-ba")).toEqual([]);
  });

  it("chủ sở hữu và quản trị tổ chức có cả quyền kết nối", () => {
    expect(deliveryOf("owner")).toEqual([...DELIVERY].sort());
    expect(deliveryOf("admin")).toEqual([...DELIVERY].sort());
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
