import { useMutation } from "@tanstack/react-query";
import {
  ARTIFACT_FRAME_TYPES,
  ARTIFACT_LIMITS,
  type ArtifactErrorData,
  type ArtifactSummary,
  type ArtifactVersion,
  type ArtifactWriteResult,
  artifactErrorData,
  SECRET_KIND_LABELS,
  type SecretFinding,
} from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { Textarea } from "@xdev-hive/ui/textarea";
import { type ChangeEvent, useEffect, useId, useRef, useState } from "react";
import { type CompareMode, CompareModeSwitch, DiffView } from "./compare.tsx";
import { useArtifactsEnv } from "./env.tsx";
import { SandboxFrame } from "./sandbox-frame.tsx";
import { useEditText } from "./text-edit.ts";
import { CodeViewer } from "./viewer/code.tsx";
import { MarkdownViewer } from "./viewer/markdown.tsx";

export interface ArtifactEditorProps {
  artifact: ArtifactSummary;
  /** Bản gốc của lần sửa (`baseVersion`). */
  version: ArtifactVersion;
  onSaved: (result: ArtifactWriteResult) => void;
  onCancel: () => void;
}

/** Cao một dòng của ô soạn (Tailwind `leading-5`), để vạch đánh dấu dòng bí mật nằm đúng dòng. */
const LINE_REM = 1.25;
/** Cột số dòng chỉ vẽ tới đây: bản 1 MiB toàn dòng trống sẽ có cả triệu dòng. */
const MAX_GUTTER_LINES = 50_000;

const draftKey = (artifact: ArtifactSummary, version: ArtifactVersion) =>
  `hive-artifact-draft:${artifact.id}@${version.version}`;

/** Bản nháp giữ trong bộ nhớ trình duyệt của phiên (US9-4); không có thì (hay bị chặn) soạn tiếp từ bản gốc. */
function readDraft(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeDraft(key: string, value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // Bộ nhớ đầy hay bị chặn: mất bản nháp là chấp nhận được, không được làm hỏng việc sửa.
  }
}

