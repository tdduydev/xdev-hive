import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ARTIFACT_LIMITS, type ArtifactSummary } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { Label } from "@xdev-hive/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { useEffect, useId, useState } from "react";
import { useArtifactsEnv } from "./env.tsx";
import { useLinkText } from "./link-text.ts";
import { PublicLinksTable } from "./public-links-table.tsx";

export interface PublicLinkDialogProps {
  artifact: ArtifactSummary;
  /** Phiên bản chọn sẵn khi tạo link. */
  version: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Dòng đầu tiên của chuỗi nghi là bí mật khi hub từ chối tạo link (`ARTIFACT_SECRET_FOUND`); không có chuỗi, chỉ dòng. */
function secretLine(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("data" in error)) return null;
  const data = error.data as { code?: string; findings?: { line: number }[] } | undefined;
  return data?.code === "ARTIFACT_SECRET_FOUND" ? (data.findings?.[0]?.line ?? null) : null;
}

const toolBanner = "rounded-md px-3 py-2 text-sm";
const warn = `${toolBanner} bg-warning-soft text-warning`;
const bad = `${toolBanner} bg-destructive-soft text-destructive`;

/** Tạo (chỉ chủ), xem, thu hồi link công khai của một artifact. */
export function PublicLinkDialog({ artifact, version, open, onOpenChange }: PublicLinkDialogProps) {
  const env = useArtifactsEnv();
  const t = useLinkText();
  const queryClient = useQueryClient();
  const daysId = useId();
  const versionId = useId();
  const urlId = useId();

  const settings = useQuery({ ...env.api.artifacts.settings.queryOptions(), enabled: open && !env.offline });
  // Cùng khoá với khung bên cạnh nên thường đã có sẵn trong bộ nhớ: quyền chủ và lỗi biên dịch của phiên bản chọn.
  const [selected, setSelected] = useState(version);
  const detail = useQuery({
    ...env.api.artifacts.get.queryOptions({ input: { id: artifact.id, version: selected } }),
    enabled: open && !env.offline,
  });
  const isOwner = detail.data?.access.owner ?? false;
  const versions = useQuery({
    ...env.api.artifacts.versions.list.queryOptions({ input: { id: artifact.id } }),
    enabled: open && !env.offline,
  });
  const links = useQuery({
    ...env.api.artifacts.publicLinks.list.queryOptions({ input: { id: artifact.id } }),
    enabled: open && !env.offline && isOwner,
  });

  const maxDays = settings.data?.publicLinks.maxDays ?? ARTIFACT_LIMITS.publicLinkMaxDays;
  const defaultDays = Math.min(ARTIFACT_LIMITS.publicLinkDefaultDays, maxDays);
  const [days, setDays] = useState(String(defaultDays));
  // Link chỉ nằm trong state của hộp này, không vào bộ nhớ truy vấn hay lưu trữ: hub không lưu mã nên không có lần hai.
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("");
  const [revokeError, setRevokeError] = useState<unknown>(null);

  useEffect(() => {
    if (open) return;
    setUrl("");
    setStatus("");
    setRevokeError(null);
    setSelected(version);
  }, [open, version]);
  useEffect(() => setSelected(version), [version]);

  const create = useMutation(
    env.api.artifacts.publicLinks.create.mutationOptions({
      onSuccess: (result) => {
        setUrl(new URL(result.url, env.frameBase).href);
        setStatus("");
        void queryClient.invalidateQueries({ queryKey: env.api.artifacts.publicLinks.key() });
      },
    }),
  );
  const revoke = useMutation(
    env.api.artifacts.publicLinks.revoke.mutationOptions({
      onSuccess: () => {
        setRevokeError(null);
        void queryClient.invalidateQueries({ queryKey: env.api.artifacts.publicLinks.key() });
      },
      onError: setRevokeError,
    }),
  );

  const dayCount = /^\d+$/.test(days) ? Number(days) : Number.NaN;
  const invalidDays = !(dayCount >= 1 && dayCount <= maxDays);
  const activeCount = (links.data ?? []).filter((link) => link.active).length;
  const atLimit = activeCount >= ARTIFACT_LIMITS.activePublicLinks;
  const policyOff = settings.data ? !settings.data.publicLinks.enabled : false;
  const loading = !env.offline && (detail.isPending || settings.isPending);
  const loadFailed = !env.offline && (detail.isError || settings.isError);
  const line = secretLine(create.error);
  const canCreate = isOwner && !policyOff;
  const createBlocked =
    env.offline ||
    invalidDays ||
    atLimit ||
    create.isPending ||
    url !== "" ||
    line !== null ||
    !!detail.data?.version.tombstonedAt;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setStatus(t.copied);
    } catch {
      setStatus(t.copyFailed);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t.publicLinks}</DialogTitle>
          <DialogDescription>{artifact.title}</DialogDescription>
        </DialogHeader>

        {env.offline && (
          <p role="status" className={warn}>
            {t.offline}
          </p>
        )}
        {loading && (
          <p role="status" aria-busy="true" className="text-sm text-muted-foreground">
            {t.loading}
          </p>
        )}
        {loadFailed && (
          <div role="alert" className={`${bad} flex flex-wrap items-center gap-2`}>
            <span className="flex-1">{t.loadError}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void detail.refetch();
                void settings.refetch();
              }}
            >
              {t.retry}
            </Button>
          </div>
        )}

        {detail.data && !isOwner && (
          <p role="status" className={warn}>
            {t.onlyOwner}
          </p>
        )}
        {policyOff && (
          <p role="status" className={warn}>
            {t.policyOff}
          </p>
        )}

        {canCreate && (
          <div className="flex flex-col gap-3">
            <p className={warn}>{t.outside}</p>
            <p className="text-sm text-muted-foreground">{t.pinned}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={versionId}>{t.version}</Label>
                <NativeSelect
                  id={versionId}
                  value={String(selected)}
                  disabled={env.offline || url !== ""}
                  onChange={(event) => {
                    setSelected(Number(event.target.value));
                    create.reset();
                  }}
                >
                  {(versions.data ?? [{ version }]).map((v) => (
                    <NativeSelectOption key={v.version} value={String(v.version)}>
                      v{v.version}
                      {v.version === artifact.latestVersion ? ` · ${t.latest}` : ""}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={daysId}>{t.expiryDays}</Label>
                <Input
                  id={daysId}
                  inputMode="numeric"
                  value={days}
                  disabled={env.offline || url !== ""}
                  aria-invalid={invalidDays}
                  aria-describedby={`${daysId}-help`}
                  onChange={(event) => setDays(event.target.value)}
                />
              </div>
            </div>
            <p id={`${daysId}-help`} className="text-xs text-muted-foreground">
              {t.daysHelp(maxDays, defaultDays)}
            </p>
            {invalidDays && (
              <p role="alert" className={bad}>
                {t.daysError(maxDays)}
              </p>
            )}
            {detail.data?.version.hasCompileError && <p className={warn}>{t.compile}</p>}
            {atLimit && (
              <p role="alert" className={warn}>
                {t.limit(ARTIFACT_LIMITS.activePublicLinks)}
              </p>
            )}
            {line !== null ? (
              <p role="alert" className={bad}>
                {t.secretAt(line)}
              </p>
            ) : (
              create.error != null && (
                <p role="alert" className={bad}>
                  {env.errorMessage(create.error)}
                </p>
              )
            )}
            <div>
              <Button
                disabled={createBlocked}
                onClick={() => create.mutate({ id: artifact.id, version: selected, expiresInDays: dayCount })}
              >
                {t.createLink}
              </Button>
            </div>
          </div>
        )}

        {url !== "" && (
          <section aria-live="polite" className="flex flex-col gap-2 rounded-md bg-success-soft p-3 text-sm">
            <h3 className="font-heading font-semibold text-success">{t.createdLink}</h3>
            <p className="text-success">{t.onceWarning}</p>
            <Label htmlFor={urlId}>{t.url}</Label>
            <div className="flex gap-2">
              <Input
                id={urlId}
                readOnly
                spellCheck={false}
                autoComplete="off"
                value={url}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button variant="outline" onClick={copy}>
                {t.copy}
              </Button>
            </div>
            <div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setUrl("");
                  setStatus("");
                }}
              >
                {t.hideUrl}
              </Button>
            </div>
          </section>
        )}
        {status && (
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {status}
          </p>
        )}

        {isOwner && (
          <section className="flex flex-col gap-2">
            <h3 className="font-heading text-sm font-semibold">{t.activeLinks}</h3>
            {links.isError ? (
              <p role="alert" className={bad}>
                {t.loadError}
              </p>
            ) : links.data && links.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t.noLinks}</p>
            ) : (
              <PublicLinksTable
                items={links.data ?? []}
                disabled={env.offline || revoke.isPending}
                onRevoke={(linkId) => revoke.mutate({ linkId })}
              />
            )}
            {revokeError != null && (
              <p role="alert" className={bad}>
                {env.errorMessage(revokeError)}
              </p>
            )}
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}
