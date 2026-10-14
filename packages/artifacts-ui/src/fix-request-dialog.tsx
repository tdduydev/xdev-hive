import { useMutation, useQuery } from "@tanstack/react-query";
import { ARTIFACT_LIMITS, type ArtifactPageError } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@xdev-hive/ui/dialog";
import { Label } from "@xdev-hive/ui/label";
import { Textarea } from "@xdev-hive/ui/textarea";
import { useEffect, useId, useState } from "react";
import { type FixRequest, useArtifactsEnv } from "./env.tsx";
import { useLinkText } from "./link-text.ts";

export interface FixRequestDialogProps {
  request: FixRequest;
  /** Cuộc trò chuyện đang mở artifact (đích "Cuộc trò chuyện này"); bỏ trống thì chỉ gửi được vào cuộc trò chuyện mới. */
  threadId?: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent?: ((result: { threadId: string; messageId: string }) => void) | undefined;
}

interface DraftError extends ArtifactPageError {
  /** Khoá ổn định để bỏ một lỗi không làm ô còn lại đổi chỗ nội dung đang gõ. */
  key: number;
}

const draftOf = (errors: ArtifactPageError[]): DraftError[] => errors.map((error, key) => ({ ...error, key }));

const banner = "rounded-md px-3 py-2 text-sm";
const warn = `${banner} bg-warning-soft text-warning`;
const bad = `${banner} bg-destructive-soft text-destructive`;

/** Hộp "Nhờ Leader sửa": sửa/xoá lỗi, lời nhắn, chọn đích, gửi `askLeaderFix`. */
export function FixRequestDialog({ request, threadId, open, onOpenChange, onSent }: FixRequestDialogProps) {
  const env = useArtifactsEnv();
  const t = useLinkText();
  const noteId = useId();
  const [errors, setErrors] = useState(() => draftOf(request.errors));
  const [note, setNote] = useState("");
  const [toCurrent, setToCurrent] = useState(threadId !== undefined);
  const [sent, setSent] = useState<{ threadId: string; messageId: string } | null>(null);

  // Mỗi lần mở là một lời nhờ mới trên danh sách lỗi mà khung bên cạnh vừa gom.
  useEffect(() => {
    if (!open) return;
    setErrors(draftOf(request.errors));
    setNote("");
    setToCurrent(threadId !== undefined);
    setSent(null);
  }, [open, request, threadId]);

  const access = useQuery({
    ...env.api.artifacts.get.queryOptions({ input: { id: request.artifact.id, version: request.version } }),
    enabled: open && !env.offline,
  });
  const send = useMutation(
    env.api.artifacts.askLeaderFix.mutationOptions({
      onSuccess: (result) => {
        setSent(result);
        onSent?.(result);
      },
    }),
  );

  // Hub nhận tối đa 20 lỗi: cắt ở đây để người dùng thấy đúng cái sẽ đi, không phải nhận lỗi kiểm đầu vào.
  const kept = errors.filter((error) => error.message.trim() !== "");
  const shown = kept.slice(0, ARTIFACT_LIMITS.pageErrors);
  const noteText = note.trim();
  const readOnly = access.data ? !access.data.access.write : false;
  const nothingToSend = shown.length === 0 && noteText === "";
  const blocked = env.offline || !env.canAskLeader || send.isPending || sent !== null;

  const submit = () => {
    send.mutate({
      id: request.artifact.id,
      version: request.version,
      errors: shown.map(({ kind, message }) => ({ kind, message: message.trim() })),
      ...(noteText ? { note: noteText } : {}),
      ...(toCurrent && threadId ? { threadId } : {}),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t.fix}</DialogTitle>
          <DialogDescription>{request.artifact.title}</DialogDescription>
        </DialogHeader>

        {env.offline && (
          <p role="status" className={warn}>
            {t.offline}
          </p>
        )}
        <p className="text-sm text-muted-foreground">{t.fixIntro}</p>
        <p className="text-xs text-muted-foreground">{t.untrusted}</p>

        {errors.length > 0 && (
          <p role="status" className="text-sm font-medium">
            {t.errorCount(shown.length, kept.length)}
          </p>
        )}
        {kept.length > shown.length && <p className={warn}>{t.truncated(ARTIFACT_LIMITS.pageErrors)}</p>}

        <ul className="flex flex-col gap-2">
          {errors.map((error, index) => {
            const label = t.errorLabel(t.errorKind[error.kind], index + 1);
            return (
              <li key={error.key} className="flex flex-col gap-1.5 rounded-lg border border-border p-2.5">
                <Label htmlFor={`${noteId}-e${error.key}`}>{label}</Label>
                <Textarea
                  id={`${noteId}-e${error.key}`}
                  rows={3}
                  maxLength={ARTIFACT_LIMITS.pageErrorChars}
                  value={error.message}
                  disabled={blocked}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                  onChange={(event) =>
                    setErrors((all) =>
                      all.map((item) => (item.key === error.key ? { ...item, message: event.target.value } : item)),
                    )
                  }
                />
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={blocked}
                    aria-label={`${t.removeError}: ${label}`}
                    onClick={() => setErrors((all) => all.filter((item) => item.key !== error.key))}
                  >
                    {t.removeError}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        {shown.length === 0 && request.errors.length > 0 && <p className={banner}>{t.noneLeft}</p>}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={noteId}>{t.note(ARTIFACT_LIMITS.fixNoteChars)}</Label>
          <Textarea
            id={noteId}
            rows={3}
            maxLength={ARTIFACT_LIMITS.fixNoteChars}
            value={note}
            disabled={blocked}
            autoComplete="off"
            placeholder={t.noteHint}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>

        <fieldset className="flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1 text-sm font-medium">{t.destination}</legend>
          {threadId !== undefined && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${noteId}-dest`}
                checked={toCurrent}
                disabled={blocked}
                onChange={() => setToCurrent(true)}
              />
              {t.current}
            </label>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${noteId}-dest`}
              checked={!toCurrent || threadId === undefined}
              disabled={blocked}
              onChange={() => setToCurrent(false)}
            />
            {t.newDestination}
            {request.artifact.project ? ` · ${request.artifact.project.name}` : ""}
          </label>
        </fieldset>
        <p className="text-xs text-muted-foreground">{t.ownLeader}</p>
        {readOnly && <p className={warn}>{t.readOnlyHelp}</p>}
        {!env.canAskLeader && (
          <p role="alert" className={warn}>
            {t.missingLeader}
          </p>
        )}
        {send.error != null && (
          <p role="alert" className={bad}>
            {env.errorMessage(send.error)}
          </p>
        )}

        {sent ? (
          <div role="status" className="flex flex-col gap-2 rounded-md bg-success-soft p-3 text-sm text-success">
            <p>{t.sentRequest}</p>
            {env.link({ to: { kind: "thread", id: sent.threadId }, children: t.openConversation })}
          </div>
        ) : (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t.cancel}
            </Button>
            <Button disabled={blocked || nothingToSend} onClick={submit}>
              {send.isPending ? t.sending : t.sendRequest}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
