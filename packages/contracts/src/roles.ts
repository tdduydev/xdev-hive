import { z } from "zod";
import { orgRoute } from "./common.ts";

/**
 * Cây quyền theo docs/design-system/screens/Roles.dc.html. Nút lá là quyền thật (lưu và kiểm); nút nhánh chỉ để chọn
 * nhanh mọi quyền con. Chữ hiển thị nằm ở web, theo khoá.
 */
export interface PermissionNode {
  key: string;
  danger?: true;
  children?: PermissionNode[];
}

const leaf = (key: string, danger = false): PermissionNode => (danger ? { key, danger: true } : { key });
const branch = (key: string, children: PermissionNode[]): PermissionNode => ({ key, children });

export const PERMISSION_TREE: readonly PermissionNode[] = [
  branch("work", [
    branch("tasks", [leaf("tasks.read"), leaf("tasks.create"), leaf("tasks.assign"), leaf("tasks.delete")]),
    branch("runs", [leaf("runs.read"), leaf("runs.retry"), leaf("runs.cancel")]),
    branch("plans", [leaf("plans.read"), leaf("plans.decide")]),
    branch("leader", [leaf("leader.chat"), leaf("leader.approve")]),
    // Quyết thay checkpoint tự động của phiên review code (cho đạt dù máy chưa kiểm xong hoặc không đạt).
    branch("reviews", [leaf("reviews.override", true)]),
  ]),
  branch("knowledge", [
    branch("docs", [leaf("docs.read"), leaf("docs.write"), leaf("docs.delete")]),
    branch("skills", [leaf("skills.read"), leaf("skills.write")]),
    branch("memory", [leaf("memory.read"), leaf("memory.write"), leaf("memory.approve")]),
    branch("proposals", [leaf("proposals.create"), leaf("proposals.decide"), leaf("workflows.write")]),
  ]),
  branch("projects", [
    branch("project", [
      leaf("projects.read"),
      leaf("projects.create"),
      leaf("projects.settings"),
      leaf("projects.archive"),
    ]),
    branch("merge", [leaf("merge.enqueue"), leaf("merge.force", true)]),
    branch("fleet", [leaf("machines.read"), leaf("machines.register"), leaf("machines.remove")]),
    branch("sandbox", [leaf("sandbox.read"), leaf("sandbox.write")]),
  ]),
  branch("agents", [
    branch("mcp", [leaf("mcp.tokens"), leaf("mcp.servers")]),
    branch("policy", [leaf("policies.write"), leaf("policies.fullaccess", true)]),
  ]),
  branch("access", [
    branch("members", [leaf("members.read"), leaf("members.invite"), leaf("members.lock"), leaf("members.role")]),
    branch("teams", [leaf("teams.create"), leaf("teams.manage")]),
    branch("roles", [leaf("roles.write", true)]),
    branch("sso", [leaf("signin.write", true)]),
  ]),
  branch("ops", [
    branch("costs", [leaf("costs.read"), leaf("costs.budget")]),
    branch("audit", [leaf("audit.read"), leaf("audit.export")]),
  ]),
];

function leaves(nodes: readonly PermissionNode[]): PermissionNode[] {
  return nodes.flatMap((n) => (n.children ? leaves(n.children) : [n]));
}

export const PERMISSIONS: readonly string[] = leaves(PERMISSION_TREE).map((n) => n.key);
export const DANGEROUS_PERMISSIONS: readonly string[] = leaves(PERMISSION_TREE)
  .filter((n) => n.danger)
  .map((n) => n.key);

const isRead = (k: string) => k.endsWith(".read");
// Quyền đọc nhạy cảm: thiết kế mẫu cho người xem mọi quyền ".read", nhưng hub chỉ cho quản trị xem nhật ký, chi phí
// và allowlist sandbox. Vai trò hệ thống phải đúng như hub đang chặn; muốn cho thêm thì tạo vai trò riêng.
const ADMIN_READS = new Set(["audit.read", "costs.read", "sandbox.read", "machines.read"]);
const viewer = (k: string) => isRead(k) && !ADMIN_READS.has(k);
const MEMBER_EXTRA = new Set([
  "tasks.create",
  "tasks.assign",
  "runs.retry",
  "runs.cancel",
  "plans.decide",
  "leader.chat",
  "memory.write",
  "proposals.create",
  "merge.enqueue",
  "mcp.tokens",
  "machines.read",
]);
const member = (k: string) => viewer(k) || MEMBER_EXTRA.has(k);
const TEAM_ADMIN_EXTRA = new Set([
  "projects.create",
  "projects.settings",
  "teams.manage",
  "docs.write",
  "skills.write",
  "memory.approve",
  "proposals.decide",
  "workflows.write",
  "sandbox.write",
  "sandbox.read",
  "costs.read",
  "costs.budget",
  "machines.register",
  "members.invite",
  "reviews.override",
]);

