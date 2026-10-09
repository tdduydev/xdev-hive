// Skills (docs/design/2026-09-redesign, xDev Hive Client): the team's (org/skills/<name>) and each project's
// (project/<p>/skills/<name>). Sync writes them into .claude/skills of the repos; Codex and Gemini find them through
// AGENTS.md and skill_get. A list on the left; the skill's SKILL.md on the right, edited as a form (name, description,
// instructions) that builds the front matter.
import { useEffect, useMemo, useRef, useState } from "react";
import { parseDocKey, parseSkill, SKILL_DESCRIPTION_MAX, SKILL_NAME, skillDocKey, stripHidden, type Proposal } from "@xdev-hive/core";
import { cn } from "cn";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Diff } from "#ui/components/Diff.tsx";
import { HiddenChars } from "#ui/components/HiddenChars.tsx";
import { ErrorNote, Notice } from "#ui/components/common.tsx";
import { MobileBack } from "#ui/components/MobileDetail.tsx";
import { KvRows, PaneEmpty } from "#ui/components/panes.tsx";
import { errorMessage, formatTime, useAction, useCan, useHive, useHashParam, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { emptyState } from "#ui/lib/empty.ts";
import { docOwner, inScope, scopeProject } from "#ui/lib/scope.ts";
import { buildSkill, filterSkills, skillsFor, splitSkill, type ListedSkill, type SkillParts } from "#ui/lib/skills.ts";
import { fold } from "#ui/lib/text.ts";
import { useMobileDetail } from "#ui/lib/mobile-detail.ts";
import { useToast } from "#ui/shell/toast.tsx";

const NEW = "new";


export function SkillsPage() {
  const { client, scope, projects } = useHive();
  const t = useT();
  const allow = useCan();
  const project = scopeProject(scope);
  const [tick, setTick] = useState(0);
  const list = useQuery(() => client.call("skills.list", {}), [client, tick]);
  const pending = useQuery(() => client.call("proposals.list", { status: "pending" }), [client, tick]);
  const skills = useMemo(() => {
    const all = list.data ?? [];
    if (scope.kind === "shared") return skillsFor(all, null).filter((s) => s.project === null);
    // A system: the team's skills and those of its projects.
    if (scope.kind === "system") return skillsFor(all.filter((s) => s.project === null || scope.projects.includes(s.project)), null);
    return skillsFor(all, project);
  }, [list.data, scope, project]);
  // Proposals on skills in view: agents send them with skill_propose, people from this page.
  const proposals = useMemo(
    () => (pending.data ?? []).filter((p) => parseDocKey(p.docKey).skill && inScope(scope, docOwner(p.docKey))),
    [pending.data, scope],
  );
  // Where a new skill may go: the team's (Chung), then the projects this person manages.
  const owners = useMemo(() => [...(allow(null, "contextEdit") ? [""] : []), ...projects.filter((p) => allow(p, "contextEdit"))], [projects, allow]);
  const [selected, setSelected] = useState<string | null>(null);
  const mobileDetail = useMobileDetail("skill");
  const [wanted, clearWanted] = useHashParam("skill");
  useEffect(() => {
    if (!mobileDetail.mobile && wanted && skills.some((s) => s.key === wanted)) { setSelected(wanted); clearWanted(); }
  }, [wanted, skills, mobileDetail.mobile, clearWanted]);

  const pick = (key: string | null) => {
    setSelected(key);
    if (mobileDetail.mobile) mobileDetail.navigate(key);
  };
  const current = skills.find((s) => s.key === (mobileDetail.mobile ? mobileDetail.value : selected)) ?? null;
  // A skill just created is selected before the list that has it comes back.
  const created = useRef<string | null>(null);
  useEffect(() => {
    if (current) created.current = null;
    if (!list.data || selected === NEW || current || (selected && selected === created.current)) return;
    if (mobileDetail.mobile) return;
    setSelected(skills[0]?.key ?? null);
  }, [list.data, selected, current, skills]);
  const reload = () => setTick((n) => n + 1);

  const [unused, setUnused] = useState(false);
  const [q, setQ] = useState("");
  const needle = fold(q.trim());
  const shown = filterSkills(skills, q, unused);
  const empty = emptyState({ loaded: Boolean(list.data), total: skills.length, shown: shown.length, query: needle });
  // The first skill is the thing to do when there is none: the same button as the toolbar's, where the eye already is.
  const firstSkill = owners.length ? (
    <Button variant="glass" size="sm" data-empty-action onClick={() => pick(NEW)}>
      {t("skills.newFirst")}
    </Button>
  ) : null;
  const showing = mobileDetail.mobile ? mobileDetail.value : selected;

  return (
    <div className="flex flex-wrap items-start gap-4 px-7 py-4" data-skills-page>
      <div className={cn("flex max-w-full flex-[1_1_300px] flex-col gap-1 rounded-[24px] bg-[var(--surface-1)] px-2 py-3 shadow-[var(--ring-glass)]", mobileDetail.showingDetail && "max-md:hidden")} aria-label={t("nav.skills")}>
        <div className="flex gap-1.5 px-1 pb-1">
          <Input controlSize="sm" className="min-w-0 flex-1" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("skills.search")} aria-label={t("skills.search")} />
          {owners.length ? (
            <Button variant="glass" size="sm" onClick={() => pick(NEW)}>
              {t("skills.new")}
            </Button>
          ) : null}
        </div>
        <ErrorNote error={list.error} />
        <label className="flex min-h-11 cursor-pointer items-center gap-2 px-2 text-[var(--text-muted)] [font:var(--design-caption)]">
          <input type="checkbox" checked={unused} onChange={(e) => setUnused(e.target.checked)} />
          {t("skills.unused")}
        </label>
        {project ? <p className="m-0 px-2 pt-1 pb-2 text-[var(--text-muted)] [font:var(--design-caption)]">{t("skills.effectiveFor", { project })}</p> : null}
        {proposals.length ? (
          <a className="mx-1 mb-1 rounded-[8px] bg-[var(--status-warning-bg)] px-2 py-1.5 text-[var(--status-warning-fg)] no-underline [font:var(--design-caption)] hover:underline" href="#/skills?tab=pending">
            {t("skills.pendingNotice", { count: proposals.length })} {t("skills.openProposals")}
          </a>
        ) : null}
        {shown.map((s) => {
          const waiting = proposals.filter((p) => p.docKey === s.key).length;
          const on = s.key === showing;
          const tag = [s.project ? t("skills.privateTo", { project: s.project }) : t("common.sharedTeam"), s.overrides ? t("skills.overrides") : s.overridden ? t("skills.overridden") : null].filter(Boolean).join(" · ");
          return (
            <button
              key={s.key}
              type="button"
              aria-pressed={on}
              onClick={() => pick(s.key)}
              className={cn(
                "flex cursor-pointer flex-col gap-1 rounded-[16px] border-0 px-[14px] py-3 text-left font-[inherit] text-[var(--text-strong)] hover:bg-[var(--glass-bg)]",
                on ? "bg-[var(--tint-violet-soft)] shadow-[var(--ring-violet)]" : "bg-transparent shadow-none",
                s.overridden && "opacity-45",
              )}
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="flex-1 text-[13px]/[18px] font-semibold [font-family:var(--font-code-design)]">{s.name}</span>
                {waiting ? <span className="inline-flex h-5 items-center rounded-full bg-[var(--tint-violet)] px-2 text-[var(--violet-soft)] [font:var(--design-micro)]">{t("skills.proposalCount", { count: waiting })}</span> : null}
              </span>
              <span className="text-pretty text-[var(--text-secondary)] [font:var(--design-caption)]">{s.description || t("skills.noDescription")}</span>
              <span className={cn("[font:var(--design-micro)]", s.overridden ? "text-[var(--text-faint)]" : s.project ? "text-[var(--violet-soft)]" : "text-[var(--text-muted)]")}>{tag}</span>
            </button>
          );
        })}
        {empty ? <PaneEmpty action={empty === "none" ? firstSkill : null}>{t(empty === "none" ? "skills.none" : "skills.noMatch")}</PaneEmpty> : null}
      </div>
      <div className={cn("flex min-w-0 flex-[999_1_480px] flex-col gap-4 rounded-[24px] bg-[var(--surface-1)] p-6 shadow-[var(--ring-glass)]", mobileDetail.mobile && !mobileDetail.showingDetail && "max-md:hidden")}>
        {mobileDetail.showingDetail ? <MobileBack onClick={() => pick(null)} /> : null}
        {showing === NEW ? (
          <NewSkill
            owners={owners}
            defaultOwner={project && owners.includes(project) ? project : (owners[0] ?? "")}
            taken={new Set((list.data ?? []).map((s) => s.key))}
            onCancel={() => pick(null)}
            onCreated={(key) => {
              created.current = key;
              pick(key);
              reload();
            }}
          />
        ) : current ? (
          <SkillEditor key={current.key} skill={current} proposals={proposals.filter((p) => p.docKey === current.key)} onSaved={reload} />
        ) : (
          <div className="grid place-items-center p-6">
            {empty === "none" ? null : list.data ? <span className="text-[13px] text-[var(--text-muted)]">{t("skills.pick")}</span> : null}
          </div>
        )}
      </div>
    </div>
  );
}

