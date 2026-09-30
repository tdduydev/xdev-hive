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
import { Diff } from "../components/Diff.tsx";
import { HiddenChars } from "../components/HiddenChars.tsx";
import { ErrorNote, Notice } from "../components/common.tsx";
import { Chip, DetailBody, DetailFooter, DetailHeader, KvRows, ListItem, ListPane } from "../components/panes.tsx";
import { errorMessage, formatTime, useAction, useCan, useHive, useQuery } from "../hooks.ts";
import { useT } from "../i18n/index.tsx";
import { docOwner, inScope, scopeProject } from "../lib/scope.ts";
import { buildSkill, skillsFor, splitSkill, type ListedSkill, type SkillParts } from "../lib/skills.ts";
import { fold } from "../lib/text.ts";
import { useToast } from "../shell/toast.tsx";

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
    if (scope.kind === "shared") return skillsFor(all.filter((s) => s.project === null), null);
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
  const owners = useMemo(() => [...(allow(null, "manage") ? [""] : []), ...projects.filter((p) => allow(p, "manage"))], [projects, allow]);
  const [selected, setSelected] = useState<string | null>(null);
  const current = skills.find((s) => s.key === selected) ?? null;
  // A skill just created is selected before the list that has it comes back.
  const created = useRef<string | null>(null);
  useEffect(() => {
    if (current) created.current = null;
    if (!list.data || selected === NEW || current || (selected && selected === created.current)) return;
    setSelected(skills[0]?.key ?? null);
  }, [list.data, selected, current, skills]);
  const reload = () => setTick((n) => n + 1);

  const [q, setQ] = useState("");
  const needle = fold(q.trim());
  const shown = skills.filter((s) => !needle || fold(`${s.name} ${s.description}`).includes(needle));

  return (
    <div className="flex h-full min-h-0 bg-surface">
      <ListPane
        label={t("nav.skills")}
        head={
          <div className="flex gap-1.5">
            <Input className="h-7 min-w-0 flex-1 text-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("skills.search")} aria-label={t("skills.search")} />
            {owners.length ? (
              <Button size="sm" variant="outline" onClick={() => setSelected(NEW)}>
                {t("skills.new")}
              </Button>
            ) : null}
          </div>
        }
      >
        <ErrorNote error={list.error} />
        {project ? <p className="m-0 px-2 pt-1 pb-2 text-[11px]/4 text-fg-muted">{t("skills.effectiveFor", { project })}</p> : null}
        {proposals.length ? (
          <a className="mx-1 mb-1 rounded-sm bg-warning-soft px-2 py-1.5 text-xs text-fg-strong no-underline hover:underline" href="#/proposals">
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
              onClick={() => setSelected(s.key)}
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
              meta={s.project ?? t("inbox.shared")}
            />
          );
        })}
        {list.data && !shown.length ? <p className="m-0 px-3 py-8 text-center text-xs text-fg-muted">{t("skills.none")}</p> : null}
      </ListPane>
      <div className="flex min-w-0 flex-1 flex-col">
        {selected === NEW ? (
          <NewSkill
            owners={owners}
            defaultOwner={project && owners.includes(project) ? project : (owners[0] ?? "")}
            taken={new Set((list.data ?? []).map((s) => s.key))}
            onCancel={() => setSelected(null)}
            onCreated={(key) => {
              created.current = key;
              setSelected(key);
              reload();
            }}
          />
        ) : current ? (
          <SkillEditor key={current.key} skill={current} proposals={proposals.filter((p) => p.docKey === current.key)} onSaved={reload} />
        ) : (
          <div className="grid flex-1 place-items-center p-6 text-[13px] text-fg-muted">{list.data ? t("skills.pick") : null}</div>
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
  const canEdit = allow(skill.project, "manage");
  const canPropose = !canEdit && allow(skill.project, "contribute");
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
        {skill.overrides ? <Notice tone="info">{t("skills.overridesHint")}</Notice> : null}
        {skill.overridden ? <Notice tone="info">{t("skills.overriddenHint")}</Notice> : null}
        {unchecked ? <Notice tone="warn">{t("skills.noFrontMatter")}</Notice> : null}
        {proposals.length ? (
          <div className="flex flex-col gap-1.5 rounded-md border border-warning-line bg-warning-soft p-3">
            <span className="text-xs font-semibold text-fg-strong">{t("skills.pendingTitle")}</span>
            {proposals.map((p) => (
              <a key={p.id} href="#/proposals" className="text-xs text-fg-strong [overflow-wrap:anywhere] hover:underline">
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
            <p className="m-0 text-sm/[22px] text-pretty text-fg-primary">{parts.description || t("skills.noDescription")}</p>
            <KvRows
              rows={[
                [t("skills.writeTo"), `.claude/skills/${skill.name}/SKILL.md`, true],
                [t("skills.scopeLabel"), skill.project ? t("skills.syncProject", { name: skill.name, project: skill.project }) : t("skills.syncShared", { name: skill.name })],
              ]}
            />
            <div className="overflow-hidden rounded-md border border-line-subtle bg-code">
              <div className="flex h-7 items-center border-b border-line-subtle px-3 font-mono text-[11px]/none font-medium text-fg-muted">SKILL.md</div>
              <pre className="m-0 max-h-[60vh] overflow-auto px-3 py-2.5 font-mono text-xs/[19px] whitespace-pre-wrap text-code-fg [overflow-wrap:anywhere]">{stored || "—"}</pre>
            </div>
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
