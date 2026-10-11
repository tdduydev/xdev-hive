import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Project, Task } from "@xdev-hive/contracts";
import { type FormEvent, useId, useState } from "react";
import { apiErrorMessage, formError } from "../lib/api-errors.ts";
import { CLI_LABEL } from "../lib/run-view.ts";
import { useOrg } from "../shell/org-context.ts";
import { Icon } from "./icons.tsx";
import { Alert } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog.tsx";
import { Field, FieldError, FieldLabel } from "./ui/field.tsx";
import { Input } from "./ui/input.tsx";
import { Select } from "./ui/select.tsx";
import { Textarea } from "./ui/textarea.tsx";

type Cli = "claude" | "codex" | "gemini";
const CLIS: Cli[] = ["claude", "codex", "gemini"];
const isCli = (v: string): v is Cli => (CLIS as string[]).includes(v);

/** Nút "Tạo việc" và dialog của nó. `projects` là dự án đang hoạt động; chỉ một dự án thì không hỏi lại. */
export function CreateTaskButton({ projects }: { projects: Project[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)} disabled={projects.length === 0}>
        <Icon name="plus" />
        Tạo việc
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <CreateTaskForm projects={projects} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

interface Created {
  task: Task;
  /** Lỗi khi giao cho agent ngay sau khi tạo; việc vẫn đã được tạo. */
  startError: string | null;
}

/** Nội dung dialog nằm trong popup để mỗi lần mở lại là form mới, không còn chữ và lỗi của lần trước. */
function CreateTaskForm({ projects, onDone }: { projects: Project[]; onDone: () => void }) {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const ids = { project: useId(), body: useId(), cli: useId(), start: useId() };
  const [titleError, setTitleError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  const create = useMutation({
    mutationFn: async (input: { projectId: string; title: string; body: string; cli: Cli | null; start: boolean }) => {
      const task = await api.tasks.create.call({
        projectId: input.projectId,
        title: input.title,
        body: input.body,
        ...(input.cli ? { preferredCli: input.cli } : {}),
      });
      if (!input.start) return { task, startError: null };
      try {
        await api.runs.start.call({ taskId: task.id });
        return { task, startError: null };
      } catch (error) {
        return { task, startError: apiErrorMessage(error) };
      }
    },
    onSuccess: async (result) => {
      await Promise.all(
        [api.tasks.key(), api.runs.key()].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      if (result.startError) setCreated(result);
      else onDone();
    },
    onError: (error) => {
      const { field, message } = formError(error);
      if (field === "title") setTitleError(message);
      else setFailure(message);
    },
  });

  if (created) {
    return (
      <div className="grid gap-3.5">
        <DialogTitle>Đã tạo {created.task.key}</DialogTitle>
        <Alert>Việc đã được tạo nhưng chưa giao được cho agent: {created.startError}</Alert>
        <DialogActions>
          <Button variant="primary" onClick={onDone}>
            Đóng
          </Button>
        </DialogActions>
      </div>
    );
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    setFailure(null);
    if (!title) {
      setTitleError("Tiêu đề không được để trống.");
      return;
    }
    setTitleError(null);
    const cli = String(form.get("cli") ?? "");
    create.mutate({
      projectId: String(form.get("projectId") ?? projects[0]?.id ?? ""),
      title,
      body: String(form.get("body") ?? ""),
      cli: isCli(cli) ? cli : null,
      start: form.get("start") === "on",
    });
  }

  const busy = create.isPending;
  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-3.5">
      <DialogTitle>Tạo việc</DialogTitle>
      <DialogDescription>
        Agent nhận tiêu đề và mô tả làm đề bài, rồi mở PR trên nhánh ai/&lt;mã việc&gt;.
      </DialogDescription>
      {projects.length > 1 ? (
        <div className="grid gap-1.5">
          <label htmlFor={ids.project} className="text-label font-medium text-ink">
            Dự án
          </label>
          <Select id={ids.project} name="projectId" disabled={busy}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.key})
              </option>
            ))}
          </Select>
        </div>
      ) : (
        <input type="hidden" name="projectId" value={projects[0]?.id ?? ""} />
      )}
      <Field invalid={titleError !== null}>
        <FieldLabel>Tiêu đề</FieldLabel>
        <Input
          name="title"
          maxLength={200}
          placeholder="Ví dụ: Sửa làm tròn tiền trong hoá đơn VAT"
          disabled={busy}
          autoFocus
        />
        {titleError && <FieldError>{titleError}</FieldError>}
      </Field>
      <div className="grid gap-1.5">
        <label htmlFor={ids.body} className="text-label font-medium text-ink">
          Mô tả
        </label>
        <Textarea
          id={ids.body}
          name="body"
          rows={5}
          maxLength={50_000}
          placeholder="Bối cảnh, việc cần làm, cách kiểm"
          disabled={busy}
        />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor={ids.cli} className="text-label font-medium text-ink">
          Agent
        </label>
        <Select id={ids.cli} name="cli" defaultValue="" disabled={busy}>
          <option value="">Máy nào rảnh có CLI là nhận</option>
          {CLIS.map((c) => (
            <option key={c} value={c}>
              {CLI_LABEL[c]}
            </option>
          ))}
        </Select>
      </div>
      <label htmlFor={ids.start} className="flex items-center gap-2 text-label text-ink">
        <input
          id={ids.start}
          type="checkbox"
          name="start"
          defaultChecked
          disabled={busy}
          className="size-4 accent-accent"
        />
        Giao cho agent ngay sau khi tạo
      </label>
      {failure && <Alert>{failure}</Alert>}
      <DialogActions>
        <Button onClick={onDone}>Huỷ</Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Đang tạo…" : "Tạo việc"}
        </Button>
      </DialogActions>
    </form>
  );
}
