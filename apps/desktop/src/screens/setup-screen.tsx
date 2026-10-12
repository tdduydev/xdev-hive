import { CopyIcon, LoaderCircleIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { FolderForm } from "@/components/folder-form.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogActions,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Pill, type PillProps } from "@/components/ui/pill.tsx";
import { Table, TableBody, TableHeader, TableRow, Td, Th } from "@/components/ui/table.tsx";
import { useFolder } from "@/lib/folder.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import {
  type CheckItem,
  type CheckKind,
  type CheckStatus,
  type InstallResult,
  needsAction,
  readiness,
  runInstall,
  scanEnvironment,
  sortChecks,
} from "@/lib/setup.ts";
import { errorText } from "@/lib/tauri.ts";
import { cn } from "@/lib/utils.ts";

const text: Dict<{
  lead: string;
  folderHint: string;
  check: string;
  recheck: string;
  scanning: string;
  score: (ready: number, required: number) => string;
  all: string;
  todo: (n: number) => string;
  filter: string;
  item: string;
  type: string;
  needs: string;
  have: string;
  status: string;
  kinds: Record<CheckKind, string>;
  statuses: Record<CheckStatus, string>;
  thisMachine: string;
  because: string;
  installCmd: string;
  cmdNote: string;
  adminNote: string;
  copy: string;
  copied: string;
  run: string;
  confirmTitle: string;
  confirmBody: string;
  cancel: string;
  running: string;
  ranOk: string;
  ranFail: (code: string) => string;
  nothingToDo: string;
  pick: string;
}> = {
  vi: {
    lead: "Những gì máy này cần để làm việc: công cụ chung của worker và yêu cầu của thư mục dự án (go.mod, package.json, .nvmrc).",
    folderHint: "Để trống thì chỉ kiểm công cụ trên máy.",
    check: "Kiểm tra",
    recheck: "Kiểm tra lại",
    scanning: "Đang kiểm tra máy…",
    score: (ready, required) => `${ready} trên ${required} mục bắt buộc đã đủ`,
    all: "Tất cả",
    todo: (n) => `Cần xử lý (${n})`,
    filter: "Lọc theo trạng thái",
    item: "Mục",
    type: "Loại",
    needs: "Cần",
    have: "Máy có",
    status: "Trạng thái",
    kinds: { cli: "Agent CLI", runtime: "Runtime", tool: "Công cụ", dependency: "Thư viện dự án" },
    statuses: { ok: "Đủ", outdated: "Cũ", mismatch: "Khác bản", missing: "Thiếu", optional: "Không bắt buộc" },
    thisMachine: "máy này",
    because: "Vì:",
    installCmd: "Lệnh cài",
    cmdNote:
      "App chạy lệnh sau khi bạn bấm Chạy và xác nhận; lệnh cần quyền quản trị hoặc cần shell thì chỉ chép cho bạn.",
    adminNote: "Lệnh này cần quyền quản trị hoặc cần shell: hãy chép và chạy trong terminal.",
    copy: "Chép lệnh",
    copied: "Đã chép",
    run: "Chạy",
    confirmTitle: "Chạy lệnh cài?",
    confirmBody: "App sẽ chạy đúng lệnh này trên máy của bạn:",
    cancel: "Huỷ",
    running: "Đang chạy…",
    ranOk: "Lệnh chạy xong. Đã kiểm tra lại.",
    ranFail: (code) => `Lệnh lỗi (mã ${code}).`,
    nothingToDo: "Mục này đã đủ, không cần làm gì.",
    pick: "Chọn một mục để xem lệnh cài.",
  },
  en: {
    lead: "What this machine needs: the worker's common tools and the project folder's requirements (go.mod, package.json, .nvmrc).",
    folderHint: "Leave empty to check only the tools on this machine.",
    check: "Check",
    recheck: "Re-check",
    scanning: "Checking this machine…",
    score: (ready, required) => `${ready} of ${required} required items ready`,
    all: "All",
    todo: (n) => `Needs action (${n})`,
    filter: "Filter by status",
    item: "Item",
    type: "Type",
    needs: "Needs",
    have: "Have",
    status: "Status",
    kinds: { cli: "Agent CLI", runtime: "Runtime", tool: "Tool", dependency: "Project libraries" },
    statuses: {
      ok: "OK",
      outdated: "Outdated",
      mismatch: "Different version",
      missing: "Missing",
      optional: "Optional",
    },
    thisMachine: "this machine",
    because: "Because:",
    installCmd: "Install command",
    cmdNote:
      "The app runs it after you press Run and confirm; commands that need admin rights or a shell are copied for you instead.",
    adminNote: "This command needs admin rights or a shell: copy it and run it in a terminal.",
    copy: "Copy",
    copied: "Copied",
    run: "Run",
    confirmTitle: "Run the install command?",
    confirmBody: "The app will run exactly this command on your machine:",
    cancel: "Cancel",
    running: "Running…",
    ranOk: "The command finished. Checked again.",
    ranFail: (code) => `The command failed (code ${code}).`,
    nothingToDo: "This item is ready; nothing to do.",
    pick: "Pick an item to see its install command.",
  },
};

