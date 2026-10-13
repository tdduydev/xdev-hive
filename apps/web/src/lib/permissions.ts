import { useQuery } from "@tanstack/react-query";
import type { SystemRoleId } from "@xdev-hive/contracts";
import type { Dict } from "@/lib/i18n.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { useOrgs } from "@/shell/org-context.ts";

/** Nhãn của cây quyền theo Roles.dc.html; khoá khớp PERMISSION_TREE trong @xdev-hive/contracts. */
export const PERMISSION_LABEL: Record<string, Dict<string>> = {
  work: { vi: "Công việc", en: "Work" },
  tasks: { vi: "Bảng việc", en: "Board" },
  "tasks.read": { vi: "Xem việc", en: "View tasks" },
  "tasks.create": { vi: "Tạo và sửa việc", en: "Create and edit tasks" },
  "tasks.assign": { vi: "Giao việc cho agent", en: "Assign to agents" },
  "tasks.delete": { vi: "Xoá việc", en: "Delete tasks" },
  runs: { vi: "Lượt chạy", en: "Runs" },
  "runs.read": { vi: "Xem run và log", en: "View runs and logs" },
  "runs.retry": { vi: "Chạy lại", en: "Retry" },
  "runs.cancel": { vi: "Huỷ run", en: "Cancel runs" },
  plans: { vi: "Kế hoạch", en: "Plans" },
  "plans.read": { vi: "Xem kế hoạch", en: "View plans" },
  "plans.decide": { vi: "Duyệt hoặc từ chối", en: "Approve or reject" },
  leader: { vi: "Leader", en: "Leader" },
  "leader.chat": { vi: "Trò chuyện với leader", en: "Chat with the leader" },
  "leader.approve": { vi: "Duyệt đề xuất của leader", en: "Approve leader proposals" },
  reviews: { vi: "Review code", en: "Code review" },
  "reviews.override": { vi: "Quyết thay checkpoint tự động", en: "Override automatic checkpoints" },
  knowledge: { vi: "Kiến thức", en: "Knowledge" },
  docs: { vi: "Tài liệu", en: "Docs" },
  "docs.read": { vi: "Xem", en: "View" },
  "docs.write": { vi: "Sửa trực tiếp", en: "Edit directly" },
  "docs.delete": { vi: "Xoá", en: "Delete" },
  skills: { vi: "Skills", en: "Skills" },
  "skills.read": { vi: "Xem", en: "View" },
  "skills.write": { vi: "Sửa trực tiếp", en: "Edit directly" },
  memory: { vi: "Memory", en: "Memory" },
  "memory.read": { vi: "Tìm và xem", en: "Search and view" },
  "memory.write": { vi: "Viết", en: "Write" },
  "memory.approve": { vi: "Duyệt memory của agent", en: "Approve agent memories" },
  proposals: { vi: "Đề xuất sửa", en: "Proposals" },
  "proposals.create": { vi: "Tạo đề xuất", en: "Create" },
  "proposals.decide": { vi: "Duyệt đề xuất", en: "Decide" },
  "workflows.write": { vi: "Sửa quy trình duyệt", en: "Edit review workflows" },
  projects: { vi: "Dự án và hạ tầng", en: "Projects & infra" },
  project: { vi: "Dự án", en: "Projects" },
  "projects.read": { vi: "Xem dự án", en: "View projects" },
  "projects.create": { vi: "Tạo dự án", en: "Create projects" },
  "projects.settings": { vi: "Sửa cấu hình", en: "Edit settings" },
  "projects.archive": { vi: "Lưu trữ dự án", en: "Archive projects" },
  merge: { vi: "Merge", en: "Merge" },
  "merge.enqueue": { vi: "Đưa PR vào hàng merge", en: "Enqueue PRs" },
  "merge.force": { vi: "Merge bỏ qua hàng", en: "Merge bypassing the queue" },
  fleet: { vi: "Máy", en: "Machines" },
  "machines.read": { vi: "Xem máy", en: "View machines" },
  "machines.register": { vi: "Tạo token đăng ký máy", en: "Create registration tokens" },
  "machines.remove": { vi: "Gỡ máy", en: "Remove machines" },
  sandbox: { vi: "Sandbox", en: "Sandbox" },
  "sandbox.read": { vi: "Xem allowlist", en: "View allowlist" },
  "sandbox.write": { vi: "Sửa allowlist và image", en: "Edit allowlist and image" },
  agents: { vi: "Quản trị agent", en: "Agent governance" },
  mcp: { vi: "MCP và công cụ", en: "MCP & tools" },
  "mcp.tokens": { vi: "Cấp token MCP cho mình", en: "Issue own MCP tokens" },
  "mcp.servers": { vi: "Quản lý MCP server được phép", en: "Manage allowed MCP servers" },
  policy: { vi: "Chính sách", en: "Policies" },
  "policies.write": { vi: "Sửa chính sách agent", en: "Edit agent policies" },
  "policies.fullaccess": { vi: "Cho phép CLI toàn quyền", en: "Allow full-access CLI" },
  access: { vi: "Người và quyền", en: "People & access" },
  members: { vi: "Thành viên", en: "Members" },
  "members.read": { vi: "Xem thành viên", en: "View members" },
  "members.invite": { vi: "Mời người", en: "Invite" },
  "members.lock": { vi: "Khoá tài khoản", en: "Lock accounts" },
  "members.role": { vi: "Đổi vai trò", en: "Change roles" },
  teams: { vi: "Đội", en: "Teams" },
  "teams.create": { vi: "Tạo đội", en: "Create teams" },
  "teams.manage": { vi: "Quản lý thành viên đội", en: "Manage team members" },
  roles: { vi: "Vai trò", en: "Roles" },
  "roles.write": { vi: "Tạo và sửa vai trò", en: "Create and edit roles" },
  sso: { vi: "Đăng nhập", en: "Sign-in" },
  "signin.write": { vi: "Cấu hình SSO", en: "Configure SSO" },
  ops: { vi: "Theo dõi", en: "Monitoring" },
  costs: { vi: "Chi phí", en: "Costs" },
  "costs.read": { vi: "Xem chi phí", en: "View costs" },
  "costs.budget": { vi: "Đặt ngân sách", en: "Set budgets" },
  audit: { vi: "Nhật ký", en: "Audit log" },
  "audit.read": { vi: "Xem nhật ký", en: "View audit log" },
  "audit.export": { vi: "Xuất nhật ký", en: "Export audit log" },
};

