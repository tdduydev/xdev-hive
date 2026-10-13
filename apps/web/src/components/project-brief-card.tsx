import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BRIEF_MAX_CHARS, type Project, type ProjectBrief } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Markdown } from "@xdev-hive/ui/markdown";
import { Textarea } from "@xdev-hive/ui/textarea";
import { useId, useState } from "react";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { briefBaseVersion, briefDrift, briefSaveMessage, isBriefConflict, shortSha } from "@/lib/brief.ts";
import { formatDayTime } from "@/lib/format.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { shortId } from "@/lib/run-view.ts";
import { useOrg } from "@/shell/org-context.ts";

const text: Dict<{
  loading: string;
  retry: string;
  empty: string;
  emptyHint: string;
  write: string;
  edit: string;
  refresh: string;
  refreshing: string;
  refreshRun: string;
  refreshQueued: string;
  version: string;
  commit: string;
  source: string;
  sourceAgent: string;
  sourceUser: string;
  updated: string;
  drift: (n: number) => string;
  contentLabel: string;
  save: string;
  saving: string;
  cancel: string;
  charCount: (n: number, max: number) => string;
}> = {
  vi: {
    loading: "Đang tải brief…",
    retry: "Thử lại",
    empty: "Dự án chưa có brief.",
    emptyHint: "Brief là bản tóm tắt repo (thư mục chính, lệnh build và test, quy ước) đưa vào prompt của mọi run.",
    write: "Viết tay",
    edit: "Sửa",
    refresh: "Làm mới",
    refreshing: "Đang giao…",
    refreshRun: "Run đang viết lại brief",
    refreshQueued: "Đã giao run viết lại brief.",
    version: "Phiên bản",
    commit: "Commit",
    source: "Nguồn",
    sourceAgent: "Agent",
    sourceUser: "Người",
    updated: "Cập nhật",
    drift: (n) => `Nhánh chính đã đi trước ${n} commit`,
    contentLabel: "Nội dung brief (Markdown)",
    save: "Lưu brief",
    saving: "Đang lưu…",
    cancel: "Huỷ",
    charCount: (n, max) => `${n}/${max} ký tự`,
  },
  en: {
    loading: "Loading brief…",
    retry: "Retry",
    empty: "This project has no brief yet.",
    emptyHint:
      "The brief summarizes the repo (main folders, build and test commands, conventions) and goes into every run's prompt.",
    write: "Write by hand",
    edit: "Edit",
    refresh: "Refresh",
    refreshing: "Queuing…",
    refreshRun: "Run rewriting the brief",
    refreshQueued: "Queued a run to rewrite the brief.",
    version: "Version",
    commit: "Commit",
    source: "Source",
    sourceAgent: "Agent",
    sourceUser: "Person",
    updated: "Updated",
    drift: (n) => `The main branch is ${n} commits ahead`,
    contentLabel: "Brief content (Markdown)",
    save: "Save brief",
    saving: "Saving…",
    cancel: "Cancel",
    charCount: (n, max) => `${n}/${max} characters`,
  },
};

