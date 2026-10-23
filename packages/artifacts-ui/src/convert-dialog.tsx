import { useMutation } from "@tanstack/react-query";
import { type ArtifactSummary, docKey } from "@xdev-hive/contracts";
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
import { useId, useState } from "react";
import { useConvertText } from "./convert-text.ts";
import { useArtifactsEnv } from "./env.tsx";

export interface ConvertDialogProps {
  artifact: ArtifactSummary;
  version: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Bỏ dấu và ký tự ngoài `[a-z0-9]` để tiêu đề thành một đoạn key hợp lệ; rỗng thì để người dùng tự đặt. */
export function slugOf(title: string): string {
  return title
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}

/** Gợi ý theo dự án của artifact; artifact cá nhân hay của đội thì chỉ gợi ý tiền tố `org/` để người dùng sửa. */
function suggestKey(artifact: ArtifactSummary): string {
  const slug = slugOf(artifact.title);
  return artifact.project ? `project/${artifact.project.key}/${slug}` : `org/${slug}`;
}

/**
 * "Chuyển thành tài liệu" (FR-110): chỉ Markdown, và luôn tạo đề xuất `knowledge` chứ không ghi thẳng tài liệu. Quyền
 * đề xuất do hub kiểm, nên người không đủ quyền nhận lỗi tiếng Việt của hub thay vì bị ẩn nút.
 */
export function ConvertDialog({ artifact, version, open, onOpenChange }: ConvertDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <ConvertBody artifact={artifact} version={version} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** Tách khỏi vỏ hộp để mỗi lần mở bắt đầu từ trạng thái sạch. */
function ConvertBody({
  artifact,
  version,
  onClose,
}: Pick<ConvertDialogProps, "artifact" | "version"> & { onClose: () => void }) {
  const env = useArtifactsEnv();
  const t = useConvertText();
  const keyId = useId();
  const titleId = useId();
  const [key, setKey] = useState(() => suggestKey(artifact));
  const [title, setTitle] = useState("");
  const mutation = useMutation(env.api.artifacts.toDoc.mutationOptions());

  const valid = docKey.safeParse(key).success;
  const sent = mutation.isSuccess;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t.title}</DialogTitle>
        <DialogDescription>
          {artifact.title} · v{version}
        </DialogDescription>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">{t.lead}</p>

      {env.offline && (
        <p role="status" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
          {t.offline}
        </p>
      )}

      <div className="flex flex-col gap-3">
        <label htmlFor={keyId} className="flex flex-col gap-1">
          {t.keyLabel}
          <Input
            id={keyId}
            value={key}
            disabled={env.offline || sent}
            aria-invalid={!valid}
            onChange={(e) => setKey(e.target.value.trim())}
          />
          <span className="text-xs text-muted-foreground">{t.keyHelp}</span>
        </label>
        {!valid && (
          <p role="alert" className="text-sm text-destructive">
            {t.keyInvalid}
          </p>
        )}
        <label htmlFor={titleId} className="flex flex-col gap-1">
          {t.docTitleLabel}
          <Input
            id={titleId}
            value={title}
            maxLength={200}
            disabled={env.offline || sent}
            onChange={(e) => setTitle(e.target.value)}
          />
          <span className="text-xs text-muted-foreground">{t.docTitleHelp}</span>
        </label>
      </div>

      {sent && (
        <p role="status" aria-live="polite" className="rounded-md bg-success-soft px-3 py-2 text-success">
          {t.sent} <span className="text-xs">{t.proposalId(mutation.data.proposalId)}</span>
        </p>
      )}
      {mutation.error != null && (
        <p role="alert" className="rounded-md bg-destructive-soft px-3 py-2 text-destructive">
          {env.errorMessage(mutation.error)}
        </p>
      )}

      <DialogActions>
        <Button variant="outline" onClick={onClose}>
          {t.close}
        </Button>
        <Button
          disabled={env.offline || sent || mutation.isPending || !valid}
          onClick={() =>
            mutation.mutate({ id: artifact.id, version, key, ...(title.trim() ? { title: title.trim() } : {}) })
          }
        >
          {mutation.isPending ? t.submitting : t.submit}
        </Button>
      </DialogActions>
    </>
  );
}