/** Name, description and instructions of a skill, laid out as the template's form; `nameLocked` for one that exists (its key holds the name). */
function SkillFields({
  parts,
  onChange,
  readOnly,
  nameLocked,
  idPrefix,
}: {
  parts: SkillParts;
  onChange: (next: SkillParts) => void;
  readOnly: boolean;
  nameLocked: boolean;
  idPrefix: string;
}) {
  const t = useT();
  const label = "text-[13px]/[18px] font-semibold";
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-name`} className={label}>
          {t("skills.name")}
        </Label>
        <Input id={`${idPrefix}-name`} value={parts.name} readOnly={readOnly || nameLocked} placeholder="review-pr" onChange={(e) => onChange({ ...parts, name: e.target.value.trim().toLowerCase() })} />
        {nameLocked ? null : <p className="m-0 text-[var(--text-muted)] [font:var(--design-caption)]">{t("skills.nameHint")}</p>}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-description`} className={cn("flex", label)}>
          <span className="flex-1">{t("skills.descriptionLabel")}</span>
          <span className="tabular-nums text-[var(--text-muted)] [font:var(--design-caption)]">
            {parts.description.length}/{SKILL_DESCRIPTION_MAX}
          </span>
        </Label>
        <Textarea
          id={`${idPrefix}-description`}
          rows={3}
          className="min-h-0 resize-y rounded-[14px] border-0 bg-[var(--surface-sunken)] px-[14px] py-3 text-[var(--text-strong)] shadow-[var(--ring-glass)] outline-none [font:var(--design-body-sm)]"
          value={parts.description}
          readOnly={readOnly}
          maxLength={SKILL_DESCRIPTION_MAX}
          placeholder={t("skills.descriptionPlaceholder")}
          onChange={(e) => onChange({ ...parts, description: e.target.value.replace(/\s*\n\s*/g, " ") })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-body`} className={label}>
          {t("skills.body")}
        </Label>
        <Textarea
          id={`${idPrefix}-body`}
          className="min-h-[8rem] resize-y rounded-[14px] border-0 bg-[var(--code-well)] px-4 py-3.5 text-[12.5px]/[21px] font-medium text-[var(--code-well-fg)] shadow-[var(--ring-glass)] outline-none field-sizing-content [overflow-wrap:anywhere] whitespace-pre-wrap [font-family:var(--font-code-design)] md:text-[12.5px]"
          value={parts.body}
          readOnly={readOnly}
          spellCheck={false}
          placeholder={t("skills.bodyPlaceholder")}
          onChange={(e) => onChange({ ...parts, body: e.target.value })}
        />
      </div>
      {parts.extra.length ? <p className="m-0 text-xs break-all text-[var(--text-muted)] [font-family:var(--font-code-design)]">{t("skills.extra", { keys: parts.extra.join(" · ") })}</p> : null}
    </>
  );
}

function SkillEditor({ skill, proposals, onSaved }: { skill: ListedSkill; proposals: Proposal[]; onSaved: () => void }) {
  const { client, bump } = useHive();
  const t = useT();
  const allow = useCan();
  const toast = useToast();
  const doc = useQuery(() => client.call("docs.get", { key: skill.key }), [client, skill.key]);
  const stored = doc.data?.content ?? "";
  const [parts, setParts] = useState<SkillParts>(() => splitSkill(""));
  const [note, setNote] = useState("");
  const [showDiff, setShowDiff] = useState(false);
  const action = useAction();
  useEffect(() => {
    if (doc.data) setParts(splitSkill(doc.data.content));
  }, [doc.data]);
  // Skills are what agents read: their own permission (roadmap 25).
  const canEdit = allow(skill.project, "contextEdit");
  const canPropose = !canEdit && allow(skill.project, "docPropose");
  const content = buildSkill(parts);
  // Compared as the form writes it, so a stored file with other spacing is not "changed" just by opening it.
  const dirty = Boolean(doc.data) && content !== buildSkill(splitSkill(stored));
  const unchecked = Boolean(doc.data) && !/^---\r?\n/.test(stored);
  const desktop = client.desktop;
  const settings = useQuery(async () => (desktop ? desktop.settings() : null), [desktop]);
  // Where "write to the repos" goes: the skill's project, or every repo here for a team skill.
  const repos = (settings.data?.projects ?? []).map((p) => p.name).filter((p) => skill.project === null || p === skill.project);

  const send = (kind: "save" | "propose") =>
    action.run(async () => {
      try {
        parseSkill(content);
      } catch (err) {
        throw new Error(errorMessage(err));
      }
      if (kind === "save") {
        const saved = await client.call("docs.save", { key: skill.key, content, note: note.trim() || undefined, baseVersion: doc.data?.version ?? 0 });
        toast(t("skills.savedToast", { name: skill.name, version: saved.version }));
        doc.reload();
      } else {
        await client.call("proposals.create", { docKey: skill.key, baseVersion: doc.data?.version ?? 0, content, reason: note.trim() || t("skills.proposeDefaultReason") });
        toast(t("skills.proposedToast", { name: skill.name }));
        setParts(splitSkill(stored));
        bump();
      }
      setNote("");
      setShowDiff(false);
      onSaved();
    });

  const writeRepos = () =>
    void action.run(async () => {
      for (const p of repos) await desktop!.syncProject(p);
      toast(t("skills.wroteRepo", { name: skill.name, projects: repos.join(", ") }));
    });

  const editable = canEdit || canPropose;
  return (
    <>
      {skill.overrides ? <Notice tone="info">{t("skills.overridesHint")}</Notice> : null}
      {skill.overridden ? <Notice tone="info">{t("skills.overriddenHint")}</Notice> : null}
      {unchecked ? <Notice tone="warn">{t("skills.noFrontMatter")}</Notice> : null}
      {proposals.length ? (
        <div className="flex flex-col gap-1.5 rounded-[12px] bg-[var(--status-warning-bg)] p-3">
          <span className="text-xs font-semibold text-[var(--status-warning-fg)]">{t("skills.pendingTitle")}</span>
          {proposals.map((p) => (
            <a key={p.id} href="#/skills?tab=pending" className="text-xs text-[var(--status-warning-fg)] [overflow-wrap:anywhere] hover:underline">
              #{p.id} · {p.reason} · {p.author} · {formatTime(p.createdAt)}
            </a>
          ))}
        </div>
      ) : null}
      <ErrorNote error={doc.error} />
      {doc.loading ? <p className="m-0 text-[13px] text-[var(--text-muted)]">{t("common.loading")}</p> : null}
      <SkillFields parts={parts} onChange={setParts} readOnly={!editable} nameLocked idPrefix={`skill-${skill.key}`} />
      {editable && dirty ? (
        <>
          <Input placeholder={canEdit ? t("docs.notePlaceholder") : t("docs.reasonPlaceholder")} value={note} onChange={(e) => setNote(e.target.value)} aria-label={t("docs.note")} />
          <HiddenChars
            fields={[
              { label: t("skills.description"), text: parts.description },
              { label: t("skills.body"), text: parts.body },
              { label: t("docs.note"), text: note },
            ]}
            onStrip={() => (setParts({ ...parts, description: stripHidden(parts.description), body: stripHidden(parts.body) }), setNote(stripHidden(note)))}
          />
          {showDiff ? <Diff before={stored} after={content} /> : null}
        </>
      ) : null}
      <ErrorNote error={action.error} />
      <div className="flex flex-wrap items-center gap-2.5">
        {editable ? (
          <Button variant="solid" size="md" onClick={() => { if (dirty) void send(canEdit ? "save" : "propose"); }} disabled={action.busy}>
            {action.busy ? (canEdit ? t("docs.saving") : t("docs.sending")) : canEdit ? t("skills.save") : t("docs.propose")}
          </Button>
        ) : null}
        <Button variant="glass" size="md" onClick={() => setShowDiff((v) => !v)} aria-pressed={showDiff}>
          {t("skills.changes")}
        </Button>
        {desktop ? (
          <Button variant="glass" size="md" disabled={action.busy || !repos.length} title={repos.length ? repos.join(", ") : t("skills.writeRepoNone")} onClick={writeRepos}>
            {t("skills.writeRepo")}
          </Button>
        ) : null}
        <span className="flex-1" />
        <span className="text-[var(--text-muted)] [font:var(--design-caption)]">{!editable ? t("skills.viewOnly") : t("skills.syncInto", { name: skill.name })}</span>
      </div>
      {skill.usage ? <SkillUsage skill={skill} /> : null}
    </>
  );
}

function NewSkill({
  owners,
  defaultOwner,
  taken,
  onCancel,
  onCreated,
}: {
  owners: string[];
  defaultOwner: string;
  taken: Set<string>;
  onCancel: () => void;
  onCreated: (key: string) => void;
}) {
  const { client } = useHive();
  const t = useT();
  const [owner, setOwner] = useState(defaultOwner);
  const [parts, setParts] = useState<SkillParts>({ name: "", description: "", extra: [], body: "" });
  const action = useAction();
  const key = SKILL_NAME.test(parts.name) ? skillDocKey(parts.name, owner || null) : null;
  const problem = !parts.name ? null : !key ? t("skills.nameHint") : taken.has(key) ? t("skills.exists", { key }) : null;

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-skill-owner" className="text-[13px]/[18px] font-semibold">
          {t("skills.owner")}
        </Label>
        <NativeSelect id="new-skill-owner" wrapperClassName="w-full" value={owner} onChange={(e) => setOwner(e.target.value)}>
          {owners.map((o) => (
            <NativeSelectOption key={o || "shared"} value={o}>
              {o || t("common.sharedTeam")}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <SkillFields parts={parts} onChange={setParts} readOnly={false} nameLocked={false} idPrefix="new-skill" />
      {problem ? <p className="m-0 text-xs text-[var(--status-danger-fg)]">{problem}</p> : null}
      <HiddenChars
        fields={[
          { label: t("skills.description"), text: parts.description },
          { label: t("skills.body"), text: parts.body },
        ]}
        onStrip={() => setParts({ ...parts, description: stripHidden(parts.description), body: stripHidden(parts.body) })}
      />
      <ErrorNote error={action.error} />
      <div className="flex flex-wrap items-center gap-2.5">
        <Button
          variant="solid"
          size="md"
          disabled={!key || Boolean(problem) || !parts.description.trim() || action.busy}
          onClick={() =>
            void action.run(async () => {
              const content = buildSkill(parts);
              try {
                parseSkill(content);
              } catch (err) {
                throw new Error(errorMessage(err));
              }
              await client.call("docs.save", { key: key!, content, baseVersion: 0 });
              onCreated(key!);
            })
          }
        >
          {action.busy ? t("docs.saving") : t("skills.create")}
        </Button>
        <Button variant="glass" size="md" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </>
  );
}

function SkillUsage({ skill }: { skill: ListedSkill }) {
  const t = useT();
  const usage = skill.usage!;
  const max = Math.max(1, ...usage.weeks.map((w) => w.runs));
  return <section className="rounded-md border border-line-subtle p-3" aria-label={t("skills.weekly")}>
    <KvRows rows={[
      [t("skills.runs30d"), String(usage.runs30d)],
      [t("skills.lastUsed"), usage.lastUsedAt ? formatTime(usage.lastUsedAt) : t("skills.neverUsed")],
    ]} />
    <p className="mb-2 text-xs text-fg-muted">{t("skills.weekly")}</p>
    <div className="grid grid-cols-8 gap-1" data-skill-usage>
      {usage.weeks.map((w) => <div key={w.start} className="flex min-w-0 flex-col items-center gap-1 text-xs tabular-nums">
        <span>{w.runs}</span>
        <div className="flex h-12 w-full items-end bg-surface" aria-hidden="true">
          <div className="w-full rounded-sm bg-fg-muted" style={{ height: `${w.runs / max * 100}%` }} />
        </div>
        <time dateTime={w.start} className="text-fg-muted">{w.start.slice(5, 10).replace("-", "/")}</time>
      </div>)}
    </div>
    <p className="mt-2 text-xs text-fg-muted">{t("skills.usageHint")}</p>
  </section>;
}
