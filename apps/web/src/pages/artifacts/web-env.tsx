import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  type ArtifactsEnv,
  ArtifactsProvider,
  type FixRequest,
  FixRequestDialog,
  PublicLinkDialog,
} from "@xdev-hive/artifacts-ui";
import type { ArtifactSummary } from "@xdev-hive/contracts";
import { type ReactNode, useState, useSyncExternalStore } from "react";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { useLang } from "@/lib/i18n.ts";
import { useOrg } from "@/shell/org-context.ts";

// Lớp `dark` trên <html> do lib/theme.ts đặt (kể cả khi theo hệ điều hành), nên theo dõi lớp đó là đủ: khung cách ly
// nhận theme qua vé, không đọc được CSS của trang.
function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

const readTheme = () => (document.documentElement.classList.contains("dark") ? "dark" : "light");

export function useDocumentTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribeTheme, readTheme, () => "light");
}

const link: ArtifactsEnv["link"] = ({ to, className, children }) => {
  switch (to.kind) {
    case "library":
      return (
        <Link to="/artifacts" className={className}>
          {children}
        </Link>
      );
    case "artifact":
      return to.version === undefined ? (
        <Link to="/artifacts/$id" params={{ id: to.id }} className={className}>
          {children}
        </Link>
      ) : (
        <Link to="/artifacts/$id/v/$n" params={{ id: to.id, n: String(to.version) }} className={className}>
          {children}
        </Link>
      );
    case "thread":
      return (
        <Link to="/leader" search={{ thread: to.id }} className={className}>
          {children}
        </Link>
      );
    case "run":
      return (
        <Link to="/runs/$id" params={{ id: to.id }} className={className}>
          {children}
        </Link>
      );
  }
};

/**
 * `ArtifactsEnv` của web (D15) kèm hai hộp mà khung bên cạnh và trang chi tiết mở qua env: "Nhờ Leader sửa" và "Link
 * công khai". Web gọi hub bằng cookie cùng origin nên khung lấy origin của trang; web không có bộ đệm offline.
 */
export function WebArtifacts({ threadId, children }: { threadId?: string | undefined; children: ReactNode }) {
  const { api } = useOrg();
  const lang = useLang();
  const theme = useDocumentTheme();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [fix, setFix] = useState<FixRequest | null>(null);
  const [fixOpen, setFixOpen] = useState(false);
  const [share, setShare] = useState<{ artifact: ArtifactSummary; version: number } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  const env: ArtifactsEnv = {
    api,
    lang,
    theme,
    errorMessage: apiErrorMessage,
    link,
    frameBase: window.location.origin,
    offline: false,
    // Mọi thành viên tổ chức dùng được Leader trên web; hub vẫn kiểm quyền đọc artifact khi nhận lời nhờ.
    canAskLeader: true,
    onAskLeaderFix: (request) => {
      setFix(request);
      setFixOpen(true);
    },
    onPublicLinks: (artifact, version) => {
      setShare({ artifact, version });
      setShareOpen(true);
    },
  };

  return (
    <ArtifactsProvider env={env}>
      {children}
      {fix && (
        <FixRequestDialog
          request={fix}
          threadId={threadId}
          open={fixOpen}
          onOpenChange={setFixOpen}
          onSent={(result) => {
            setFixOpen(false);
            void queryClient.invalidateQueries({ queryKey: api.leader.key() });
            // Leader trả lời trong cuộc trò chuyện nhận lời nhờ: đưa người dùng tới đó để thấy bản sửa.
            void navigate({ to: "/leader", search: { thread: result.threadId } });
          }}
        />
      )}
      {share && (
        <PublicLinkDialog
          artifact={share.artifact}
          version={share.version}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      )}
    </ArtifactsProvider>
  );
}