export const SYSTEM_ROLE_TEXT: Record<SystemRoleId, { name: Dict<string>; desc: Dict<string> }> = {
  owner: {
    name: { vi: "Chủ sở hữu", en: "Owner" },
    desc: {
      vi: "Toàn quyền với tổ chức, kể cả xoá tổ chức.",
      en: "Full control, including deleting the organization.",
    },
  },
  admin: {
    name: { vi: "Quản trị", en: "Admin" },
    desc: { vi: "Quản trị người, đội, dự án và chính sách.", en: "Manages people, teams, projects and policies." },
  },
  member: {
    name: { vi: "Thành viên", en: "Member" },
    desc: { vi: "Làm việc trong các đội mình thuộc.", en: "Works inside their teams." },
  },
  "team-admin": {
    name: { vi: "Quản trị đội", en: "Team admin" },
    desc: { vi: "Quản lý người, hệ thống và dự án của đội.", en: "Manages the team’s people, systems and projects." },
  },
  "team-member": {
    name: { vi: "Thành viên đội", en: "Team member" },
    desc: {
      vi: "Làm việc, chạy agent và đề xuất trong đội.",
      en: "Works, runs agents and proposes changes in the team.",
    },
  },
  "team-viewer": {
    name: { vi: "Chỉ xem", en: "Viewer" },
    desc: { vi: "Xem việc, run và tài liệu của đội.", en: "Views the team’s tasks, runs and docs." },
  },
};

/**
 * Quyền hiệu lực của tôi trong tổ chức đang chọn (vai trò hệ thống cộng vai trò tự tạo). Giao diện chỉ dùng để ẩn
 * hoặc hiện; hub mới là nơi chặn. Đang tải thì coi quản trị có đủ quyền để menu không nhấp nháy.
 */
export function usePermissions(): (permission: string) => boolean {
  const { current } = useOrgs();
  const mine = useQuery({
    queryKey: ["org", current?.org.id ?? "none", "roles", "mine"],
    queryFn: async (): Promise<{ permissions: string[] }> =>
      current ? current.api.roles.mine.call({}) : { permissions: [] },
    enabled: !!current,
    staleTime: 60_000,
    // Hub chưa có /roles/mine (bản cũ) thì dùng vai trò tổ chức; thử lại chỉ làm menu chậm hiện.
    retry: false,
  });
  const granted = new Set(mine.data?.permissions ?? []);
  const admin = current ? isOrgAdmin(current.org.role) : false;
  return (permission) => granted.has(permission) || (admin && !mine.data);
}
