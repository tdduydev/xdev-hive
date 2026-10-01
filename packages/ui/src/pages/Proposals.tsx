import { useState } from "react";
import type { Proposal } from "@xdev-hive/core";
import { approvalOf } from "#ui/lib/permissions.ts";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@xdev-hive/ui/components/ui/toggle-group";
import { BulkBar, bulkSummary } from "#ui/components/BulkBar.tsx";
import { Diff } from "#ui/components/Diff.tsx";
import { Badge, Empty, ErrorNote, Notice, OwnerBadge, Page, PageHeader, STATUS_TONE } from "#ui/components/common.tsx";
import { formatTime, sourceText, useAction, useCan, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { runBulk, splitProposals } from "#ui/lib/bulk.ts";
import { docOwner, inScope, scopeLabel } from "#ui/lib/scope.ts";
import { useToast } from "#ui/shell/toast.tsx";

const SEGMENT = "";

export function ProposalsPage() {
  const { client, scope, bump } = useHive();
  const t = useT();
  const allow = useCan();
  const toast = useToast();
  const bulk = useAction();
  const [onlyPending, setOnlyPending] = useState(true);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const list = useQuery(
    () => client.call("proposals.list", onlyPending ? { status: "pending" } : {}),
    [client, onlyPending],
  );
  // Shared-doc proposals show in every project's scope (see lib/scope.ts).
  const proposals = list.data?.filter((p) => inScope(scope, docOwner(p.docKey)));
  // Picks outside the view (another scope, decided meanwhile) simply drop out of what the bar acts on.
  const selectable = (proposals ?? []).filter((p) => p.status === "pending" && allow(docOwner(p.docKey), approvalOf(p.docKey)));
  const chosen = selectable.filter((p) => picked.has(p.id));
  const label = (p: Proposal) => `#${p.id} ${p.docKey}`;
  const finish = (text: string, trouble: boolean) => {
    toast(text, { tone: trouble ? "error" : "info" });
    setPicked(new Set());
    bump();
    list.reload();
  };

  const approveAll = () =>
    void bulk.run(async () => {
      // Only a pre-check so stale ones stay pending; without it the hub still marks them conflict on approve.
      const docs = await client.call("docs.list", {}).catch(() => undefined);
      const { ready, conflicts } = splitProposals(chosen, docs && new Map(docs.map((d) => [d.key, d.version] as const)));
      const r = await runBulk(ready, async (p) => ((await client.call("proposals.approve", { id: p.id })).status === "conflict" ? ("conflict" as const) : ("done" as const)));
      r.conflicts.unshift(...conflicts);
      finish(bulkSummary(t, "approve", r, label), r.conflicts.length > 0 || r.failed.length > 0);
    });
  const rejectAll = () => {
    if (!window.confirm(t("bulk.confirmRejectProposals", { count: chosen.length }))) return;
    void bulk.run(async () => {
      const r = await runBulk(chosen, async (p) => {
        await client.call("proposals.reject", { id: p.id });
        return "done" as const;
      });
      finish(bulkSummary(t, "reject", r, label), r.failed.length > 0);
    });
  };

  return (
    <Page>
      <PageHeader
        title={t("proposals.title")}
        subtitle={t("proposals.subtitle")}
        actions={
          <ToggleGroup
            type="single"
            variant="outline"
            value={onlyPending ? "pending" : "all"}
            onValueChange={(v) => {
              if (v) setOnlyPending(v === "pending");
            }}
            aria-label={t("proposals.filter")}
          >
            <ToggleGroupItem value="pending" className={SEGMENT}>
              {t("proposalStatus.pending")}
            </ToggleGroupItem>
            <ToggleGroupItem value="all" className={SEGMENT}>
              {t("proposals.all")}
            </ToggleGroupItem>
          </ToggleGroup>
        }
      />
      <ErrorNote error={list.error} />
      <BulkBar
        className="mb-4"
        selectable={selectable.length}
        picked={chosen.length}
        busy={bulk.busy}
        onPickAll={() => setPicked(new Set(selectable.map((p) => p.id)))}
        onClear={() => setPicked(new Set())}
        onApprove={approveAll}
        onReject={rejectAll}
      />
      <ErrorNote error={bulk.error} />
      {proposals?.length === 0 ? (
        <Empty>
          {scope.kind === "all"
            ? t(onlyPending ? "proposals.noPending" : "proposals.none")
            : t(onlyPending ? "proposals.noPendingIn" : "proposals.noneIn", { scope: scopeLabel(scope) })}
        </Empty>
      ) : null}
      <div className="flex flex-col gap-4">
        {proposals?.map((p) => (
          <ProposalCard
            key={p.id}
            proposal={p}
            onChanged={list.reload}
            picked={picked.has(p.id)}
            onPick={(on) =>
              setPicked((cur) => {
                const next = new Set(cur);
                if (on) next.add(p.id);
                else next.delete(p.id);
                return next;
              })
            }
          />
        ))}
      </div>
    </Page>
  );
}

function ProposalCard({ proposal: p, onChanged, picked, onPick }: { proposal: Proposal; onChanged: () => void; picked: boolean; onPick: (on: boolean) => void }) {
  const { client, bump } = useHive();
  const t = useT();
  const allow = useCan();
  const [open, setOpen] = useState(p.status === "pending");
  const [note, setNote] = useState("");
  const current = useQuery(
    () => (open ? client.call("docs.get", { key: p.docKey }) : Promise.resolve(undefined)),
    [client, p.docKey, open],
  );
  const action = useAction();
  const stale = current.data !== undefined && (current.data?.version ?? 0) !== p.baseVersion;
  const manage = p.status === "pending" && allow(docOwner(p.docKey), approvalOf(p.docKey));
  // A reviewer of docs sees why this one is not theirs to approve: it changes what agents read.
  const contextOnly = p.status === "pending" && !manage && approvalOf(p.docKey) === "contextEdit" && allow(docOwner(p.docKey), "docApprove");

  const decide = (kind: "approve" | "reject") =>
    action.run(async () => {
      if (kind === "approve") await client.call("proposals.approve", { id: p.id });
      else await client.call("proposals.reject", { id: p.id, note: note.trim() || undefined });
      bump();
      onChanged();
    });

  return (
    <article>
      <Card className="py-4">
        <CardContent className="flex flex-col gap-4 px-4">
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                {manage ? <Checkbox checked={picked} onCheckedChange={(v) => onPick(v === true)} aria-label={t("bulk.pickItem", { id: p.id })} /> : null}
                <Badge tone={STATUS_TONE[p.status]}>{t(`proposalStatus.${p.status}`)}</Badge>
                <OwnerBadge owner={docOwner(p.docKey)} />
                <span className="min-w-0 font-mono text-xs break-all">{p.docKey}</span>
                <span className="text-xs text-muted-foreground">
                  {t("proposals.basedOn", { id: p.id, version: p.baseVersion })}
                </span>
              </div>
              <p className="font-semibold break-words">{p.reason}</p>
              <div className="text-xs text-muted-foreground">
                {p.author} · {formatTime(p.createdAt)}
                {sourceText(p.source)}
                {p.reviewer && p.status !== "pending" ? ` · ${t(`proposals.decided.${p.status}`, { who: p.reviewer, time: formatTime(p.decidedAt) })}` : ""}
              </div>
              {p.reviewNote ? <Notice tone="info">{p.reviewNote}</Notice> : null}
            </div>
            <Button variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? t("proposals.hideChanges") : t("proposals.showChanges")}
            </Button>
          </div>
          {open ? (
            <>
              {stale && p.status === "pending" ? (
                <Notice tone="warn">
                  {t("proposals.stale", { version: current.data?.version ?? 0 })}
                </Notice>
              ) : null}
              <ErrorNote error={current.error} />
              {current.loading ? <Empty>{t("common.loading")}</Empty> : <Diff before={current.data?.content ?? ""} after={p.content} />}
            </>
          ) : null}
          {contextOnly ? <p className="m-0 text-xs text-fg-muted">{t("proposals.needsContext")}</p> : null}
          {manage ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="min-w-48 flex-1"
                placeholder={t("proposals.rejectReason")}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                aria-label={t("proposals.rejectReasonLabel")}
              />
              <Button
                variant="ghost"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => decide("reject")}
                disabled={action.busy}
              >
                {t("proposals.reject")}
              </Button>
              <Button onClick={() => decide("approve")} disabled={action.busy}>
                {t("proposals.approve")}
              </Button>
            </div>
          ) : null}
          <ErrorNote error={action.error} />
        </CardContent>
      </Card>
    </article>
  );
}
