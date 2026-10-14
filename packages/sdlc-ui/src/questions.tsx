import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SdlcQuestion } from "@xdev-hive/contracts";
import { Alert, AlertDescription, AlertTitle } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Label } from "@xdev-hive/ui/label";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { cn } from "cn";
import { useId, useState } from "react";
import { useSdlcEnv, useText } from "./env.tsx";
import { formatWhen } from "./format.ts";
import { EmptyState } from "./parts.tsx";

type Draft = { option?: string; text?: string };
type Answer = { id: string; answer?: string; useRecommended?: boolean };

/** Lời trả lời gửi hub: chữ tự viết thắng lựa chọn; chọn đúng đề xuất thì gửi `useRecommended` để audit ghi đúng nguồn. */
export function answerOf(q: SdlcQuestion, draft: Draft | undefined): Answer | null {
  const text = draft?.text?.trim();
  if (text) return { id: q.id, answer: text };
  if (!draft?.option) return null;
  if (draft.option === q.recommended) return { id: q.id, useRecommended: true };
  return { id: q.id, answer: draft.option };
}

function groupByItem(questions: SdlcQuestion[]) {
  const groups = new Map<string, SdlcQuestion[]>();
  for (const q of questions) groups.set(q.itemId, [...(groups.get(q.itemId) ?? []), q]);
  return [...groups.values()].map((qs) => qs.toSorted((a, b) => a.round - b.round || a.position - b.position));
}

export interface QuestionsProps {
  /** Chỉ câu hỏi của một hạng mục (tab Câu hỏi của chi tiết); bỏ trống là "Câu hỏi chờ tôi". */
  itemId?: string | undefined;
  /** Ẩn tiêu đề trang khi nhúng trong chi tiết hạng mục. */
  embedded?: boolean | undefined;
}

/**
 * Câu hỏi của agent (AppSdlcQuestions.dc.html): chọn một lựa chọn, dùng đề xuất, hoặc tự viết. Gửi theo từng hạng mục vì
 * agent soạn lại khi đủ câu trả lời của vòng; lỗi gửi giữ nguyên nội dung đã nhập.
 */
