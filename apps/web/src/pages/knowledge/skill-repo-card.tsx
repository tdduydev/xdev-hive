import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SkillRepo } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill, type PillProps } from "@xdev-hive/ui/pill";
import { EllipsisIcon, TriangleAlertIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { cx } from "@/lib/cx.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { usePermissions } from "@/lib/permissions.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { DetailCard } from "@/pages/knowledge/common.tsx";
import { useOrg } from "@/shell/org-context.ts";

const text: Dict<{
  aria: string;
  label: string;
  none: string;
  noneHint: string;
  connect: string;
  change: string;
  remove: string;
  sync: string;
  syncing: string;
  status: Record<SkillRepo["status"], string>;
  lastSync: (when: string) => string;
  never: string;
  hubOnly: (n: number) => string;
  webhookOn: string;
  webhookOff: string;
  dialogTitle: string;
  dialogLead: string;
  connection: string;
  noConnection: string;
  owner: string;
  repo: string;
  branch: string;
  save: string;
  cancel: string;
  removeTitle: string;
  removeBody: string;
  more: string;
  errorLabel: string;
  warnLabel: string;
}> = {
  vi: {
    aria: "Kho skill",
    label: "Kho skill Git",
    none: "Chưa kết nối kho Git",
    noneHint:
      "Skill đang lưu trên hub. Kết nối một repo để Git là bản gốc: sửa trong Git thì hub tự cập nhật, sửa trên hub thì hub commit vào Git.",
    connect: "Kết nối repo",
    change: "Đổi repo",
    remove: "Gỡ kho",
    sync: "Đồng bộ ngay",
    syncing: "Đang đồng bộ…",
    status: { idle: "Chờ đồng bộ", syncing: "Đang đồng bộ", ok: "Đã đồng bộ", failed: "Lỗi đồng bộ" },
    lastSync: (when) => `Lần cuối ${when}`,
    never: "Chưa đồng bộ lần nào",
    hubOnly: (n) => `${n} skill chưa vào Git`,
    webhookOn: "Webhook bật: push vào nhánh là hub tự cập nhật.",
    webhookOff: "Chưa có webhook (hub không công khai hoặc thiếu quyền): dùng Đồng bộ ngay sau khi push.",
    dialogTitle: "Kết nối kho skill",
    dialogLead:
      "Thư mục org/<skill>/, teams/<slug đội>/<skill>/, projects/<key dự án>/<skill>/; mỗi skill một SKILL.md.",
    connection: "Kết nối Git",
    noConnection: "Chưa có kết nối Git. Thêm ở màn Dự án trước.",
    owner: "Owner",
    repo: "Repo",
    branch: "Nhánh",
    save: "Kết nối",
    cancel: "Huỷ",
    removeTitle: "Gỡ kho skill?",
    removeBody: "Skill trên hub giữ nguyên nhưng không còn đồng bộ với Git. Webhook trên repo sẽ được gỡ.",
    more: "Thêm thao tác với kho skill",
    errorLabel: "Lỗi đồng bộ",
    warnLabel: "Cảnh báo",
  },
  en: {
    aria: "Skill repository",
    label: "Git skill repository",
    none: "No Git repository connected",
    noneHint:
      "Skills live on the hub. Connect a repository to make Git the source of truth: Git edits update the hub, hub edits are committed to Git.",
    connect: "Connect repo",
    change: "Change repo",
    remove: "Disconnect",
    sync: "Sync now",
    syncing: "Syncing…",
    status: { idle: "Waiting", syncing: "Syncing", ok: "Synced", failed: "Sync failed" },
    lastSync: (when) => `Last synced ${when}`,
    never: "Never synced",
    hubOnly: (n) => `${n} skills not in Git yet`,
    webhookOn: "Webhook on: pushes to the branch update the hub.",
    webhookOff: "No webhook (hub not public or missing rights): press Sync now after pushing.",
    dialogTitle: "Connect a skill repository",
    dialogLead:
      "Folders org/<skill>/, teams/<team slug>/<skill>/, projects/<project key>/<skill>/; one SKILL.md per skill.",
    connection: "Git connection",
    noConnection: "No Git connection yet. Add one on the Projects screen first.",
    owner: "Owner",
    repo: "Repository",
    branch: "Branch",
    save: "Connect",
    cancel: "Cancel",
    removeTitle: "Disconnect the skill repository?",
    removeBody: "Skills stay on the hub but no longer sync with Git. The repository webhook is removed.",
    more: "More actions for the skill repository",
    errorLabel: "Sync error",
    warnLabel: "Warning",
  },
};

const TONE: Record<SkillRepo["status"], NonNullable<PillProps["tone"]>> = {
  idle: "neutral",
  syncing: "warn",
  ok: "ok",
  failed: "bad",
};

/** Kho skill Git của tổ chức (Skills.dc.html, specs/006): trạng thái, đồng bộ ngay, kết nối hoặc đổi repo. */
export function SkillRepoCard() {
  const t = useT(text);
  const lang = useLang();
  const { api, org } = useOrg();
  const can = usePermissions();
  const admin = isOrgAdmin(org.role);
  const queryClient = useQueryClient();
  const repo = useQuery({
    ...api.skillRepo.get.queryOptions(),
    // Đang đồng bộ thì hỏi lại để thấy kết quả mà không phải tải lại trang.
    refetchInterval: (q) => (q.state.data?.status === "syncing" || q.state.data?.status === "idle" ? 3000 : false),
  });
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: api.skillRepo.key() });
    void queryClient.invalidateQueries({ queryKey: api.skills.key() });
  };
  const sync = useMutation({ mutationFn: () => api.skillRepo.sync.call({}), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: () => api.skillRepo.remove.call({}),
    onSuccess: () => {
      setRemoving(false);
      refresh();
    },
  });
  const r = repo.data;
  const when = r?.lastSyncedAt ? new Date(r.lastSyncedAt).toLocaleString(lang) : null;

  return (
    <DetailCard>
      <section aria-label={t.aria} className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1 basis-64">
            <p className="text-xs text-muted-foreground">{t.label}</p>
            {r ? (
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-medium break-all">
                  {r.owner}/{r.name}@{r.branch}
                </span>
                <Pill tone={TONE[r.status]} dot>
                  {t.status[r.status]}
                </Pill>
              </p>
            ) : repo.isPending ? (
              <Skeleton className="mt-1 h-5 w-48" />
            ) : (
              <p className="font-medium">{t.none}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {r && (admin || can("skills.write")) && (
              <Button size="sm" disabled={sync.isPending || r.status === "syncing"} onClick={() => sync.mutate()}>
                {r.status === "syncing" ? t.syncing : t.sync}
              </Button>
            )}
            {admin && (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                {r ? t.change : t.connect}
              </Button>
            )}
            {admin && r && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t.more} />}>
                  <EllipsisIcon aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem variant="destructive" onClick={() => setRemoving(true)}>
                    {t.remove}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        {r ? (
          <p className="text-xs text-muted-foreground">
            {when ? t.lastSync(when) : t.never}
            {r.lastSha && <span className="font-mono"> · {r.lastSha.slice(0, 7)}</span>} · {t.hubOnly(r.hubOnly)} ·{" "}
            {r.webhookUrl ? t.webhookOn : t.webhookOff}
          </p>
        ) : (
          !repo.isPending && <p className="text-sm text-muted-foreground">{t.noneHint}</p>
        )}
        {r?.error && (
          // Nhãn và biểu tượng đi cùng màu để cảnh báo và lỗi không chỉ khác nhau ở màu chữ.
          <p
            className={cx(
              "flex items-start gap-2 text-sm whitespace-pre-line",
              r.status === "failed" ? "text-destructive" : "text-warning",
            )}
          >
            <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>
              <strong>{r.status === "failed" ? t.errorLabel : t.warnLabel}:</strong> {r.error}
            </span>
          </p>
        )}
        {(sync.isError || remove.isError) && (
          <Alert variant="destructive">{apiErrorMessage(sync.error ?? remove.error)}</Alert>
        )}
      </section>
      {editing && (
        <RepoDialog
          current={r ?? null}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            refresh();
          }}
        />
      )}
      <Dialog open={removing} onOpenChange={setRemoving}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.removeTitle}</DialogTitle>
            <DialogDescription>{t.removeBody}</DialogDescription>
          </DialogHeader>
          <DialogActions>
            <Button variant="outline" onClick={() => setRemoving(false)}>
              {t.cancel}
            </Button>
            <Button variant="destructive-solid" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {t.remove}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </DetailCard>
  );
}

