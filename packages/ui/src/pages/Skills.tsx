// Skills (docs/design/2026-09-redesign, xDev Hive Client): the team's (org/skills/<name>) and each project's
// (project/<p>/skills/<name>). Sync writes them into .claude/skills of the repos; Codex and Gemini find them through
// AGENTS.md and skill_get. A list on the left; the skill's SKILL.md on the right, edited as a form (name, description,
// instructions) that builds the front matter.
import { useEffect, useMemo, useRef, useState } from "react";
import { parseDocKey, parseSkill, SKILL_DESCRIPTION_MAX, SKILL_NAME, skillDocKey, stripHidden, type Proposal } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Diff } from "#ui/components/Diff.tsx";
import { HiddenChars } from "#ui/components/HiddenChars.tsx";
import { ErrorNote, Notice } from "#ui/components/common.tsx";
import { MobileBack } from "#ui/components/MobileDetail.tsx";
import { Chip, DetailBody, DetailFooter, DetailHeader, KvRows, ListItem, ListPane, PaneEmpty } from "#ui/components/panes.tsx";
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
    <Button size="sm" data-empty-action onClick={() => pick(NEW)}>
      {t("skills.newFirst")}
    </Button>
  ) : null;

  return (
    <div className="mobile-master-detail flex h-full min-h-0 w-full bg-surface">
      <ListPane
        className={mobileDetail.showingDetail ? "hidden md:flex" : undefined}
        label={t("nav.skills")}
        head={
          <div className="flex gap-1.5">
            <Input className="h-7 min-w-0 flex-1 text-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("skills.search")} aria-label={t("skills.search")} />
            {owners.length ? (
              <Button size="sm" variant="outline" onClick={() => pick(NEW)}>
                {t("skills.new")}
              </Button>
            ) : null}
          </div>
        }
      >
        <ErrorNote error={list.error} />
        <label className="flex min-h-11 cursor-pointer items-center gap-2 px-2 text-xs">
          <input type="checkbox" checked={unused} onChange={(e) => setUnused(e.target.checked)} />
          {t("skills.unused")}
        </label>
        {project ? <p className="m-0 px-2 pt-1 pb-2 text-[11px]/4 text-fg-muted">{t("skills.effectiveFor", { project })}</p> : null}
        {proposals.length ? (
          <a className="mx-1 mb-1 rounded-sm bg-warning-soft px-2 py-1.5 text-xs text-fg-strong no-underline hover:underline" href="#/skills?tab=pending">
            {t("skills.pendingNotice", { count: proposals.length })} {t("skills.openProposals")}
          </a>
        ) : null}
        {shown.map((s) => {
          const pending = proposals.filter((p) => p.docKey === s.key).length;
          return (
            <ListItem
              key={s.key}
              mono
              selected={s.key === selected}
              onClick={() => pick(s.key)}
              title={s.name}
              dim={s.overridden}
              chip={
                pending ? (
                  <Chip kind="warning" small>
                    {t("skills.pendingCount", { count: pending })}
                  </Chip>
                ) : s.overrides ? (
                  <Chip kind="info" small>
                    {t("skills.overrides")}
                  </Chip>
                ) : s.overridden ? (
                  <Chip kind="neutral" small>
                    {t("skills.overridden")}
                  </Chip>
                ) : s.project ? (
                  <Chip kind="info" small>
                    {t("skills.projectChip")}
                  </Chip>
                ) : null
              }
              sub={s.description || t("skills.noDescription")}
              meta={<span className="flex flex-col gap-1">
                <span>{s.project ?? t("common.sharedTeam")} · {formatTime(s.updatedAt)}</span>
                <span className="grid grid-cols-2 gap-2 font-sans text-xs">
                  <span>{t("skills.runs30d")}<br /><strong>{s.usage?.runs30d ?? "—"}</strong></span>
                  <span>{t("skills.lastUsed")}<br />{s.usage?.lastUsedAt ? formatTime(s.usage.lastUsedAt) : t("skills.neverUsed")}</span>
                </span>
              </span>}
            />
          );
        })}
        {/* The button for an empty list sits in the wide pane on the right, so the narrow list keeps the sentence alone. */}
        {empty ? <PaneEmpty>{t(empty === "none" ? "skills.none" : "skills.noMatch")}</PaneEmpty> : null}
      </ListPane>
      <div className={mobileDetail.mobile && !mobileDetail.showingDetail ? "hidden min-w-0 flex-1 flex-col md:flex" : "flex min-w-0 flex-1 flex-col"}>
        {mobileDetail.showingDetail ? <MobileBack onClick={() => pick(null)} /> : null}
        {(mobileDetail.mobile ? mobileDetail.value : selected) === NEW ? (
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
          <div className="grid flex-1 place-items-center p-6">
            {empty === "none" ? <PaneEmpty action={firstSkill}>{t("skills.none")}</PaneEmpty> : list.data ? <span className="text-[13px] text-fg-muted">{t("skills.pick")}</span> : null}
          </div>
        )}
      </div>
    </div>
  );
}