export function Questions({ itemId, embedded = false }: QuestionsProps) {
  const { api, can, lang, errorMessage } = useSdlcEnv();
  const t = useText();
  const q = t.questions;
  const [tab, setTab] = useState<"pending" | "answered">("pending");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const queryClient = useQueryClient();

  const scope = itemId ? { scope: "all" as const, itemId } : { scope: "mine" as const };
  const list = useQuery(
    api.sdlc.questions.list.queryOptions({ input: { ...scope, openOnly: tab === "pending", limit: 100 } }),
  );
  const answer = useMutation(
    api.sdlc.questions.answer.mutationOptions({
      onSuccess: (answered) => {
        setDrafts((prev) => {
          const next = { ...prev };
          for (const a of answered) delete next[a.id];
          return next;
        });
        void queryClient.invalidateQueries({ queryKey: api.sdlc.key() });
      },
    }),
  );
  const readOnly = !can.write();
  const items = (list.data?.items ?? []).filter((x) =>
    tab === "pending" ? x.status === "open" : x.status === "answered",
  );
  const setDraft = (id: string, draft: Draft) => setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...draft } }));
  const send = (answers: Answer[]) => {
    const first = items.find((x) => x.id === answers[0]?.id);
    if (first && answers.length) answer.mutate({ itemId: first.itemId, answers });
  };

  let body: React.ReactNode;
  if (list.isPending) {
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        {q.loading}
      </p>
    );
  } else if (list.isError) {
    body = (
      <Alert variant="destructive">
        <AlertTitle>{q.loadError}</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2">
          {errorMessage(list.error)}
          <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
            {t.retry}
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (!items.length) {
    body =
      tab === "pending" ? (
        <EmptyState title={q.emptyTitle} text={q.emptyText} />
      ) : (
        <EmptyState title={q.noAnsweredTitle} text={q.answeredNote} />
      );
  } else if (tab === "answered") {
    body = (
      <ul className="flex flex-col gap-2">
        {items.map((x) => (
          <li key={x.id} className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3 text-sm">
            <span className="text-xs text-muted-foreground">
              {x.item.projectKey} · {x.item.ref} · {q.round(x.round)}
            </span>
            <p className="font-medium">{x.text}</p>
            <p>{x.answer}</p>
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {x.usedRecommended && <Pill small>{q.usedSuggestion}</Pill>}
              {x.answeredBy?.name}
              {x.answeredAt && ` · ${formatWhen(x.answeredAt, lang)}`}
            </span>
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        {answer.isError && (
          <Alert variant="destructive">
            <AlertTitle>{q.sendError}</AlertTitle>
            <AlertDescription>
              {errorMessage(answer.error)} {q.keptInput}
            </AlertDescription>
          </Alert>
        )}
        {groupByItem(items).map((group) => {
          const ready = group.map((x) => answerOf(x, drafts[x.id])).filter((a): a is Answer => !!a);
          return (
            <QuestionGroup
              key={group[0]?.itemId}
              questions={group}
              drafts={drafts}
              showItem={!itemId}
              disabled={readOnly || answer.isPending}
              onDraft={setDraft}
              onUseRecommended={(id) => send([{ id, useRecommended: true }])}
              onSend={() => send(ready)}
              readyCount={ready.length}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {!embedded && (
        <header className="flex flex-col gap-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            {q.title}
            {readOnly && <Pill>{t.readOnly}</Pill>}
          </h1>
          <p className="max-w-prose text-sm text-muted-foreground">{q.lead}</p>
        </header>
      )}
      <div role="tablist" aria-label={q.title} className="inline-flex self-start rounded-lg bg-muted p-0.5">
        {(
          [
            ["pending", q.tabPending],
            ["answered", q.tabAnswered],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              "min-h-7 rounded-md px-3 text-sm max-sm:min-h-9",
              tab === key ? "bg-card font-semibold shadow-sm" : "text-muted-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {body}
      <p className="text-xs text-muted-foreground">{q.maxNote}</p>
    </div>
  );
}

function QuestionGroup(props: {
  questions: SdlcQuestion[];
  drafts: Record<string, Draft>;
  showItem: boolean;
  disabled: boolean;
  readyCount: number;
  onDraft: (id: string, draft: Draft) => void;
  onUseRecommended: (id: string) => void;
  onSend: () => void;
}) {
  const { link } = useSdlcEnv();
  const t = useText().questions;
  const head = props.questions[0];
  if (!head) return null;
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      {props.showItem && (
        <h2 className="flex flex-wrap items-baseline gap-2 text-base font-semibold">
          {link({
            to: { kind: "item", projectKey: head.item.projectKey, number: Number(head.item.ref), tab: "questions" },
            className: "hover:underline",
            children: `${head.item.ref} · ${head.item.title}`,
          })}
          <span className="font-mono text-xs font-normal text-muted-foreground">{head.item.projectKey}</span>
          <span className="text-xs font-normal text-muted-foreground">{t.round(head.round)}</span>
        </h2>
      )}
      <ol className="flex flex-col gap-4">
        {props.questions.map((x, i) => (
          <QuestionCard
            key={x.id}
            index={i + 1}
            question={x}
            draft={props.drafts[x.id]}
            disabled={props.disabled}
            onDraft={(d) => props.onDraft(x.id, d)}
            onUseRecommended={() => props.onUseRecommended(x.id)}
          />
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={props.disabled || !props.readyCount} onClick={props.onSend}>
          {t.send(props.readyCount, props.questions.length)}
        </Button>
      </div>
    </section>
  );
}

function QuestionCard(props: {
  index: number;
  question: SdlcQuestion;
  draft: Draft | undefined;
  disabled: boolean;
  onDraft: (draft: Draft) => void;
  onUseRecommended: () => void;
}) {
  const t = useText().questions;
  const ids = useId();
  const { question: x, draft } = props;
  return (
    <li className="flex flex-col gap-2">
      <p className="font-medium">
        <span className="mr-1 font-mono text-muted-foreground">{props.index}.</span>
        {x.text}
      </p>
      {x.context && <p className="text-xs text-muted-foreground">{x.context}</p>}
      {x.options.length > 0 && (
        <fieldset className="flex flex-col gap-1" disabled={props.disabled}>
          <legend className="sr-only">{x.text}</legend>
          {x.options.map((opt) => (
            <label
              key={opt}
              className="flex min-h-9 items-center gap-2 rounded-md border border-border px-2 text-sm has-checked:border-ring has-checked:bg-accent"
            >
              <input
                type="radio"
                name={`${ids}-opt`}
                checked={draft?.option === opt}
                onChange={() => props.onDraft({ option: opt })}
              />
              <span className="min-w-0 flex-1">{opt}</span>
              {opt === x.recommended && (
                <Pill tone="sel" small>
                  {t.sugBadge}
                </Pill>
              )}
            </label>
          ))}
        </fieldset>
      )}
      {x.recommended && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            {t.sugBy} <strong className="text-foreground">{x.recommended}</strong>
          </span>
          <Button variant="outline" size="xs" disabled={props.disabled} onClick={props.onUseRecommended}>
            {t.useSug}
          </Button>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${ids}-free`} className="text-xs text-muted-foreground">
          {t.free}
        </Label>
        <Textarea
          id={`${ids}-free`}
          rows={2}
          placeholder={t.freeHint}
          disabled={props.disabled}
          value={draft?.text ?? ""}
          onChange={(e) => props.onDraft({ text: e.target.value })}
        />
      </div>
    </li>
  );
}

/** Số câu hỏi đang chờ người xem, cho badge của menu "Câu hỏi chờ tôi". */
export function useOpenQuestionCount(): number {
  const { api } = useSdlcEnv();
  const count = useQuery({ ...api.sdlc.questions.count.queryOptions(), refetchInterval: 60_000 });
  return count.data?.open ?? 0;
}
