import { diffFixInstructions, reviewFiles, reviewRisks } from "#ui/lib/diff-review.ts";
import { useId, useMemo, useState } from "react";
import { validDiffReview, type DiffReview } from "@xdev-hive/core";
import { Diff } from "#ui/components/Diff.tsx";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { ErrorNote, Notice } from "#ui/components/common.tsx";
import { useAction, useHive } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import type { DiffFile } from "#ui/lib/runlog.ts";

export interface DiffFixTarget { machineId: string; project: string; taskId: string }

export function RunDiff({ files, review, fix }: { files: DiffFile[]; review?: DiffReview | null; fix?: DiffFixTarget }) {
  const t = useT();
  const { client } = useHive();
  const action = useAction();
  const id = useId();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);
  const parsed = useMemo(() => reviewFiles(files), [files]);
  const summary = review && validDiffReview(review, parsed);
  const groups = summary?.groups ?? parsed.map(f => ({ title: f.path, explanation: "", files: [f.path] }));
  const risks = reviewRisks(parsed, summary || null);
  const anchor = (path: string, hunk: number) => `${id}-${encodeURIComponent(path)}-${hunk}`;
  const entries = Object.entries(notes).filter(([, note]) => note.trim());
  const instructions = diffFixInstructions(parsed, notes);
  const payload = `${t("diffReview.fixBrief")}\n\n${instructions}`;
  return <div className="flex min-w-0 flex-col gap-3 p-3.5 text-[13px] text-fg-strong [overflow-wrap:anywhere]">
    {!summary ? <p className="m-0 text-fg-muted">{t("diffReview.unavailable")}</p> : null}
    {risks.length ? <nav aria-label={t("diffReview.risks")} className="flex flex-wrap gap-2">
      {risks.map((r, i) => <a key={i} href={`#${anchor(r.path, r.hunk)}`} onClick={event => {
        // The app uses hash routing; moving focus must not replace its route.
        event.preventDefault();
        const target = document.getElementById(anchor(r.path, r.hunk));
        target?.scrollIntoView({ block: "center" }); target?.focus({ preventScroll: true });
      }} className="inline-flex min-h-11 items-center rounded-md border border-line-default bg-subtle px-3 text-xs text-fg-strong focus-visible:focus-ring" title={r.explanation}>
        {t(`diffReview.level.${r.level}`)} · {t(`diffReview.kind.${r.kind}`)} · {r.path}
      </a>)}
    </nav> : null}
    {groups.map((group, gi) => <section key={gi} className="flex min-w-0 flex-col gap-2">
      <h3 className="m-0 text-sm font-semibold">{group.title}</h3>
      {group.explanation ? <p className="m-0 text-fg-secondary">{group.explanation}</p> : null}
      {group.files.map(path => {
        const fileIndex = parsed.findIndex(f => f.path === path);
        const file = parsed[fileIndex]!;
        return <div key={path} id={!file.hunks.length ? anchor(path, 0) : undefined} tabIndex={!file.hunks.length ? -1 : undefined} className="flex min-w-0 flex-col gap-2 focus-visible:focus-ring">
          <h4 className="m-0 font-mono text-xs font-medium">{path}</h4>
          {file.metadata?.length ? <pre className="m-0 rounded-md border border-line-subtle bg-subtle p-2 font-mono text-xs whitespace-pre-wrap">{file.metadata.join("\n")}</pre> : null}
          {file.binary ? <p>{t("runs.binary")}</p> : !file.hunks.length ? <p className="text-fg-muted">{t("diffReview.metadata")}</p> : null}
          {file.hunks.map((h, hi) => {
            const key = `${fileIndex}:${hi}`;
            return <section id={anchor(path, hi)} key={hi} tabIndex={-1} className="min-w-0 rounded-md border border-line-subtle p-2 focus-visible:focus-ring">
              <p className="m-0 mb-2 font-mono text-xs">{h.header}</p>
              {risks.filter(r => r.path === path && r.hunk === hi).map((r, ri) => <p key={ri} className="my-1 text-xs">{t(`diffReview.level.${r.level}`)} · {t(`diffReview.kind.${r.kind}`)}{r.explanation ? `: ${r.explanation}` : ""}</p>)}
              <Diff before={h.before} after={h.after} />
              {fix && !sent ? <div className="mt-2">
                <Button size="sm" className="min-h-11" disabled={action.busy} aria-expanded={key in notes} onClick={() => setNotes(old => {
                  const next = { ...old }; if (key in next) delete next[key]; else next[key] = ""; return next;
                })}>{t("diffReview.request")}</Button>
                {key in notes ? <label className="mt-2 flex flex-col gap-1">{t("diffReview.note")}
                  <textarea className="min-h-22 w-full rounded-md border border-line-default bg-surface p-2 text-base text-fg-strong focus-visible:focus-ring" maxLength={2000} disabled={action.busy} value={notes[key]} onChange={e => setNotes(old => ({ ...old, [key]: e.target.value }))} />
                </label> : null}
              </div> : null}
            </section>;
          })}
        </div>;
      })}
    </section>)}
    {fix && entries.length && !sent ? <div className="flex flex-col gap-2">
      <Button className="min-h-11 self-start" disabled={action.busy || payload.length > 4000} onClick={() => void action.run(async () => {
        await client.call("runs.dispatch", { ...fix, role: "implement", profileId: null, reviewAfter: true, candidates: 1, instructions: payload });
        setSent(true);
      })}>{t("diffReview.send", { count: entries.length })}</Button>
      {payload.length > 4000 ? <p className="m-0 text-danger">{t("diffReview.tooLong")}</p> : null}
      <ErrorNote error={action.error} />
    </div> : null}
    {sent ? <Notice tone="ok">{t("diffReview.sent")}</Notice> : null}
  </div>;
}
