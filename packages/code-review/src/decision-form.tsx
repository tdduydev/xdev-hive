import type { CodeReviewDecideInput, CodeReviewDetail, RejectRoute } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Textarea } from "@xdev-hive/ui/textarea";
import { useId, useState } from "react";
import { shortSha } from "./format.ts";
import type { CodeReviewText } from "./text.ts";

export type DecisionSubmit = Pick<CodeReviewDecideInput, "headSha" | "decision" | "note" | "route">;

/** Cảnh báo "PR đã có commit mới": hub từ chối quyết định gửi kèm `headSha` cũ nên chặn luôn từ phía giao diện. */
export function StaleNotice({
  latestHeadSha,
  onReload,
  t,
}: {
  latestHeadSha: string;
  onReload?: (() => void) | undefined;
  t: CodeReviewText;
}) {
  return (
    <Alert className="flex flex-wrap items-center justify-between gap-2 border-transparent bg-warning-soft text-warning">
      <span className="flex-1">{t.staleText(shortSha(latestHeadSha))}</span>
      {onReload && (
        <Button size="sm" variant="outline" onClick={onReload}>
          {t.reload}
        </Button>
      )}
    </Alert>
  );
}

/** Quyết định của người duyệt ở checkpoint `human`: duyệt, hoặc trả lại với ghi chú bắt buộc và hướng trả. */
export function DecisionForm({
  detail,
  latestHeadSha,
  pending,
  error,
  onDecide,
  onReload,
  t,
}: {
  detail: CodeReviewDetail;
  latestHeadSha?: string | null | undefined;
  pending: boolean;
  error?: string | null | undefined;
  onDecide: (input: DecisionSubmit) => void;
  onReload?: (() => void) | undefined;
  t: CodeReviewText;
}) {
  const ids = { note: useId(), route: useId() };
  const previous = detail.previousGate ? detail.gates.find((g) => g.gateId === detail.previousGate) : undefined;
  const defaultRoute = detail.currentGate?.onReject ?? "agent";
  const [note, setNote] = useState("");
  const [route, setRoute] = useState<RejectRoute>(defaultRoute === "previous" && !previous ? "agent" : defaultRoute);
  const [missingNote, setMissingNote] = useState(false);

  const stale = !!latestHeadSha && latestHeadSha !== detail.pr.headSha;
  const off = !detail.canDecide || stale || pending;
  const gate = detail.gate;
  const approvals = gate ? (detail.gates.find((g) => g.gateId === gate.id)?.approvals.length ?? 0) : 0;
  const quorum = detail.currentGate?.reviewers?.quorum;
  const agentLeft = detail.maxAgentRevisions - detail.agentRevisions;

  const send = (decision: "approve" | "changes") => {
    if (decision === "changes" && !note.trim()) {
      setMissingNote(true);
      return;
    }
    setMissingNote(false);
    onDecide({
      headSha: detail.pr.headSha,
      decision,
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(decision === "changes" ? { route } : {}),
    });
  };

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-card px-4 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-1.5">
        <h2 className="m-0 text-sm font-semibold">{t.decision}</h2>
        {quorum !== undefined && (
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {quorum > 0 ? t.quorum(approvals, quorum) : t.quorumAll(approvals)}
          </span>
        )}
      </div>
      {stale && <StaleNotice latestHeadSha={latestHeadSha} onReload={onReload} t={t} />}
      {!detail.canDecide && gate && (
        <Alert role="status" className="bg-muted text-muted-foreground">
          {t.notYours(gate.name)}
        </Alert>
      )}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={ids.note} className="text-[0.8125rem] font-medium">
          {t.note}
        </label>
        <Textarea
          id={ids.note}
          value={note}
          disabled={off}
          aria-invalid={missingNote}
          aria-describedby={`${ids.note}-hint`}
          onChange={(e) => {
            setNote(e.target.value);
            if (e.target.value.trim()) setMissingNote(false);
          }}
        />
        <span
          id={`${ids.note}-hint`}
          className={missingNote ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
        >
          {missingNote ? t.noteRequired : t.noteHint}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={ids.route} className="text-[0.8125rem] font-medium">
          {t.ifReturn}
        </label>
        <NativeSelect
          id={ids.route}
          value={route}
          disabled={off}
          onChange={(e) => setRoute(e.target.value as RejectRoute)}
        >
          <option value="agent">{t.route.agent}</option>
          <option value="author">{t.route.author}</option>
          <option value="previous" disabled={!previous}>
            {previous ? t.routePrevious(previous.name) : t.route.previous}
          </option>
        </NativeSelect>
        {route === "agent" && (
          <span className="text-xs text-muted-foreground">
            {agentLeft > 0 ? t.agentLeft(agentLeft, detail.maxAgentRevisions) : t.agentExhausted}
          </span>
        )}
      </div>
      {error && <Alert variant="destructive">{error}</Alert>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="destructive" disabled={off} onClick={() => send("changes")}>
          {pending ? t.sending : t.requestChanges}
        </Button>
        <Button disabled={off} onClick={() => send("approve")}>
          {pending ? t.sending : t.approve}
        </Button>
      </div>
      <span className="font-mono text-[0.71875rem] text-muted-foreground">
        {t.shaBound} {shortSha(detail.pr.headSha)}
      </span>
    </div>
  );
}

/** Quyết thay checkpoint tự động (quyền `reviews.override`): lý do bắt buộc, ghi vào audit. */
export function OverrideForm({
  detail,
  latestHeadSha,
  pending,
  error,
  onOverride,
  onRecheck,
  t,
}: {
  detail: CodeReviewDetail;
  latestHeadSha?: string | null | undefined;
  pending: boolean;
  error?: string | null | undefined;
  onOverride: (input: { headSha: string; passed: boolean; note: string }) => void;
  onRecheck?: (() => void) | undefined;
  t: CodeReviewText;
}) {
  const id = useId();
  const [note, setNote] = useState("");
  const [missing, setMissing] = useState(false);
  const stale = !!latestHeadSha && latestHeadSha !== detail.pr.headSha;
  const off = stale || pending;

  const send = (passed: boolean) => {
    if (!note.trim()) {
      setMissing(true);
      return;
    }
    setMissing(false);
    onOverride({ headSha: detail.pr.headSha, passed, note: note.trim() });
  };

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-card px-4 py-3.5">
      <h2 className="m-0 text-sm font-semibold">{t.override}</h2>
      <Alert className="border-transparent bg-warning-soft text-warning">{t.waitingMachine}</Alert>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-[0.8125rem] font-medium">
          {t.reason} *
        </label>
        <Textarea
          id={id}
          value={note}
          placeholder={t.reasonHint}
          disabled={off}
          aria-invalid={missing}
          aria-describedby={`${id}-hint`}
          onChange={(e) => {
            setNote(e.target.value);
            if (e.target.value.trim()) setMissing(false);
          }}
        />
        <span id={`${id}-hint`} className={missing ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          {missing ? t.reasonRequired : t.reasonNeed}
        </span>
      </div>
      {error && <Alert variant="destructive">{error}</Alert>}
      <div className="flex flex-wrap justify-end gap-2">
        {detail.canRecheck && onRecheck && (
          <Button variant="ghost" disabled={pending} onClick={onRecheck}>
            {t.recheck}
          </Button>
        )}
        <Button variant="destructive" disabled={off} onClick={() => send(false)}>
          {t.overrideFail}
        </Button>
        <Button variant="outline" disabled={off} onClick={() => send(true)}>
          {t.overridePass}
        </Button>
      </div>
    </div>
  );
}
