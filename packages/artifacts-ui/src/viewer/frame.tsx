import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { ArtifactPageError, ArtifactType } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { type ReactNode, useEffect, useState } from "react";
import { useArtifactsEnv, useText } from "../env.tsx";
import { SandboxFrame } from "../sandbox-frame.tsx";

/** Vé sống 5 phút (D6); xin lại sớm hơn một chút để lần mở sau không nhận vé sắp hết hạn từ cache. */
const TICKET_STALE_MS = 4 * 60_000;
/** Vé còn ít hơn ngần này thì coi như hết: khung nạp chậm có thể tới hub sau khi vé hết hạn. */
const TICKET_MARGIN_MS = 15_000;

export interface FrameViewerProps {
  artifactId: string;
  version: number;
  title: string;
  onErrors?: ((errors: ArtifactPageError[]) => void) | undefined;
}

type Ticket = { url: string; expiresAt: string };

const ticketQuery = { staleTime: TICKET_STALE_MS, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;

function Loading() {
  const t = useText();
  return (
    <div
      role="status"
      aria-busy="true"
      className="flex min-h-60 items-center justify-center text-sm text-muted-foreground"
    >
      {t.loading}
    </div>
  );
}

/**
 * Giữ nguyên URL khung đã nạp: vé hết hạn hay query xin lại vé không được làm trang đang chạy nạp lại (mất dữ liệu người
 * xem đang nhập). Chỉ "Tải lại trang" mới xin vé mới.
 */
function TicketFrame({
  ticket,
  title,
  onErrors,
}: {
  ticket: UseQueryResult<Ticket>;
  title: string;
  onErrors: FrameViewerProps["onErrors"];
}) {
  const env = useArtifactsEnv();
  const t = useText();
  const [pinned, setPinned] = useState<string | null>(null);
  const data = ticket.data;
  const fresh = data && Date.parse(data.expiresAt) - Date.now() > TICKET_MARGIN_MS ? data : null;
  const src = fresh ? new URL(fresh.url, env.frameBase).href : null;

  useEffect(() => {
    if (!pinned && src) setPinned(src);
  }, [pinned, src]);

  if (pinned)
    return (
      <SandboxFrame
        src={pinned}
        title={title}
        onErrors={onErrors}
        onReload={() => {
          setPinned(null);
          void ticket.refetch();
        }}
      />
    );
  if (ticket.isError)
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-2 rounded-md bg-destructive-soft p-3 text-sm text-destructive"
      >
        <p>{env.errorMessage(ticket.error)}</p>
        <Button variant="outline" size="sm" onClick={() => void ticket.refetch()}>
          {t.retry}
        </Button>
      </div>
    );
  return <Loading />;
}

/** Phiên bản đã lưu trong khung cách ly: vé của hub, hoặc bản đệm của app khi offline. */
export function FramedArtifact({ artifactId, version, title, onErrors }: FrameViewerProps) {
  const env = useArtifactsEnv();
  const t = useText();
  const ticket = useQuery({
    ...env.api.artifacts.frameUrl.queryOptions({ input: { id: artifactId, version, theme: env.theme } }),
    ...ticketQuery,
    enabled: !env.offline,
  });
  const frameTitle = t.frameTitle(title);
  if (env.offline) {
    const src = env.offlineCache?.frameUrl(artifactId, version);
    if (!src) return <p className="rounded-md bg-warning-soft p-3 text-sm text-warning">{t.notCached}</p>;
    return <SandboxFrame src={src} title={frameTitle} onErrors={onErrors} />;
  }
  return (
    <TicketFrame key={`${artifactId}@${version}:${env.theme}`} ticket={ticket} title={frameTitle} onErrors={onErrors} />
  );
}

/**
 * Nội dung chưa phải một phiên bản (khối ```mermaid trong Markdown) vào khung qua bản xem trước của hub (D14, D20), để
 * không bao giờ dựng nội dung chạy được trong origin của hub/app. Offline thì không có khung: `fallback` hiện nguồn.
 */
export function FramedPreview({
  type,
  content,
  title,
  fallback,
}: {
  type: ArtifactType;
  content: string;
  title: string;
  fallback: ReactNode;
}) {
  const env = useArtifactsEnv();
  const ticket = useQuery({
    ...env.api.artifacts.preview.queryOptions({ input: { type, content, theme: env.theme } }),
    ...ticketQuery,
    enabled: !env.offline,
  });
  if (env.offline) return fallback;
  return <TicketFrame key={`${type}:${env.theme}:${content}`} ticket={ticket} title={title} onErrors={undefined} />;
}
