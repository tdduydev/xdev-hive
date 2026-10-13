import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { Label } from "@xdev-hive/ui/label";
import type { FormEvent } from "react";
import { type Dict, useT } from "@/lib/i18n.ts";

const text: Dict<{ folder: string }> = { vi: { folder: "Thư mục dự án" }, en: { folder: "Project folder" } };

/** Ô nhập thư mục dự án dùng chung; màn gọi `onSubmit` để đổi thư mục chung (useFolder). */
export function FolderForm({
  value,
  onChange,
  onSubmit,
  submitLabel,
  hint,
  busy,
}: {
  value: string;
  onChange: (folder: string) => void;
  onSubmit: (folder: string) => void;
  submitLabel: string;
  hint: string;
  busy: boolean;
}) {
  const t = useT(text);
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit(value);
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <div className="flex min-w-64 flex-1 flex-col gap-1.5">
        <Label htmlFor="project-folder">{t.folder}</Label>
        <Input
          id="project-folder"
          className="font-mono text-sm md:text-sm"
          placeholder="~/Work/payment-api"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      <Button type="submit" variant="secondary" disabled={busy}>
        {submitLabel}
      </Button>
      <p className="basis-full text-xs text-muted-foreground">{hint}</p>
    </form>
  );
}