function errorData(error: unknown): ArtifactErrorData {
  const data = typeof error === "object" && error !== null && "data" in error ? error.data : undefined;
  const parsed = artifactErrorData.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

interface Conflict {
  version: number;
  /** `null` khi bản mới nhất đã bị xoá vì chứa bí mật. */
  content: string | null;
}

/**
 * Ô soạn chữ tối thiểu (FR-130 phần MVP): `markdown`, `code`, `html`, `mermaid` đều soạn bằng một ô chữ, xem trước bằng
 * khung cách ly với nội dung chưa lưu. Lưu mang `baseVersion` nên người khác hay Leader lưu trước thì nhận xung đột thay
 * vì bị đè (US9). Hub chặn chuỗi giống bí mật và chỉ trả dòng và loại; ô soạn đánh dấu dòng đó, không hiện lại chuỗi.
 */
export function ArtifactEditor({ artifact, version, onSaved, onCancel }: ArtifactEditorProps) {
  const env = useArtifactsEnv();
  const t = useEditText();
  const contentId = useId();
  const noteId = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const original = version.content ?? "";
  const key = draftKey(artifact, version);
  const [text, setText] = useState(() => readDraft(key) ?? original);
  const [note, setNote] = useState("");
  const [baseVersion, setBaseVersion] = useState(version.version);
  const [findings, setFindings] = useState<SecretFinding[]>([]);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [mode, setMode] = useState<CompareMode>("side");
  const [localPreview, setLocalPreview] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const dirty = text !== original;

  const framed = ARTIFACT_FRAME_TYPES.includes(artifact.type);
  const absorb = (error: unknown) => {
    const data = errorData(error);
    if (data?.code === "ARTIFACT_SECRET_FOUND") setFindings(data.findings ?? []);
    if (data?.code === "ARTIFACT_VERSION_CONFLICT" && data.latest)
      setConflict({ version: data.latest.version, content: data.latest.content });
  };

  const save = useMutation(
    env.api.artifacts.update.mutationOptions({
      onSuccess: (result) => {
        writeDraft(key, null);
        onSaved(result);
      },
      onError: absorb,
    }),
  );
  const preview = useMutation(env.api.artifacts.preview.mutationOptions({ onError: absorb }));

  useEffect(() => {
    writeDraft(key, dirty ? text : null);
  }, [key, dirty, text]);

  // Đóng tab hay tải lại khi còn chữ chưa lưu: trình duyệt hỏi lại (rời khung trong app thì `leaving` hỏi).
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const edit = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.target.value);
    // Dòng đánh dấu thuộc về nội dung đã gửi; sửa rồi thì số dòng cũ không còn đúng.
    setFindings([]);
    save.reset();
  };

  const submit = (base: number) => {
    setConflict(null);
    setFindings([]);
    const message = note.trim();
    save.mutate(
      message
        ? { id: artifact.id, content: text, baseVersion: base, message }
        : { id: artifact.id, content: text, baseVersion: base },
    );
  };

  const jump = (line: number) => {
    const el = area.current;
    if (!el) return;
    const start =
      text
        .split("\n")
        .slice(0, line - 1)
        .join("\n").length + (line > 1 ? 1 : 0);
    el.focus();
    el.setSelectionRange(start, start + (text.split("\n")[line - 1]?.length ?? 0));
  };

  const runPreview = () => {
    setFindings([]);
    if (framed) preview.mutate({ type: artifact.type, content: text, theme: env.theme });
    else setLocalPreview((on) => !on);
  };

  const lineCount = Math.min(text.split("\n").length, MAX_GUTTER_LINES);
  const gutter = Array.from({ length: lineCount }, (_, i) => i + 1).join("\n");
  const offline = env.offline;
  const failed = save.error ?? preview.error;
  // Lỗi đã có khối riêng (bí mật, xung đột) thì không in lại câu chung của hub.
  const generic = failed != null && findings.length === 0 && !conflict ? env.errorMessage(failed) : null;
  const compileError = preview.data?.compileError ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <h4 className="font-heading text-sm font-semibold">{t.editorTitle}</h4>

      {offline && (
        <p role="status" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
          {t.offlineSave}
        </p>
      )}

      {findings.length > 0 && (
        <div role="alert" className="flex flex-col gap-1 rounded-md bg-destructive-soft p-3 text-sm text-destructive">
          {findings.map((finding) => (
            <p key={`${finding.line}:${finding.kind}`} className="flex flex-wrap items-center gap-2">
              <strong className="font-semibold">{t.secret(finding.line, SECRET_KIND_LABELS[finding.kind])}</strong>
              <button type="button" className="font-semibold underline" onClick={() => jump(finding.line)}>
                {t.secretJump(finding.line)}
              </button>
            </p>
          ))}
          <p>{t.secretBody}</p>
        </div>
      )}

      {generic && (
        <p role="alert" className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">
          {generic}
        </p>
      )}

      {conflict && (
        <div role="alert" className="flex flex-col gap-3 rounded-md border border-warning p-3 text-sm">
          <p>
            <strong className="font-semibold">{t.conflictTitle(conflict.version, baseVersion)}</strong>
            <br />
            <span className="text-muted-foreground">{t.conflictBody}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              aria-expanded={showDiff}
              disabled={conflict.content === null}
              onClick={() => setShowDiff((on) => !on)}
            >
              {showDiff ? t.conflictHide : t.conflictDiff}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offline || save.isPending}
              onClick={() => {
                setBaseVersion(conflict.version);
                submit(conflict.version);
              }}
            >
              {t.conflictKeepMine}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={conflict.content === null}
              onClick={() => {
                setText(conflict.content ?? "");
                setBaseVersion(conflict.version);
                setConflict(null);
                save.reset();
              }}
            >
              {t.conflictTakeTheirs}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                writeDraft(key, null);
                onCancel();
              }}
            >
              {t.conflictDrop}
            </Button>
          </div>
          {conflict.content === null && <p className="text-muted-foreground">{t.tombstonedLatest}</p>}
          {showDiff && conflict.content !== null && (
            <div className="flex flex-col gap-2">
              <CompareModeSwitch mode={mode} onChange={setMode} />
              <DiffView
                before={conflict.content}
                after={text}
                beforeLabel={t.theirs(conflict.version)}
                afterLabel={t.mine(baseVersion)}
                mode={mode}
              />
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor={contentId} className="text-sm font-medium">
          {t.editorLabel}
        </label>
        <div className="flex min-w-0 rounded-lg border border-input focus-within:border-ring">
          <div
            aria-hidden
            className="relative w-12 shrink-0 overflow-hidden rounded-l-lg border-r bg-muted py-2 pr-2 text-right font-mono text-xs leading-5 text-muted-foreground select-none"
          >
            <pre className="font-[inherit]">{gutter}</pre>
            {findings.map((finding) => (
              <span
                key={`${finding.line}:${finding.kind}`}
                className="absolute left-0 w-full bg-destructive text-center font-semibold text-destructive-foreground"
                style={{ top: `${0.5 + (finding.line - 1) * LINE_REM}rem`, height: `${LINE_REM}rem` }}
              >
                !
              </span>
            ))}
          </div>
          <Textarea
            id={contentId}
            ref={area}
            value={text}
            wrap="off"
            spellCheck={false}
            aria-invalid={findings.length > 0}
            className="min-h-60 min-w-0 flex-1 overflow-x-auto rounded-l-none border-0 font-mono text-xs leading-5 whitespace-pre focus-visible:ring-0 md:text-xs"
            onChange={edit}
          />
        </div>
        {dirty && <p className="text-xs text-muted-foreground">{t.draftNote}</p>}
      </div>

      <label htmlFor={noteId} className="flex flex-col gap-1 text-sm font-medium">
        {t.noteLabel}
        <Input
          id={noteId}
          value={note}
          maxLength={ARTIFACT_LIMITS.messageChars}
          placeholder={t.notePlaceholder}
          autoComplete="off"
          onChange={(e) => setNote(e.target.value)}
        />
        <span className="text-xs font-normal text-muted-foreground">{t.noteHint}</span>
      </label>

      {leaving && (
        <div role="alert" className="flex flex-col gap-2 rounded-md bg-warning-soft p-3 text-sm text-warning">
          <strong>{t.leaveTitle}</strong>
          <p>{t.leaveBody}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setLeaving(false)}>
              {t.leaveStay}
            </Button>
            <Button
              variant="destructive-solid"
              size="sm"
              onClick={() => {
                writeDraft(key, null);
                onCancel();
              }}
            >
              {t.leaveDiscard}
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button disabled={offline || save.isPending || !dirty} onClick={() => submit(baseVersion)}>
          {save.isPending ? t.saving : t.save}
        </Button>
        <Button
          variant="outline"
          disabled={offline && framed}
          aria-pressed={framed ? undefined : localPreview}
          onClick={runPreview}
        >
          {t.preview}
        </Button>
        <Button variant="outline" onClick={() => (dirty ? setLeaving(true) : onCancel())}>
          {t.cancel}
        </Button>
      </div>

      <section aria-label={t.previewTitle} className="flex flex-col gap-2">
        {framed ? (
          preview.isPending ? (
            <p role="status" aria-busy="true" className="text-sm text-muted-foreground">
              {t.previewing}
            </p>
          ) : preview.data ? (
            <>
              {compileError && (
                <p role="alert" className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">
                  <strong>{t.previewCompile}</strong> — <span className="font-mono">{compileError}</span>
                </p>
              )}
              <SandboxFrame
                key={preview.data.url}
                src={new URL(preview.data.url, env.frameBase).href}
                title={t.previewTitle}
              />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t.previewHint}</p>
          )
        ) : localPreview ? (
          artifact.type === "markdown" ? (
            <MarkdownViewer content={text} />
          ) : (
            <CodeViewer content={text} language={artifact.language} />
          )
        ) : (
          <p className="text-sm text-muted-foreground">{t.previewHint}</p>
        )}
      </section>
    </div>
  );
}
