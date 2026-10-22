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
import { Label } from "@xdev-hive/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Toggle } from "@/components/toggle.tsx";
import {
  type ContextMigration,
  type ContextProject,
  type ContextTarget,
  type ContextTargetStatus,
  contextDisable,
  contextEnable,
  contextMigrate,
  contextResolve,
  contextSaveSource,
  contextStatus,
} from "@/lib/context-sync.ts";
import { folderKey, shortPath } from "@/lib/folder.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { errorText } from "@/lib/tauri.ts";

/** Một thư mục dự án chọn được; `projectId` là id dự án trên hub khi thư mục đã gắn. */
export interface ContextCandidate {
  folder: string;
  projectId: string | null;
}

interface Text {
  title: string;
  lead: string;
  project: string;
  noProject: string;
  loading: string;
  enable: string;
  enabledLabel: string;
  disableTitle: string;
  disableBody: string;
  disable: string;
  cancel: string;
  off: string;
  source: string;
  sourceHint: string;
  save: string;
  saved: string;
  tokens: (source: string, block: string) => string;
  targets: string;
  status: Record<ContextTargetStatus, string>;
  noReason: string;
  compare: string;
  compareHint: (path: string) => string;
  fileVersion: string;
  sourceVersion: string;
  keepFile: string;
  keepSource: string;
  locked: string;
  migrateTitle: string;
  migrateLead: (files: number) => string;
  migrateDraft: string;
  migrate: string;
  later: string;
}

const text: Dict<Text> = {
  vi: {
    title: "Ngữ cảnh dùng chung",
    lead: "Một nguồn ngữ cảnh cho mỗi dự án, ghi vào file mà Claude Code, Codex, Gemini và Antigravity tự đọc. App chỉ sửa khối do xDev Hive đánh dấu.",
    project: "Dự án",
    noProject: "Chưa có dự án nào trên máy để bật.",
    loading: "Đang đọc ngữ cảnh…",
    enable: "Bật ngữ cảnh dùng chung",
    enabledLabel: "Dùng chung ngữ cảnh cho dự án này",
    disableTitle: "Tắt ngữ cảnh dùng chung?",
    disableBody:
      "App gỡ khối của xDev Hive khỏi mọi file đích và chuyển file do app tự tạo vào thùng rác. Phần bạn tự viết trong các file đó được giữ nguyên.",
    disable: "Tắt",
    cancel: "Huỷ",
    off: "Dự án này chưa dùng chung ngữ cảnh.",
    source: "Nguồn ngữ cảnh",
    sourceHint: "Lưu sẽ thay nguồn hiện tại bằng nội dung ở đây rồi đồng bộ sang các file đích.",
    save: "Lưu và đồng bộ",
    saved: "Đã lưu nguồn và đồng bộ.",
    tokens: (source, block) => `Nguồn ${source} token · khối ghi vào file ${block} token (ước tính)`,
    targets: "File đích",
    status: { ok: "Đúng", stale: "Lệch", conflict: "Xung đột", skipped: "Bỏ qua" },
    noReason: "Không có ghi chú.",
    compare: "So sánh bản file và bản nguồn",
    compareHint: (path) => `${path} có nội dung khác bản app ghi lần trước. Chọn bản giữ lại; bản kia được sao lưu.`,
    fileVersion: "Bản trong file",
    sourceVersion: "Bản từ nguồn",
    keepFile: "Giữ bản file",
    keepSource: "Giữ bản nguồn",
    locked: "Bộ tối ưu đang chạy nên app chưa ghi file. Thử lại sau ít phút.",
    migrateTitle: "Chuyển từ cách chia sẻ memory cũ",
    migrateLead: (files) => `Dự án đang chia sẻ ${files} file memory kiểu cũ. Xem bản nháp bên dưới trước khi chuyển.`,
    migrateDraft: "Bản nháp nguồn mới",
    migrate: "Chuyển sang nguồn mới",
    later: "Để sau",
  },
  en: {
    title: "Shared context",
    lead: "One context source per project, written to the files Claude Code, Codex, Gemini and Antigravity read on their own. The app only edits the block xDev Hive marks.",
    project: "Project",
    noProject: "No project on this machine to turn on.",
    loading: "Reading context…",
    enable: "Turn on shared context",
    enabledLabel: "Share context for this project",
    disableTitle: "Turn off shared context?",
    disableBody:
      "The app removes the xDev Hive block from every target file and moves files it created to the trash. Anything you wrote in those files stays.",
    disable: "Turn off",
    cancel: "Cancel",
    off: "This project does not share context yet.",
    source: "Context source",
    sourceHint: "Saving replaces the current source with this text, then syncs the target files.",
    save: "Save and sync",
    saved: "Source saved and synced.",
    tokens: (source, block) => `Source ${source} tokens · block written to files ${block} tokens (estimate)`,
    targets: "Target files",
    status: { ok: "Up to date", stale: "Out of date", conflict: "Conflict", skipped: "Skipped" },
    noReason: "No note.",
    compare: "Compare file and source",
    compareHint: (path) =>
      `${path} differs from what the app wrote last time. Pick the version to keep; the other is backed up.`,
    fileVersion: "Version in the file",
    sourceVersion: "Version from the source",
    keepFile: "Keep file version",
    keepSource: "Keep source version",
    locked: "The optimizer is running, so the app has not written files yet. Try again in a few minutes.",
    migrateTitle: "Move from the old memory sharing",
    migrateLead: (files) =>
      `This project shares ${files} memory files the old way. Review the draft below before moving.`,
    migrateDraft: "Draft of the new source",
    migrate: "Move to the new source",
    later: "Later",
  },
};

