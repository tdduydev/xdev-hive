import type { ArtifactPublicLink, ArtifactPublicLinkOrgItem } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@xdev-hive/ui/table";
import { useState } from "react";
import { useArtifactsEnv } from "./env.tsx";
import { formatWhen, useLinkText } from "./link-text.ts";

export interface PublicLinksTableProps {
  items: (ArtifactPublicLink | ArtifactPublicLinkOrgItem)[];
  /** Có thì mỗi link còn hiệu lực có nút "Thu hồi…" (hỏi lại trước khi gọi); không có thì bảng chỉ đọc. */
  onRevoke?: ((linkId: string) => void) | undefined;
  /** Đang offline hoặc đang thu hồi: tắt nút thu hồi. */
  disabled?: boolean | undefined;
}

type Item = ArtifactPublicLink | ArtifactPublicLinkOrgItem;

function isOrgItem(item: Item): item is ArtifactPublicLinkOrgItem {
  return "artifactTitle" in item;
}

function statusOf(
  item: Item,
  now: number,
): { tone: "ok" | "warn" | "bad"; label: "statusRevoked" | "statusExpired" | "statusActive" } {
  if (item.revokedAt) return { tone: "bad", label: "statusRevoked" };
  if (Date.parse(item.expiresAt) <= now) return { tone: "warn", label: "statusExpired" };
  return { tone: "ok", label: "statusActive" };
}

/** Bảng link công khai cho màn quản trị (T031) và app. Ở 360 px đổi sang dạng thẻ. */
export function PublicLinksTable({ items, onRevoke, disabled = false }: PublicLinksTableProps) {
  const { lang } = useArtifactsEnv();
  const t = useLinkText();
  const [confirming, setConfirming] = useState<string | null>(null);
  // Hạn là mốc cố định; lấy giờ một lần cho mỗi lần dựng để mọi dòng so cùng một thời điểm.
  const now = Date.now();
  const withOrg = items.some(isOrgItem);

  const statusPill = (item: Item) => {
    const status = statusOf(item, now);
    return (
      <Pill tone={status.tone} dot title={item.revokeReason ? t.reason[item.revokeReason] : undefined}>
        {t[status.label]}
      </Pill>
    );
  };
  const revokeButton = (item: Item) =>
    onRevoke && item.active ? (
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => setConfirming(item.id)}>
        {t.revoke}
      </Button>
    ) : null;
  const lastViewed = (item: Item) => (item.lastViewedAt ? formatWhen(item.lastViewedAt, lang) : t.never);
  const views = (item: Item) => new Intl.NumberFormat(lang === "en" ? "en-GB" : "vi-VN").format(item.viewCount);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="max-sm:hidden">
        <Table>
          <TableHeader>
            <TableRow>
              {withOrg && <TableHead>{t.artifact}</TableHead>}
              <TableHead>{t.version}</TableHead>
              <TableHead>{t.createdAt}</TableHead>
              <TableHead>{t.expiresAt}</TableHead>
              <TableHead>{t.views}</TableHead>
              <TableHead>{t.lastViewed}</TableHead>
              <TableHead>{t.status}</TableHead>
              {onRevoke && <TableHead className="w-0" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id}>
                {withOrg && (
                  <TableCell>
                    {isOrgItem(item) && (
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">{item.artifactTitle}</span>
                        <span className="text-xs text-muted-foreground">{item.owner.name}</span>
                      </div>
                    )}
                  </TableCell>
                )}
                <TableCell className="font-mono">v{item.version}</TableCell>
                <TableCell>{formatWhen(item.createdAt, lang)}</TableCell>
                <TableCell>{formatWhen(item.expiresAt, lang)}</TableCell>
                <TableCell>{views(item)}</TableCell>
                <TableCell>{lastViewed(item)}</TableCell>
                <TableCell>{statusPill(item)}</TableCell>
                {onRevoke && <TableCell>{revokeButton(item)}</TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className="flex flex-col gap-2 sm:hidden">
        {items.map((item) => (
          <li key={item.id} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <strong className="min-w-0 truncate">
                {isOrgItem(item) ? item.artifactTitle : t.version} <span className="font-mono">v{item.version}</span>
              </strong>
              {statusPill(item)}
            </div>
            {isOrgItem(item) && <span className="text-xs text-muted-foreground">{item.owner.name}</span>}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">{t.expiresAt}</dt>
              <dd>{formatWhen(item.expiresAt, lang)}</dd>
              <dt className="text-muted-foreground">{t.views}</dt>
              <dd>{views(item)}</dd>
              <dt className="text-muted-foreground">{t.lastViewed}</dt>
              <dd>{lastViewed(item)}</dd>
            </dl>
            {revokeButton(item)}
          </li>
        ))}
      </ul>

      {confirming && onRevoke && (
        <div role="alert" className="flex flex-col gap-2 rounded-md bg-warning-soft p-3 text-sm text-warning">
          <p>{t.revokeWarning}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirming(null)}>
              {t.cancel}
            </Button>
            <Button
              variant="destructive-solid"
              size="sm"
              disabled={disabled}
              onClick={() => {
                onRevoke(confirming);
                setConfirming(null);
              }}
            >
              {t.confirmRevoke}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
