import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { egressRule } from "@xdev-hive/contracts";
import { type FormEvent, useId, useState } from "react";
import { apiErrorMessage } from "../lib/api-errors.ts";
import { formatDayTime } from "../lib/format.ts";
import { useOrg } from "../shell/org-context.ts";
import { Alert } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { Field, FieldError, FieldHint, FieldLabel } from "./ui/field.tsx";
import { Input } from "./ui/input.tsx";
import { LoadFailure, LoadingState } from "./ui/query-state.tsx";

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
  const queryClient = useQueryClient();
  const ids = { rule: useId(), note: useId() };
  const scope = projectId ? { projectId } : {};
  const entries = useQuery(api.sandbox.listAllowlist.queryOptions({ input: scope }));
  const [ruleError, setRuleError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: api.sandbox.key() });
  const add = useMutation({
    mutationFn: (input: { rule: string; note?: string }) => api.sandbox.addAllowlist.call({ ...scope, ...input }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (entryId: string) => api.sandbox.removeAllowlist.call({ ...scope, entryId }),
    onSuccess: refresh,
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
      setRuleError(parsed.error.issues[0]?.message ?? "Mục mạng không hợp lệ.");
      return;
    }
    setRuleError(null);
    add.mutate({ rule: parsed.data, ...(note ? { note } : {}) }, { onSuccess: () => form.reset() });
  }

  if (entries.isPending) return <LoadingState />;
  if (entries.isError) return <LoadFailure error={entries.error} retry={entries.refetch} />;

  return (
    <div className="grid gap-3">
      {lockedNote && (
        <p role="note" className="rounded-lg border border-border bg-muted px-3.5 py-2.5 text-xs text-foreground">
          {lockedNote}
        </p>
      )}
      {entries.data.length === 0 ? (
        <p className="text-xs text-muted-foreground">Chưa có mục nào.</p>
      ) : (
        <ul aria-label="Danh sách mục mạng" className="grid gap-1.5">
          {entries.data.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
              <code className="font-mono text-xs text-foreground">{entry.rule}</code>
              {entry.note && <span className="text-xs text-muted-foreground">{entry.note}</span>}
              <span className="ml-auto text-xs text-muted-foreground">{formatDayTime(entry.createdAt)}</span>
              {editable && (
                <Button
                  size="sm"
                  variant="destructive"
                  aria-label={`Xoá ${entry.rule}`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(entry.id)}
                >
                  Xoá
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {remove.isError && <Alert>{apiErrorMessage(remove.error)}</Alert>}
      {editable && (
        <form noValidate onSubmit={onAdd} className="grid gap-2.5 app:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <Field invalid={ruleError !== null}>
            <FieldLabel htmlFor={ids.rule}>Mục mạng</FieldLabel>
            <Input id={ids.rule} name="rule" placeholder="api.example.com:443" className="font-mono" />
            {ruleError ? (
              <FieldError>{ruleError}</FieldError>
            ) : (
              <FieldHint>Tên miền, *.tên-miền, IP hoặc CIDR; thêm :cổng nếu cần.</FieldHint>
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor={ids.note}>Ghi chú</FieldLabel>
            <Input id={ids.note} name="note" placeholder="Vì sao cần mở" />
          </Field>
          <div className="flex items-start pt-6">
            <Button type="submit" variant="default" disabled={add.isPending}>
              {add.isPending ? "Đang thêm…" : "Thêm"}
            </Button>
          </div>
        </form>
      )}
      {add.isError && <Alert>{apiErrorMessage(add.error)}</Alert>}
    </div>
  );
}