/** Name, description and instructions of a skill; `nameLocked` for one that exists (its key holds the name). */
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
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-2 sm:grid-cols-[110px_1fr] sm:items-start sm:gap-x-3">
        <Label htmlFor={`${idPrefix}-name`} className="text-xs text-muted-foreground sm:pt-2">
          {t("skills.name")}
        </Label>
        <div className="flex min-w-0 flex-col gap-1">
          <Input
            id={`${idPrefix}-name`}
            className="font-mono"
            value={parts.name}
            readOnly={readOnly || nameLocked}
            placeholder="review-pr"
            onChange={(e) => onChange({ ...parts, name: e.target.value.trim().toLowerCase() })}
          />
          {nameLocked ? null : <p className="text-xs text-muted-foreground">{t("skills.nameHint")}</p>}
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-[110px_1fr] sm:items-start sm:gap-x-3">
        <Label htmlFor={`${idPrefix}-description`} className="text-xs text-muted-foreground sm:pt-2">
          {t("skills.description")}
        </Label>
        <div className="flex min-w-0 flex-col gap-1">
          <Textarea
            id={`${idPrefix}-description`}
            className="min-h-16 resize-y"
            value={parts.description}
            readOnly={readOnly}
            maxLength={SKILL_DESCRIPTION_MAX}
            placeholder={t("skills.descriptionPlaceholder")}
            onChange={(e) => onChange({ ...parts, description: e.target.value.replace(/\s*\n\s*/g, " ") })}
          />
          <p className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
            <span>{t("skills.descriptionHint")}</span>
            <span className="tabular-nums">
              {parts.description.length}/{SKILL_DESCRIPTION_MAX}
            </span>
          </p>
        </div>
      </div>
      <Textarea
        className="min-h-72 resize-y font-mono text-sm leading-relaxed field-sizing-fixed md:text-sm"
        value={parts.body}
        readOnly={readOnly}
        spellCheck={false}
        aria-label={t("skills.body")}
        placeholder={t("skills.bodyPlaceholder")}
        onChange={(e) => onChange({ ...parts, body: e.target.value })}
      />
      {parts.extra.length ? <p className="font-mono text-xs break-all text-muted-foreground">{t("skills.extra", { keys: parts.extra.join(" · ") })}</p> : null}
    </div>
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
  const [editing, setEditing] = useState(false);
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
      setEditing(false);
      onSaved();
    });

  const writeRepos = () =>
    void action.run(async () => {
      for (const p of repos) await desktop!.syncProject(p);
      toast(t("skills.wroteRepo", { name: skill.name, projects: repos.join(", ") }));
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DetailHeader
        mono
        chips={
          <>
            <Chip kind={skill.project ? "info" : "neutral"}>{skill.project ? t("skills.project", { project: skill.project }) : t("inbox.shared")}</Chip>
            {skill.overrides ? <Chip kind="info">{t("skills.overrides")}</Chip> : null}
            {skill.overridden ? <Chip kind="neutral">{t("skills.overridden")}</Chip> : null}
          </>
        }
        when={doc.data ? `v${doc.data.version} · ${doc.data.updatedBy} · ${formatTime(doc.data.updatedAt)}` : undefined}
        title={skill.name}
      />
      <DetailBody>
        {skill.usage ? <SkillUsage skill={skill} /> : null}
        {skill.overrides ? <Notice tone="info">{t("skills.overridesHint")}</Notice> : null}
        {skill.overridden ? <Notice tone="info">{t("skills.overriddenHint")}</Notice> : null}
        {unchecked ? <Notice tone="warn">{t("skills.noFrontMatter")}</Notice> : null}
        {proposals.length ? (
          <div className="flex flex-col gap-1.5 rounded-md border border-warning-line bg-warning-soft p-3">
            <span className="text-xs font-semibold text-fg-strong">{t("skills.pendingTitle")}</span>
            {proposals.map((p) => (
              <a key={p.id} href="#/skills?tab=pending" className="text-xs text-fg-strong [overflow-wrap:anywhere] hover:underline">
                #{p.id} · {p.reason} · {p.author} · {formatTime(p.createdAt)}
              </a>
            ))}
          </div>
        ) : null}
        <ErrorNote error={doc.error} />
        {editing ? (
          <>
            <SkillFields parts={parts} onChange={setParts} readOnly={!canEdit && !canPropose} nameLocked idPrefix={`skill-${skill.key}`} />
            <Input
              placeholder={canEdit ? t("docs.notePlaceholder") : t("docs.reasonPlaceholder")}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              aria-label={t("docs.note")}
            />
            <HiddenChars
              fields={[
                { label: t("skills.description"), text: parts.description },
                { label: t("skills.body"), text: parts.body },
                { label: t("docs.note"), text: note },
              ]}
              onStrip={() => (setParts({ ...parts, description: stripHidden(parts.description), body: stripHidden(parts.body) }), setNote(stripHidden(note)))}
            />
            {dirty && showDiff ? <Diff before={stored} after={content} /> : null}
          </>
        ) : (
          <>
            {/* Until docs.get answers, a skill still loading looked exactly like one with nothing in it: say "Đang tải…"
                and leave the file out, rather than "(chưa có mô tả)" over an empty SKILL.md (roadmap 39h). */}
            <p className="m-0 text-sm/[22px] text-pretty text-fg-primary">
              {doc.loading ? t("common.loading") : parts.description || skill.description || t("skills.noDescription")}
            </p>
            <KvRows
              rows={[
                [t("knowledge.applies"), parts.description || skill.description || t("skills.noDescription")],
                [t("knowledge.overridesBy"), skill.overridesBy.length ? skill.overridesBy.join(", ") : "—"],
                [t("knowledge.modified"), `${skill.updatedBy} · ${formatTime(skill.updatedAt)}`],
                [t("skills.writeTo"), `.claude/skills/${skill.name}/SKILL.md`, true],
                [t("skills.scopeLabel"), skill.project ? t("skills.syncProject", { name: skill.name, project: skill.project }) : t("skills.syncShared", { name: skill.name })],
              ]}
            />
            {doc.data ? (
              <div data-skill-doc className="overflow-hidden rounded-md border border-line-subtle bg-code">
                <div className="flex h-7 items-center border-b border-line-subtle px-3 font-mono text-[11px]/none font-medium text-fg-muted">SKILL.md</div>
                <pre tabIndex={0} className="m-0 max-h-[60vh] overflow-auto px-3 py-2.5 font-mono text-xs/[19px] whitespace-pre-wrap text-code-fg outline-none focus-visible:focus-ring [overflow-wrap:anywhere]">{stored || "—"}</pre>
              </div>
            ) : null}
          </>
        )}
        <ErrorNote error={action.error} />
      </DetailBody>
      <DetailFooter foot={!canEdit && !canPropose ? t("skills.viewOnly") : undefined}>
        {canEdit || canPropose ? (
          editing ? (
            <>
              <Button size="sm" onClick={() => void send(canEdit ? "save" : "propose")} disabled={!dirty || action.busy}>
                {action.busy ? (canEdit ? t("docs.saving") : t("docs.sending")) : canEdit ? t("docs.saveAs", { version: (doc.data?.version ?? 0) + 1 }) : t("docs.propose")}
              </Button>
              {dirty ? (
                <Button size="sm" variant="ghost" onClick={() => setShowDiff((v) => !v)} aria-pressed={showDiff}>
                  {showDiff ? t("docs.hideChanges") : t("docs.showChanges")}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setParts(splitSkill(stored));
                  setNote("");
                  setEditing(false);
                }}
              >
                {t("common.cancel")}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => setEditing(true)} disabled={!doc.data}>
              {t("skills.edit")}
            </Button>
          )
        ) : null}
        {desktop && !editing ? (
          <Button size="sm" variant="outline" disabled={action.busy || !repos.length} title={repos.length ? repos.join(", ") : t("skills.writeRepoNone")} onClick={writeRepos}>
            {t("skills.writeRepo")}
          </Button>
        ) : null}
      </DetailFooter>
    </div>
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
    <div className="flex min-h-0 flex-1 flex-col">
      <DetailHeader title={t("skills.newTitle")} />
      <DetailBody>
        <div className="grid gap-2 sm:grid-cols-[110px_1fr] sm:items-center sm:gap-x-3">
          <Label htmlFor="new-skill-owner" className="text-xs text-muted-foreground">
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
        {problem ? <p className="m-0 text-xs text-danger">{problem}</p> : null}
        <HiddenChars
          fields={[
            { label: t("skills.description"), text: parts.description },
            { label: t("skills.body"), text: parts.body },
          ]}
          onStrip={() => setParts({ ...parts, description: stripHidden(parts.description), body: stripHidden(parts.body) })}
        />
        <ErrorNote error={action.error} />
      </DetailBody>
      <DetailFooter>
          <Button
            size="sm"
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
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
      </DetailFooter>
    </div>
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
