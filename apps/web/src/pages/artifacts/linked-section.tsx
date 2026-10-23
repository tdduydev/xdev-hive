import { useQuery } from "@tanstack/react-query";
import { LinkedArtifacts, type LinkedTarget } from "@xdev-hive/artifacts-ui";
import { teamRoleLookup } from "@/lib/projects.ts";
import { useMe } from "@/shell/me-context.ts";
import { useOrg } from "@/shell/org-context.ts";
import { WebArtifacts } from "./web-env.tsx";

/**
 * Người xem có vai trò ghi (member trở lên) ở đội sở hữu đích hay không: chỉ để ẩn nút "Gắn" cho người chỉ xem. Quyền
 * thật do hub kiểm lại ở từng đích (FR-100), nên đoán sai ở đây chỉ làm hiện một lỗi tiếng Việt, không mở quyền.
 */
export function useCanWriteTeam(teamId: string | null | undefined): boolean {
  const { org, api } = useOrg();
  const me = useMe();
  const members = useQuery(api.orgMembers.list.queryOptions({ input: {} }));
  if (!teamId) return false;
  const role = teamRoleLookup(org.role, members.data, me.id)(teamId);
  return role === "admin" || role === "member";
}

/** Đội sở hữu dự án theo key, cho trang chỉ biết key của dự án (hạng mục AI SDLC). */
export function useProjectTeamId(projectKey: string): string | undefined {
  const { api } = useOrg();
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  return projects.data?.find((project) => project.key === projectKey)?.teamId;
}

/** Mục Artifact của trang task, run, hạng mục, tài liệu và dự án (specs/012 T065). */
export function LinkedArtifactsSection({ target, canLink }: { target: LinkedTarget; canLink?: boolean }) {
  return (
    <WebArtifacts>
      <LinkedArtifacts target={target} canLink={canLink} />
    </WebArtifacts>
  );
}

/** Hạng mục AI SDLC chỉ biết key dự án và số; id lấy từ cùng truy vấn mà ItemDetail dùng nên không tải thêm. */
export function SdlcItemArtifacts({ projectKey, number }: { projectKey: string; number: number }) {
  const { api } = useOrg();
  const item = useQuery(api.sdlc.items.get.queryOptions({ input: { projectKey, number } }));
  const canLink = useCanWriteTeam(useProjectTeamId(projectKey));
  if (!item.data) return null;
  return (
    <div className="px-6 pb-6">
      <LinkedArtifactsSection target={{ kind: "sdlc_item", id: item.data.id }} canLink={canLink} />
    </div>
  );
}
