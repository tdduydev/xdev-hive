import type { OrgMember, OrgRole, Project, ProjectState, Run, TeamRole } from "@xdev-hive/contracts";
import { effectiveTeamRole } from "./roles.ts";
import { isTerminal, type Tone } from "./run-view.ts";

export const PROJECT_STATE: Record<ProjectState, { label: string; tone: Tone }> = {
  provisioning: { label: "Đang khởi tạo", tone: "sel" },
  active: { label: "Hoạt động", tone: "ok" },
  failed: { label: "Khởi tạo lỗi", tone: "bad" },
  archived: { label: "Lưu trữ", tone: "neutral" },
};

export const SCM_LABEL = { github: "GitHub", gitlab: "GitLab" } as const;

export const repoPath = (p: Pick<Project, "repo">): string => `${p.repo.owner}/${p.repo.name}`;

/**
 * Vai trò của người đang đăng nhập trong từng đội, lấy từ danh sách thành viên tổ chức (mọi thành viên gọi được,
 * còn teamMembers.list thì phải từng đội một). Quản trị tổ chức là quản trị mọi đội. Chỉ để ẩn nút; hub kiểm lại.
 */
export function teamRoleLookup(
  orgRole: OrgRole,
  members: OrgMember[] | undefined,
  userId: string,
): (teamId: string) => TeamRole | null {
  const mine = members?.find((m) => m.userId === userId);
  return (teamId) => effectiveTeamRole(orgRole, mine?.teams.find((t) => t.teamId === teamId)?.role ?? undefined);
}

/** Số việc đang có run chưa kết thúc theo dự án, từ run gần nhất của mỗi việc (runs.latest). */
export function activeRunCounts(latest: Run[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of latest) {
    if (!isTerminal(r.state)) out.set(r.projectId, (out.get(r.projectId) ?? 0) + 1);
  }
  return out;
}

/** Số ngày của cột "Chi phí" trên danh sách dự án. */
export const COST_DAYS = 7;

/** Khoảng ngày (UTC, tính cả hai đầu) của `days` ngày gần nhất tính tới hôm nay, theo dạng costs.summary nhận. */
export function recentDays(now: number, days = COST_DAYS): { from: string; to: string } {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: day(now - (days - 1) * 86_400_000), to: day(now) };
}
