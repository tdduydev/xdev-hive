import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { useId, useState } from "react";
import { SettingsSection } from "@/components/page/settings.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { formatDay } from "@/lib/format.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { useOrg } from "@/shell/org-context.ts";

const text: Dict<{
  title: string;
  hint: string;
  empty: string;
  addedOn: (day: string) => string;
  remove: string;
  removing: string;
  pick: string;
  noCandidates: string;
  add: string;
  adding: string;
}> = {
  vi: {
    title: "Thành viên dự án",
    hint: "Thành viên thấy dự án trong mục Dự án của tôi ở trang Tài liệu. Không đổi quyền xem.",
    empty: "Dự án chưa có thành viên.",
    addedOn: (day) => `Thêm ngày ${day}`,
    remove: "Gỡ",
    removing: "Đang gỡ…",
    pick: "Thêm từ thành viên đội",
    noCandidates: "Mọi thành viên của đội đã ở trong dự án.",
    add: "Thêm",
    adding: "Đang thêm…",
  },
  en: {
    title: "Project members",
    hint: "Members see the project under My projects on the Docs page. This does not change who can view.",
    empty: "This project has no members yet.",
    addedOn: (day) => `Added ${day}`,
    remove: "Remove",
    removing: "Removing…",
    pick: "Add from team members",
    noCandidates: "Every team member is already in the project.",
    add: "Add",
    adding: "Adding…",
  },
};

/**
 * Người của đội sở hữu mà dự án hiện trong "Dự án của tôi" của họ (FR-030..FR-033). Không có nút Lưu chung như các
 * mục khác: mỗi lần Thêm hay Gỡ là một lời gọi riêng, nên danh sách luôn là bản hub đang giữ.
 */
export function ProjectMembersSection({ project, canManage }: { project: Project; canManage: boolean }) {
  const { api } = useOrg();
  const t = useT(text);
  const queryClient = useQueryClient();
  const pickId = useId();
  const [picked, setPicked] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  const members = useQuery(api.projectMembers.list.queryOptions({ input: { id: project.id } }));
  // Hub chỉ cho quản trị đội xem đủ danh sách đội, nên người chỉ xem không gọi.
  const team = useQuery({
    ...api.teamMembers.list.queryOptions({ input: { teamId: project.teamId } }),
    enabled: canManage,
  });

  // Trang Tài liệu đọc cùng nhóm khoá này (projectMembers/mine), nên làm mới cả nhóm.
  const refresh = () => queryClient.invalidateQueries({ queryKey: api.projectMembers.key() });
  const add = useMutation({
    mutationFn: (userIds: string[]) => api.projectMembers.add.call({ id: project.id, userIds }),
    onMutate: () => setFailure(null),
    onSuccess: async () => {
      setPicked([]);
      await refresh();
    },
    onError: (error) => setFailure(apiErrorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api.projectMembers.remove.call({ id: project.id, userId }),
    onMutate: () => setFailure(null),
    onSuccess: refresh,
    onError: (error) => setFailure(apiErrorMessage(error)),
  });

  const inProject = new Set((members.data ?? []).map((m) => m.userId));
  const candidates = (team.data ?? []).filter((m) => !inProject.has(m.userId));
  const toggle = (userId: string, on: boolean) =>
    setPicked((p) => (on ? [...p, userId] : p.filter((id) => id !== userId)));

  return (
    <SettingsSection id="members" title={t.title} description={t.hint}>
      {failure && <Alert variant="destructive">{failure}</Alert>}

      {members.isPending ? (
        <LoadingState />
      ) : members.isError ? (
        <LoadFailure error={members.error} retry={() => void members.refetch()} />
      ) : members.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.empty}</p>
      ) : (
        <ul aria-label={t.title} className="m-0 grid list-none gap-2 p-0">
          {members.data.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <strong className="font-medium text-foreground">{m.name}</strong>
              <span className="text-xs text-muted-foreground">{m.email}</span>
              <span className="flex-1" />
              <span className="text-xs text-muted-foreground">{t.addedOn(formatDay(m.addedAt))}</span>
              {canManage && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(m.userId)}
                >
                  {remove.isPending && remove.variables === m.userId ? t.removing : t.remove}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
          <legend className="mb-1 text-sm font-medium text-foreground">{t.pick}</legend>
          {team.isPending ? (
            <LoadingState />
          ) : team.isError ? (
            <LoadFailure error={team.error} retry={() => void team.refetch()} />
          ) : candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.noCandidates}</p>
          ) : (
            <>
              {candidates.map((m) => (
                <label key={m.userId} htmlFor={`${pickId}-${m.userId}`} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id={`${pickId}-${m.userId}`}
                    checked={picked.includes(m.userId)}
                    disabled={add.isPending}
                    onCheckedChange={(on) => toggle(m.userId, on)}
                  />
                  <span className="font-medium text-foreground">{m.name}</span>
                  <span className="text-xs text-muted-foreground">{m.email}</span>
                </label>
              ))}
              <div>
                <Button
                  type="button"
                  disabled={picked.length === 0 || add.isPending}
                  onClick={() => add.mutate(picked)}
                >
                  {add.isPending ? t.adding : t.add}
                </Button>
              </div>
            </>
          )}
        </fieldset>
      )}
    </SettingsSection>
  );
}