/** Brief dự án (ADR 0022): xem, sửa tay và giao run viết lại. `canWrite` chỉ ẩn nút; hub kiểm lại quyền. */
export function ProjectBriefCard({ project, canWrite }: { project: Project; canWrite: boolean }) {
  const { api } = useOrg();
  const t = useT(text);
  const cache = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [queuedRun, setQueuedRun] = useState<string | null>(null);
  const brief = useQuery(api.briefs.get.queryOptions({ input: { project: project.key } }));
  const refresh = useMutation({
    ...api.briefs.refresh.mutationOptions(),
    onSuccess: async ({ runId }) => {
      setQueuedRun(runId);
      await cache.invalidateQueries({ queryKey: api.briefs.key() });
    },
  });

  if (brief.isPending) {
    return (
      <p aria-busy="true" className="text-sm text-muted-foreground">
        {t.loading}
      </p>
    );
  }
  if (brief.isError) {
    return (
      <Alert variant="destructive">
        {apiErrorMessage(brief.error)}
        <Button type="button" variant="outline" size="sm" onClick={() => brief.refetch()}>
          {t.retry}
        </Button>
      </Alert>
    );
  }

  const current = brief.data;
  const runningId = current?.refreshRunId ?? queuedRun;
  const drift = current ? briefDrift(current) : null;

  if (editing) {
    return (
      <BriefEditor
        project={project}
        brief={current}
        onClose={() => setEditing(false)}
        onSaved={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="grid gap-3">
      {drift !== null && (
        <p role="status" className="rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
          {t.drift(drift)}
        </p>
      )}
      {current ? (
        <>
          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <Meta term={t.version} detail={`v${current.version}`} />
            <Meta term={t.commit} detail={shortSha(current.commitSha)} mono />
            <Meta term={t.source} detail={current.source === "agent" ? t.sourceAgent : t.sourceUser} />
            <Meta term={t.updated} detail={formatDayTime(current.updatedAt)} />
          </dl>
          <div className="max-h-96 overflow-y-auto rounded-lg border border-border p-3">
            <Markdown content={current.content} />
          </div>
        </>
      ) : (
        <div className="grid gap-1 rounded-lg border border-dashed border-border p-4 text-sm">
          <strong className="font-medium text-foreground">{t.empty}</strong>
          <span className="text-xs text-muted-foreground">{t.emptyHint}</span>
        </div>
      )}
      {refresh.isError && <Alert variant="destructive">{apiErrorMessage(refresh.error)}</Alert>}
      {runningId ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t.refreshRun}:{" "}
          <Link to="/runs/$id" params={{ id: runningId }} className="font-mono text-primary hover:text-primary/90">
            {shortId(runningId)}
          </Link>
        </p>
      ) : null}
      {canWrite && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => setEditing(true)}>
            {current ? t.edit : t.write}
          </Button>
          <Button
            type="button"
            disabled={refresh.isPending || !!current?.refreshRunId}
            onClick={() => refresh.mutate({ project: project.key })}
          >
            {refresh.isPending ? t.refreshing : t.refresh}
          </Button>
        </div>
      )}
    </div>
  );
}

function Meta({ term, detail, mono }: { term: string; detail: string; mono?: boolean }) {
  return (
    <div className="flex gap-1.5">
      <dt>{term}:</dt>
      <dd className={mono ? "font-mono text-foreground" : "text-foreground"}>{detail}</dd>
    </div>
  );
}

function BriefEditor({
  project,
  brief,
  onClose,
  onSaved,
}: {
  project: Project;
  brief: ProjectBrief | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { api } = useOrg();
  const t = useT(text);
  const id = useId();
  const cache = useQueryClient();
  const [content, setContent] = useState(brief?.content ?? "");
  // Chốt phiên bản lúc mở: sau CONFLICT brief được tải lại nhưng bản đang sửa vẫn dựa trên phiên bản cũ, để lưu lại
  // vẫn lỗi cho tới khi người dùng xem bản mới.
  const [baseVersion] = useState(() => briefBaseVersion(brief));
  const save = useMutation({
    ...api.briefs.save.mutationOptions(),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: api.briefs.key() });
      onSaved();
    },
    // Lệch phiên bản thì tải sẵn bản mới để "Huỷ" cho người dùng thấy ngay thứ đã vượt lên bản của họ.
    onError: async (error) => {
      if (isBriefConflict(error)) await cache.invalidateQueries({ queryKey: api.briefs.key() });
    },
  });
  const trimmed = content.trim();
  const tooLong = trimmed.length > BRIEF_MAX_CHARS;
  return (
    <div className="grid gap-3">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {t.contentLabel}
      </label>
      <Textarea
        id={id}
        rows={16}
        className="font-mono text-sm"
        value={content}
        aria-invalid={tooLong}
        onChange={(event) => setContent(event.currentTarget.value)}
      />
      <span className={tooLong ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
        {t.charCount(trimmed.length, BRIEF_MAX_CHARS)}
      </span>
      {save.isError && <Alert variant="destructive">{briefSaveMessage(save.error)}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={save.isPending || !trimmed || tooLong}
          onClick={() => save.mutate({ project: project.key, content: trimmed, baseVersion })}
        >
          {save.isPending ? t.saving : t.save}
        </Button>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>
          {t.cancel}
        </Button>
      </div>
    </div>
  );
}
