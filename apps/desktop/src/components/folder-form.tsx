import type { FormEvent } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { saveFolder } from "@/lib/folder.ts";
import { type Dict, useT } from "@/lib/i18n.ts";

const text: Dict<{ folder: string }> = { vi: { folder: "Thư mục dự án" }, en: { folder: "Project folder" } };

/** Ô nhập thư mục dự án dùng chung; gửi thì nhớ thư mục cho các màn khác. */
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
    saveFolder(value);
    onSubmit(value);
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <div className="flex min-w-64 flex-1 flex-col gap-1.5">
        <Label htmlFor="project-folder">{t.folder}</Label>
        <Input
          id="project-folder"
          className="font-mono text-[13px] md:text-[13px]"
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