export const systemRoleId = z.enum(["owner", "admin", "member", "team-admin", "team-member", "team-viewer"]);
export type SystemRoleId = z.infer<typeof systemRoleId>;

/** Quyền của vai trò hệ thống. Vai trò hệ thống không sửa được; quản trị nhân bản thành vai trò tự tạo nếu cần. */
export const SYSTEM_ROLE_PERMISSIONS: Record<SystemRoleId, readonly string[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS.filter((k) => k !== "policies.fullaccess"),
  member: PERMISSIONS.filter(member),
  "team-admin": PERMISSIONS.filter((k) => member(k) || TEAM_ADMIN_EXTRA.has(k)),
  "team-member": PERMISSIONS.filter(member),
  "team-viewer": PERMISSIONS.filter(viewer),
};

const id = z.uuid();
const permissionKey = z.enum(PERMISSIONS as [string, ...string[]]);
export const roleScope = z.enum(["org", "team"]);

export const roleAssignment = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), userId: z.string().min(1), name: z.string(), email: z.string() }),
  z.object({ kind: z.literal("team"), teamId: id, name: z.string() }),
]);

export const systemRole = z.object({
  id: systemRoleId,
  scope: roleScope,
  permissions: z.array(z.string()),
  /** Số người đang có vai trò này (tổ chức: thành viên đang hoạt động; đội: dòng team_members). */
  memberCount: z.number().int(),
});

export const customRole = z.object({
  id,
  name: z.string(),
  description: z.string().nullable(),
  scope: roleScope,
  permissions: z.array(z.string()),
  assignments: z.array(roleAssignment),
  updatedAt: z.iso.datetime(),
});
export type CustomRole = z.output<typeof customRole>;

const roleName = z.string().trim().min(1, "Cần tên vai trò.").max(80, "Tên vai trò tối đa 80 ký tự.");
const roleDescription = z.string().trim().max(500, "Mô tả tối đa 500 ký tự.");
const permissionList = z.array(permissionKey).max(PERMISSIONS.length);

export const rolesContract = {
  list: orgRoute("GET", "/v1/roles", "Vai trò hệ thống và vai trò tự tạo của tổ chức", "roles").output(
    z.object({ system: z.array(systemRole), custom: z.array(customRole) }),
  ),
  create: orgRoute("POST", "/v1/roles", "Tạo vai trò tự tạo (quyền roles.write)", "roles")
    .input(
      z.object({
        name: roleName,
        description: roleDescription.optional(),
        scope: roleScope,
        permissions: permissionList,
        /** Nhân bản từ vai trò hệ thống: bỏ qua `permissions`, lấy đúng quyền của vai trò đó. */
        copyOf: systemRoleId.optional(),
      }),
    )
    .output(customRole),
  update: orgRoute("PATCH", "/v1/roles/{roleId}", "Sửa vai trò tự tạo (quyền roles.write)", "roles")
    .input(
      z.object({
        roleId: id,
        name: roleName.optional(),
        description: roleDescription.nullish(),
        permissions: permissionList.optional(),
      }),
    )
    .output(customRole),
  remove: orgRoute("DELETE", "/v1/roles/{roleId}", "Xoá vai trò tự tạo chưa gán cho ai (quyền roles.write)", "roles")
    .input(z.object({ roleId: id }))
    .output(z.object({ ok: z.literal(true) })),
  assign: orgRoute("POST", "/v1/roles/{roleId}/assignments", "Gán vai trò cho người hoặc đội", "roles")
    .input(
      z.discriminatedUnion("kind", [
        z.object({ roleId: id, kind: z.literal("member"), userId: z.string().min(1) }),
        z.object({ roleId: id, kind: z.literal("team"), teamId: id }),
      ]),
    )
    .output(customRole),
  unassign: orgRoute("DELETE", "/v1/roles/{roleId}/assignments", "Gỡ vai trò khỏi người hoặc đội", "roles")
    .input(
      z.discriminatedUnion("kind", [
        z.object({ roleId: id, kind: z.literal("member"), userId: z.string().min(1) }),
        z.object({ roleId: id, kind: z.literal("team"), teamId: id }),
      ]),
    )
    .output(customRole),
  mine: orgRoute("GET", "/v1/roles/mine", "Quyền hiệu lực của tôi trong tổ chức (và một đội)", "roles")
    .input(z.object({ teamId: id.optional() }))
    .output(z.object({ permissions: z.array(z.string()) })),
};