function RepoDialog({
  current,
  onClose,
  onSaved,
}: {
  current: SkillRepo | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT(text);
  const ids = useId();
  const { api } = useOrg();
  const connections = useQuery(api.scmConnections.list.queryOptions());
  const [connectionId, setConnectionId] = useState(current?.connectionId ?? "");
  const [owner, setOwner] = useState(current?.owner ?? "");
  const [name, setName] = useState(current?.name ?? "xdev-skills");
  const [branch, setBranch] = useState(current?.branch ?? "main");
  const chosen = connectionId || connections.data?.[0]?.id || "";
  const save = useMutation({
    mutationFn: () =>
      api.skillRepo.set.call({ connectionId: chosen, owner: owner.trim(), name: name.trim(), branch: branch.trim() }),
    onSuccess: onSaved,
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <DialogHeader>
            <DialogTitle>{t.dialogTitle}</DialogTitle>
            <DialogDescription>{t.dialogLead}</DialogDescription>
          </DialogHeader>
          {connections.data?.length === 0 ? (
            <Alert>{t.noConnection}</Alert>
          ) : (
            <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor={`${ids}-c`}>
              {t.connection}
              <NativeSelect
                id={`${ids}-c`}
                value={chosen}
                onChange={(e) => {
                  setConnectionId(e.target.value);
                  const c = connections.data?.find((x) => x.id === e.target.value);
                  if (c?.defaultOwner && !owner) setOwner(c.defaultOwner);
                }}
              >
                {connections.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.kind})
                  </option>
                ))}
              </NativeSelect>
            </label>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor={`${ids}-o`}>
              {t.owner}
              <Input
                id={`${ids}-o`}
                required
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                className="font-mono"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor={`${ids}-n`}>
              {t.repo}
              <Input
                id={`${ids}-n`}
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="font-mono"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor={`${ids}-b`}>
              {t.branch}
              <Input
                id={`${ids}-b`}
                required
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                className="font-mono"
              />
            </label>
          </div>
          {save.isError && <Alert variant="destructive">{apiErrorMessage(save.error)}</Alert>}
          <DialogActions>
            <Button type="button" variant="outline" onClick={onClose}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={save.isPending || !chosen}>
              {t.save}
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}
