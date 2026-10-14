import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type AllowlistEntry, egressRule } from "@xdev-hive/contracts";
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
import { GlobeLockIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { Field, FieldError, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { EmptyState, LoadFailure } from "@/components/ui/query-state.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { formatDayTime } from "@/lib/format.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { useOrg } from "@/shell/org-context.ts";

const text: Dict<{
  loading: string;
  emptyList: string;
  emptyHint: string;
  removeTitle: (rule: string) => string;
  removeHintOrg: string;
  removeHintProject: string;
  removing: string;
  cancel: string;
  listAria: string;
  remove: string;
  removeAria: (rule: string) => string;
  ruleLabel: string;
  noteLabel: string;
  notePh: string;
  ruleHint: string;
  ruleInvalid: string;
  addBtn: string;
  addingBtn: string;
}> = {
  vi: {
    loading: "Đang tải mục mạng…",
    emptyList: "Chưa có mục mạng nào",
    emptyHint: "Run sandbox chỉ ra được các địa chỉ có trong danh sách. Thêm mục ở ô bên dưới.",
    removeTitle: (r) => `Xoá mục mạng ${r}?`,
    removeHintOrg: "Run sandbox của mọi dự án không ra được địa chỉ này nữa, trừ khi dự án có mục riêng cho nó.",
    removeHintProject: "Run sandbox của dự án không ra được địa chỉ này nữa, trừ khi tổ chức có mục cho nó.",
    removing: "Đang xoá…",
    cancel: "Huỷ",
    listAria: "Danh sách mục mạng",
    remove: "Xoá",
    removeAria: (r) => `Xoá ${r}`,
    ruleLabel: "Mục mạng",
    noteLabel: "Ghi chú",
    notePh: "Vì sao cần mở",
    ruleHint: "Tên miền, *.tên-miền, IP hoặc CIDR; thêm :cổng nếu cần.",
    ruleInvalid: "Mục mạng không hợp lệ.",
    addBtn: "Thêm",
    addingBtn: "Đang thêm…",
  },
  en: {
    loading: "Loading network rules…",
    emptyList: "No network rules yet",
    emptyHint: "Sandbox runs can only reach addresses in this list. Add a rule below.",
    removeTitle: (r) => `Remove network rule ${r}?`,
    removeHintOrg: "Sandbox runs of every project can no longer reach this address unless a project has its own rule.",
    removeHintProject:
      "This project's sandbox runs can no longer reach this address unless the organization allows it.",
    removing: "Removing…",
    cancel: "Cancel",
    listAria: "Network rules list",
    remove: "Remove",
    removeAria: (r) => `Remove ${r}`,
    ruleLabel: "Network rule",
    noteLabel: "Note",
    notePh: "Why it needs to be open",
    ruleHint: "Domain, *.domain, IP or CIDR; add :port if needed.",
    ruleInvalid: "Invalid network rule.",
    addBtn: "Add",
    addingBtn: "Adding…",
  },
};

/**
 * Mục mạng của tổ chức (không có `projectId`) hoặc của một dự án. Kiểm định dạng bằng cùng schema với hub và egress
 * proxy, nên lỗi hiện ngay dưới ô thay vì chờ hub trả 400.
 */
export function AllowlistEditor({
  projectId,
  canEdit,
  lockedNote,
}: {
  projectId?: string;
  canEdit: boolean;
  /** Tổ chức đã khoá allowlist: dự án không thêm được mục riêng. */
  lockedNote?: string;
}) {
  const { api } = useOrg();
  const t = useT(text);
  const queryClient = useQueryClient();
  const ids = { rule: useId(), note: useId() };
  const scope = projectId ? { projectId } : {};
  const entries = useQuery(api.sandbox.listAllowlist.queryOptions({ input: scope }));
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AllowlistEntry | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: api.sandbox.key() });
  const add = useMutation({
    mutationFn: (input: { rule: string; note?: string }) => api.sandbox.addAllowlist.call({ ...scope, ...input }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (entryId: string) => api.sandbox.removeAllowlist.call({ ...scope, entryId }),
    onSuccess: async () => {
      setRemoving(null);
      await refresh();
    },
  });
  const editable = canEdit && !lockedNote;

  function onAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const rule = String(data.get("rule") ?? "").trim();
    const note = String(data.get("note") ?? "").trim();
    const parsed = egressRule.safeParse(rule);
    if (!parsed.success) {
      setRuleError(parsed.error.issues[0]?.message ?? t.ruleInvalid);
      return;
    }
    setRuleError(null);
    add.mutate({ rule: parsed.data, ...(note ? { note } : {}) }, { onSuccess: () => form.reset() });
  }

  if (entries.isPending)
    return (
      <div role="status" aria-busy="true" className="grid gap-1.5">
        <span className="sr-only">{t.loading}</span>
        <Skeleton aria-hidden="true" className="h-10 w-full" />
        <Skeleton aria-hidden="true" className="h-10 w-2/3" />
      </div>
    );
  if (entries.isError) return <LoadFailure error={entries.error} retry={entries.refetch} />;

  return (
    <div className="grid gap-3">
      {lockedNote && (
        <p role="note" className="rounded-lg border border-border bg-muted px-3.5 py-2.5 text-xs text-foreground">
          {lockedNote}
        </p>
      )}
      {entries.data.length === 0 ? (
        <EmptyState compact icon={GlobeLockIcon} title={t.emptyList} description={t.emptyHint} />
      ) : (
        <ul aria-label={t.listAria} className="divide-y divide-border rounded-lg border border-border">
          {entries.data.map((entry) => (
            <li key={entry.id} className="flex min-h-11 items-center gap-2 py-1.5 pr-1.5 pl-3">
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5">
                <code className="font-mono text-xs break-all text-foreground">{entry.rule}</code>
                {entry.note && <span className="min-w-0 text-xs text-muted-foreground">{entry.note}</span>}
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                  {formatDayTime(entry.createdAt)}
                </span>
              </span>
              {editable && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t.removeAria(entry.rule)}
                  disabled={remove.isPending}
                  onClick={() => {
                    remove.reset();
                    setRemoving(entry);
                  }}
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        // Gợi ý và lỗi chỉ nằm dưới ô Mục mạng; nút Thêm canh theo đáy ô nhập (sau nhãn) chứ không theo đáy gợi ý.
        <form
          noValidate
          onSubmit={onAdd}
          className="grid items-start gap-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
        >
          <Field invalid={ruleError !== null}>
            <FieldLabel htmlFor={ids.rule}>{t.ruleLabel}</FieldLabel>
            <Input id={ids.rule} name="rule" placeholder="api.example.com:443" className="font-mono" />
            {ruleError ? <FieldError>{ruleError}</FieldError> : <FieldHint>{t.ruleHint}</FieldHint>}
          </Field>
          <Field>
            <FieldLabel htmlFor={ids.note}>{t.noteLabel}</FieldLabel>
            <Input id={ids.note} name="note" placeholder={t.notePh} />
          </Field>
          <Button type="submit" variant="outline" className="sm:mt-6.5" disabled={add.isPending}>
            <PlusIcon aria-hidden="true" />
            {add.isPending ? t.addingBtn : t.addBtn}
          </Button>
        </form>
      )}
      {add.isError && <Alert variant="destructive">{apiErrorMessage(add.error)}</Alert>}
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setRemoving(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t.removeTitle(removing?.rule ?? "")}</DialogTitle>
            <DialogDescription>{projectId ? t.removeHintProject : t.removeHintOrg}</DialogDescription>
          </DialogHeader>
          {remove.isError && <Alert variant="destructive">{apiErrorMessage(remove.error)}</Alert>}
          <DialogActions>
            <Button variant="outline" disabled={remove.isPending} onClick={() => setRemoving(null)}>
              {t.cancel}
            </Button>
            <Button
              variant="destructive-solid"
              disabled={remove.isPending}
              onClick={() => removing && remove.mutate(removing.id)}
            >
              {remove.isPending ? t.removing : t.remove}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </div>
  );
}