const TONE: Record<ContextTargetStatus, "ok" | "warn" | "bad" | "neutral"> = {
  ok: "ok",
  stale: "warn",
  conflict: "bad",
  skipped: "neutral",
};

const CLI_NAME: Record<ContextTarget["id"], string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  antigravity: "Antigravity",
};

/**
 * Mục "Ngữ cảnh dùng chung" của màn Memory (spec 029 US1): bật/tắt theo dự án, soạn nguồn, theo dõi file đích, giải quyết
 * xung đột và chuyển từ cách chia sẻ memory cũ. Mọi thay đổi đi qua lệnh `context_*`; app không tự ghi file đích.
 */
export function SharedContextSection({
  candidates,
  onMigrated,
}: {
  candidates: ContextCandidate[];
  /** Gọi sau khi chuyển từ chia sẻ cũ: màn Memory đọc lại kho vì cách chia sẻ cũ đã tắt. */
  onMigrated?: () => void;
}) {
  const t = useT(text);
  const lang = useLang();
  const [projects, setProjects] = useState<ContextProject[] | null>(null);
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [source, setSource] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const [migration, setMigration] = useState<ContextMigration | null>(null);
  // Lệnh chậm của dự án cũ không được ghi đè màn khi người dùng đã chuyển sang dự án khác.
  const generation = useRef(0);
  const projectId = useId();
  const sourceId = useId();

  const reload = useCallback(async () => {
    try {
      setProjects((await contextStatus()).projects);
      setError("");
    } catch (e) {
      setProjects([]);
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!folder && candidates[0]) setFolder(candidates[0].folder);
  }, [candidates, folder]);

  const candidate = candidates.find((c) => c.folder === folder);
  const current = projects?.find((p) => folderKey(p.folder) === folderKey(folder)) ?? null;
  const enabled = current?.enabled === true;

  const replace = (next: ContextProject) =>
    setProjects((list) => [...(list ?? []).filter((p) => p.key !== next.key), next]);

  /** Chạy một lệnh ghi: khoá nút, bỏ kết quả nếu đã đổi dự án, báo lỗi bằng tiếng Việt của sidecar. */
  const run = async (action: () => Promise<void>) => {
    const mine = ++generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      if (mine === generation.current) setError(errorText(e));
    } finally {
      if (mine === generation.current) setBusy(false);
    }
  };

  const changeProject = (next: string) => {
    generation.current++;
    setFolder(next);
    setSource("");
    setNotice("");
    setError("");
    setBusy(false);
    setResolving(null);
    setMigration(null);
    setConfirmOff(false);
  };

  const turnOn = () =>
    run(async () => {
      if (!candidate) return;
      const result = await contextEnable(candidate.folder, candidate.projectId ?? undefined);
      const { migration: offer, ...project } = result;
      replace(project);
      setMigration(offer ?? null);
    });

  const turnOff = () =>
    run(async () => {
      if (!current) return;
      await contextDisable(current.key);
      setConfirmOff(false);
      setMigration(null);
      setResolving(null);
      await reload();
    });

  const save = () =>
    run(async () => {
      if (!current) return;
      replace(await contextSaveSource(current.key, source));
      setNotice(t.saved);
    });

  const resolve = (target: ContextTarget["id"], keep: "file" | "source") =>
    run(async () => {
      if (!current) return;
      replace(await contextResolve(current.key, target, keep));
      setResolving(null);
    });

  const migrate = () =>
    run(async () => {
      if (!current) return;
      await contextMigrate(current.key, true);
      setMigration(null);
      await reload();
      onMigrated?.();
    });

  const conflict = current?.targets.find((x) => x.id === resolving && x.status === "conflict" && x.conflict);
  const number = (n: number) => n.toLocaleString(lang);

  return (
    <section aria-label={t.title} className="min-w-0 space-y-4 rounded-lg border p-4">
      <div>
        <h2 className="text-sm font-semibold">{t.title}</h2>
        <p className="text-sm text-muted-foreground">{t.lead}</p>
      </div>
      {error && <Alert variant="destructive">{error}</Alert>}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {projects === null && (
        <p role="status" className="text-sm text-muted-foreground">
          {t.loading}
        </p>
      )}
      {projects !== null && candidates.length === 0 && <p className="text-sm text-muted-foreground">{t.noProject}</p>}
      {projects !== null && candidates.length > 0 && (
        <>
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor={projectId}>{t.project}</Label>
            <NativeSelect id={projectId} value={folder} disabled={busy} onChange={(e) => changeProject(e.target.value)}>
              {candidates.map((c) => (
                <NativeSelectOption key={c.folder} value={c.folder}>
                  {shortPath(c.folder)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          {enabled ? (
            <div className="flex items-center gap-2 text-sm">
              <Toggle on label={t.enabledLabel} disabled={busy} onChange={() => setConfirmOff(true)} />
              <span>{t.enabledLabel}</span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={busy || !candidate} onClick={() => void turnOn()}>
                {t.enable}
              </Button>
              <span className="text-xs text-muted-foreground">{t.off}</span>
            </div>
          )}
          {migration && (
            <section aria-label={t.migrateTitle} className="space-y-3 rounded-lg border p-3">
              <h3 className="text-sm font-medium">{t.migrateTitle}</h3>
              <p className="text-sm text-muted-foreground">{t.migrateLead(migration.files.length)}</p>
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {migration.files.map((f) => (
                  <li key={f} className="break-all">
                    {f}
                  </li>
                ))}
              </ul>
              <Textarea aria-label={t.migrateDraft} className="min-h-40 font-mono" value={migration.draft} readOnly />
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy} onClick={() => void migrate()}>
                  {t.migrate}
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setMigration(null)}>
                  {t.later}
                </Button>
              </div>
            </section>
          )}
          {current && enabled && (
            <>
              {current.locked && <Alert>{t.locked}</Alert>}
              <div className="space-y-2">
                <Label htmlFor={sourceId}>{t.source}</Label>
                <Textarea
                  id={sourceId}
                  className="min-h-40 font-mono"
                  value={source}
                  disabled={busy}
                  onChange={(e) => setSource(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">{t.sourceHint}</p>
                <p className="text-xs text-muted-foreground">
                  {t.tokens(number(current.sourceTokens), number(current.blockTokens))}
                </p>
                <Button disabled={busy || source.trim() === ""} onClick={() => void save()}>
                  {t.save}
                </Button>
              </div>
              <section aria-label={t.targets} className="space-y-2">
                <h3 className="text-sm font-medium">{t.targets}</h3>
                <ul className="divide-y rounded-lg border">
                  {current.targets.map((target) => (
                    <li key={target.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                      <span className="font-medium">{CLI_NAME[target.id]}</span>
                      <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">{target.path}</span>
                      <Pill tone={TONE[target.status]} dot>
                        {t.status[target.status]}
                      </Pill>
                      {target.reason && (
                        <span className="basis-full text-xs text-muted-foreground">{target.reason}</span>
                      )}
                      {target.status === "conflict" && target.conflict && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="ml-auto"
                          disabled={busy}
                          aria-pressed={resolving === target.id}
                          aria-label={`${t.compare}: ${CLI_NAME[target.id]}`}
                          onClick={() => setResolving(resolving === target.id ? null : target.id)}
                        >
                          {t.compare}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
              {conflict?.conflict && (
                <section aria-label={t.compare} className="space-y-3 rounded-lg border p-3">
                  <h3 className="text-sm font-medium">{t.compare}</h3>
                  <p className="text-sm text-muted-foreground">{t.compareHint(conflict.path)}</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Version title={t.fileVersion} body={conflict.conflict.file} />
                    <Version title={t.sourceVersion} body={conflict.conflict.source} />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={busy} onClick={() => void resolve(conflict.id, "file")}>
                      {t.keepFile}
                    </Button>
                    <Button variant="outline" disabled={busy} onClick={() => void resolve(conflict.id, "source")}>
                      {t.keepSource}
                    </Button>
                    <Button variant="ghost" disabled={busy} onClick={() => setResolving(null)}>
                      {t.cancel}
                    </Button>
                  </div>
                </section>
              )}
            </>
          )}
        </>
      )}
      <Dialog open={confirmOff} onOpenChange={(open) => !busy && setConfirmOff(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.disableTitle}</DialogTitle>
            <DialogDescription>{t.disableBody}</DialogDescription>
          </DialogHeader>
          <DialogActions>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmOff(false)}>
              {t.cancel}
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void turnOff()}>
              {t.disable}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Version({ title, body }: { title: string; body: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <h4 className="text-xs font-medium">{title}</h4>
      <Textarea aria-label={title} readOnly className="min-h-32 font-mono text-xs" value={body} />
    </div>
  );
}