const TONE: Record<CheckStatus, NonNullable<PillProps["tone"]>> = {
  ok: "ok",
  outdated: "warn",
  mismatch: "warn",
  missing: "bad",
  optional: "neutral",
};
/** Vòng điểm sẵn sàng như AppSetup.dc.html; màu theo tỉ lệ, xanh khi đủ hết. */
function ScoreRing({ ready, required, label }: { ready: number; required: number; label: string }) {
  const pct = required ? Math.round((ready / required) * 100) : 100;
  return (
    <div
      role="img"
      aria-label={label}
      className="inline-flex size-18 shrink-0 items-center justify-center rounded-full"
      style={{
        background: `conic-gradient(var(${pct === 100 ? "--success" : "--primary"}) ${pct}%, var(--muted) 0)`,
      }}
    >
      <span className="inline-flex size-14 items-center justify-center rounded-full bg-background font-mono text-[15px] font-semibold">
        {ready}/{required}
      </span>
    </div>
  );
}

/** Màn Môi trường (AppSetup.dc.html): dò công cụ và yêu cầu của thư mục dự án, chép hoặc chạy lệnh cài. */
export function SetupScreen() {
  const t = useT(text);
  const [folder, setFolder] = useFolder();
  const [draft, setDraft] = useState(folder);
  const [items, setItems] = useState<CheckItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [onlyTodo, setOnlyTodo] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const scan = useCallback(async (dir: string) => {
    setScanning(true);
    setError(null);
    try {
      const found = sortChecks(await scanEnvironment(dir));
      setItems(found);
      setSelectedId((id) => (id && found.some((i) => i.id === id) ? id : (found[0]?.id ?? null)));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setScanning(false);
    }
  }, []);

  // Quét khi mở màn và mỗi khi thư mục làm việc đổi (chọn ở AppNav hoặc gửi ô nhập dưới đây).
  useEffect(() => {
    setDraft(folder);
    void scan(folder);
  }, [scan, folder]);

  const { ready, required } = readiness(items ?? []);
  const todo = (items ?? []).filter(needsAction);
  const shown = onlyTodo ? todo : (items ?? []);
  const selected = items?.find((i) => i.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-3.5">
      <header className="flex flex-wrap items-center gap-4">
        <ScoreRing ready={ready} required={required} label={t.score(ready, required)} />
        <p className="min-w-60 flex-1 text-[13px] text-muted-foreground">{t.lead}</p>
        <Button variant="outline" size="sm" onClick={() => void scan(folder)} disabled={scanning}>
          <RefreshCwIcon aria-hidden="true" className={cn(scanning && "animate-spin")} />
          {t.recheck}
        </Button>
      </header>

      <FolderForm
        value={draft}
        onChange={setDraft}
        onSubmit={(dir) => (dir.trim() === folder ? void scan(folder) : setFolder(dir))}
        submitLabel={t.check}
        hint={t.folderHint}
        busy={scanning}
      />

      {error && (
        <p role="alert" className="rounded-lg bg-destructive-soft px-3 py-2 text-[13px] text-destructive">
          {error}
        </p>
      )}
      {!items && scanning && (
        <p role="status" className="flex items-center gap-2 text-muted-foreground">
          <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" />
          {t.scanning}
        </p>
      )}

      {items && (
        <div className="flex flex-col items-start gap-3.5 min-[1000px]:flex-row">
          <section className="w-full min-w-0 min-[1000px]:flex-[3]">
            <fieldset className="mb-2 inline-flex gap-1 rounded-lg bg-muted p-0.5">
              <legend className="sr-only">{t.filter}</legend>
              {[false, true].map((todoOnly) => (
                <button
                  key={String(todoOnly)}
                  type="button"
                  aria-pressed={onlyTodo === todoOnly}
                  onClick={() => setOnlyTodo(todoOnly)}
                  className="h-7 cursor-pointer rounded-md px-2.5 text-xs font-medium text-muted-foreground aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-sm"
                >
                  {todoOnly ? t.todo(todo.length) : t.all}
                </button>
              ))}
            </fieldset>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <Th>{t.item}</Th>
                    <Th>{t.type}</Th>
                    <Th>{t.needs}</Th>
                    <Th>{t.have}</Th>
                    <Th>{t.status}</Th>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((item) => (
                    <TableRow
                      key={item.id}
                      aria-selected={item.id === selectedId}
                      className="cursor-pointer aria-selected:bg-accent/60"
                      onClick={() => setSelectedId(item.id)}
                    >
                      <Td>
                        <button
                          type="button"
                          className="flex cursor-pointer flex-col text-left"
                          onClick={() => setSelectedId(item.id)}
                        >
                          <span className="font-mono text-[13px] font-medium whitespace-nowrap">{item.name}</span>
                          <span className="text-xs text-muted-foreground">{item.source || t.thisMachine}</span>
                        </button>
                      </Td>
                      <Td className="text-[13px] whitespace-nowrap">{t.kinds[item.kind]}</Td>
                      <Td className="font-mono text-xs">{item.need ?? "—"}</Td>
                      <Td className="font-mono text-xs">{item.have ?? "—"}</Td>
                      <Td>
                        <Pill tone={TONE[item.status]} dot>
                          {t.statuses[item.status]}
                        </Pill>
                      </Td>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
          <aside className="w-full min-w-0 rounded-xl border bg-card text-card-foreground min-[1000px]:flex-[2]">
            {selected ? (
              <Detail key={selected.id} item={selected} folder={folder} onDone={() => scan(folder)} />
            ) : (
              <p className="p-4 text-muted-foreground">{t.pick}</p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function Detail({ item, folder, onDone }: { item: CheckItem; folder: string; onDone: () => Promise<void> }) {
  const t = useT(text);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<InstallResult | { error: string } | null>(null);
  const install = item.install;

  async function copy() {
    if (!install) return;
    try {
      await navigator.clipboard.writeText(install.command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function run() {
    setConfirming(false);
    setRunning(true);
    setResult(null);
    try {
      setResult(await runInstall(item.id, folder));
      await onDone();
    } catch (e) {
      setResult({ error: errorText(e) });
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-1.5 border-b px-3.5 py-3">
        <div className="flex items-center gap-1.5">
          <Pill>{t.kinds[item.kind]}</Pill>
          <Pill tone={TONE[item.status]}>{t.statuses[item.status]}</Pill>
        </div>
        <h2 className="font-mono text-[15px] font-semibold">{item.name}</h2>
        <p className="text-[12.5px] text-muted-foreground">
          {t.needs} <span className="font-mono text-foreground">{item.need ?? "—"}</span> · {t.have.toLowerCase()}{" "}
          <span className="font-mono text-foreground">{item.have ?? "—"}</span>
        </p>
        <p className="text-[12.5px] text-muted-foreground">
          {t.because} {item.source || t.thisMachine}
        </p>
      </div>
      <div className="flex flex-col gap-2.5 px-3.5 py-3">
        {install ? (
          <>
            <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t.installCmd}</span>
            <pre className="m-0 rounded-lg bg-brand-navy px-3 py-2.5 font-mono text-[12.5px] whitespace-pre-wrap text-slate-200">
              {install.command}
            </pre>
            <p className="text-xs text-muted-foreground">{install.runnable ? t.cmdNote : t.adminNote}</p>
            <div className="flex justify-end gap-1.5">
              <Button variant="outline" size="sm" onClick={copy}>
                <CopyIcon aria-hidden="true" />
                {copied ? t.copied : t.copy}
              </Button>
              {install.runnable && (
                <Button size="sm" onClick={() => setConfirming(true)} disabled={running}>
                  {running ? (
                    <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
                  ) : (
                    <PlayIcon aria-hidden="true" />
                  )}
                  {running ? t.running : t.run}
                </Button>
              )}
            </div>
            {result && (
              <div role="status" className="flex flex-col gap-1.5">
                <p className={cn("text-[13px]", "error" in result || !result.ok ? "text-destructive" : "text-success")}>
                  {"error" in result ? result.error : result.ok ? t.ranOk : t.ranFail(String(result.code ?? "?"))}
                </p>
                {"output" in result && result.output && (
                  <pre className="m-0 max-h-48 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap">
                    {result.output}
                  </pre>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="text-[13px] text-muted-foreground">{t.nothingToDo}</p>
        )}
      </div>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.confirmTitle}</DialogTitle>
            <DialogDescription>{t.confirmBody}</DialogDescription>
          </DialogHeader>
          <pre className="m-0 rounded-lg bg-muted px-3 py-2 font-mono text-[12.5px] whitespace-pre-wrap">
            {install?.command}
          </pre>
          <DialogActions>
            <DialogClose render={<Button variant="outline" />}>{t.cancel}</DialogClose>
            <Button onClick={run}>{t.run}</Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </>
  );
}
