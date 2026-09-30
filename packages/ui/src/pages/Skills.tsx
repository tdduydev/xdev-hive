// Skills: the team's (org/skills/<name>) and each project's (project/<p>/skills/<name>). Sync writes them into
// .claude/skills of the repos; Codex and Gemini find them through AGENTS.md and skill_get. Edited here as a form:
// name, description and instructions, the SKILL.md front matter built from them.
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "cn";
import { parseDocKey, parseSkill, SKILL_DESCRIPTION_MAX, SKILL_NAME, skillDocKey, stripHidden, type Proposal } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent } from "@xdev-hive/ui/components/ui/card";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Diff } from "../components/Diff.tsx";
import { HiddenChars } from "../components/HiddenChars.tsx";
import { Badge, Empty, ErrorNote, Notice, OwnerBadge, Page, PageHeader } from "../components/common.tsx";
import { errorMessage, formatTime, useAction, useCan, useHive, useQuery } from "../hooks.ts";
import { useT } from "../i18n/index.tsx";
import { docOwner, inScope, scopeProject } from "../lib/scope.ts";
import { buildSkill, skillsFor, splitSkill, type ListedSkill, type SkillParts } from "../lib/skills.ts";

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

  return (
    <Page wide>
      <PageHeader
        title={t("nav.skills")}
        subtitle={t("skills.subtitle")}
        actions={
          owners.length ? (
            <Button variant="outline" onClick={() => setSelected(NEW)}>
              {t("skills.new")}
            </Button>
          ) : null
        }
      />
      {project ? <Notice tone="info">{t("skills.effectiveFor", { project })}</Notice> : null}
      {proposals.length ? (
        <Notice tone="warn">
          {t("skills.pendingNotice", { count: proposals.length })}{" "}
          <a className="font-medium underline underline-offset-2" href="#/proposals">
            {t("skills.openProposals")}
          </a>
        </Notice>
      ) : null}
      <ErrorNote error={list.error} />
      {list.data && !skills.length && selected !== NEW ? <Empty>{t("skills.none")}</Empty> : null}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        {skills.length ? (
          <ul className="flex flex-col gap-2" aria-label={t("nav.skills")}>
            {skills.map((s) => (
              <li key={s.key}>
                <SkillItem
                  skill={s}
                  selected={s.key === selected}
                  pending={proposals.filter((p) => p.docKey === s.key).length}
                  onSelect={() => setSelected(s.key)}
                />
              </li>
            ))}
          </ul>
        ) : null}
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
        ) : null}
      </div>
    </Page>
  );
}

function SkillItem({ skill: s, selected, pending, onSelect }: { skill: ListedSkill; selected: boolean; pending: number; onSelect: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full flex-col items-start gap-1.5 rounded-lg border p-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        selected ? "border-brand/50 bg-brand-soft/50" : "hover:bg-muted/50",
        s.overridden && "opacity-70",
      )}
    >
      <span className="flex max-w-full flex-wrap items-center gap-1.5">
        <span className="font-mono text-sm font-medium break-all">{s.name}</span>
        <OwnerBadge owner={s.project} />
        {s.overrides ? <Badge tone="accent">{t("skills.overrides")}</Badge> : null}
        {s.overridden ? <Badge tone="neutral">{t("skills.overridden")}</Badge> : null}
        {pending ? <Badge tone="warn">{t("skills.pendingCount", { count: pending })}</Badge> : null}
      </span>
      <span className="line-clamp-2 max-w-full text-xs text-muted-foreground wrap-anywhere">{s.description || t("skills.noDescription")}</span>
    </button>
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
  const doc = useQuery(() => client.call("docs.get", { key: skill.key }), [client, skill.key]);
  const stored = doc.data?.content ?? "";
  const [parts, setParts] = useState<SkillParts>(() => splitSkill(""));
  const [note, setNote] = useState("");
  const [done, setDone] = useState<string | null>(null);
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

  const send = (kind: "save" | "propose") =>
    action.run(async () => {
      try {
        parseSkill(content);
      } catch (err) {
        throw new Error(errorMessage(err));
      }
      if (kind === "save") {
        const saved = await client.call("docs.save", { key: skill.key, content, note: note.trim() || undefined, baseVersion: doc.data?.version ?? 0 });
        setDone(t("docs.saved", { version: saved.version }));
        doc.reload();
      } else {
        await client.call("proposals.create", { docKey: skill.key, baseVersion: doc.data?.version ?? 0, content, reason: note.trim() || t("skills.proposeDefaultReason") });
        setDone(t("docs.proposed"));
        setParts(splitSkill(stored));
        bump();
      }
      setNote("");
      onSaved();
    });

  return (
    <Card className="py-4">
      <CardContent className="flex flex-col gap-4 px-4">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <OwnerBadge owner={skill.project} />
            <span className="min-w-0 font-mono text-xs break-all text-muted-foreground">{skill.key}</span>
          </div>
          <h2 className="font-mono text-lg font-semibold break-all">{skill.name}</h2>
          <p className="text-xs text-muted-foreground">
            {doc.data ? `v${doc.data.version} · ${doc.data.updatedBy} · ${formatTime(doc.data.updatedAt)}` : t("common.loading")}
          </p>
          <p className="text-xs text-muted-foreground">
            {skill.project ? t("skills.syncProject", { name: skill.name, project: skill.project }) : t("skills.syncShared", { name: skill.name })}
          </p>
        </div>
        {skill.overrides ? <Notice tone="info">{t("skills.overridesHint")}</Notice> : null}
        {skill.overridden ? <Notice tone="info">{t("skills.overriddenHint")}</Notice> : null}
        {unchecked ? <Notice tone="warn">{t("skills.noFrontMatter")}</Notice> : null}
        {proposals.length ? (
          <div className="flex flex-col gap-1.5 rounded-lg border border-warning/35 bg-warning/5 p-3">
            <span className="text-xs font-medium">{t("skills.pendingTitle")}</span>
            {proposals.map((p) => (
              <a key={p.id} href="#/proposals" className="text-xs wrap-anywhere hover:underline">
                #{p.id} · {p.reason} · {p.author} · {formatTime(p.createdAt)}
              </a>
            ))}
          </div>
        ) : null}
        <ErrorNote error={doc.error} />
        <SkillFields parts={parts} onChange={setParts} readOnly={!canEdit && !canPropose} nameLocked idPrefix={`skill-${skill.key}`} />
        {dirty ? (
          <div className="flex flex-col gap-2">
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setShowDiff(!showDiff)} aria-expanded={showDiff}>
              {t("docs.tabChanges")}
            </Button>
            {showDiff ? <Diff before={stored} after={content} /> : null}
          </div>
        ) : null}
        {canEdit || canPropose ? (
          <>
            <HiddenChars
              fields={[
                { label: t("skills.description"), text: parts.description },
                { label: t("skills.body"), text: parts.body },
                { label: t("docs.note"), text: note },
              ]}
              onStrip={() => (setParts({ ...parts, description: stripHidden(parts.description), body: stripHidden(parts.body) }), setNote(stripHidden(note)))}
            />
            <div className="flex flex-wrap gap-2">
              <Input
                className="min-w-48 flex-1"
                placeholder={canEdit ? t("docs.notePlaceholder") : t("docs.reasonPlaceholder")}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                aria-label={t("docs.note")}
              />
              <Button onClick={() => void send(canEdit ? "save" : "propose")} disabled={!dirty || action.busy}>
                {action.busy ? (canEdit ? t("docs.saving") : t("docs.sending")) : canEdit ? t("docs.save", { version: (doc.data?.version ?? 0) + 1 }) : t("docs.propose")}
              </Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("skills.viewOnly")}</p>
        )}
        <ErrorNote error={action.error} />
        {done && !dirty ? <Notice tone="ok" title={done} /> : null}
      </CardContent>
    </Card>
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
    <Card className="py-4">
      <CardContent className="flex flex-col gap-4 px-4">
        <h2 className="text-lg font-semibold">{t("skills.newTitle")}</h2>
        <div className="grid gap-2 sm:grid-cols-[110px_1fr] sm:items-center sm:gap-x-3">
          <Label htmlFor="new-skill-owner" className="text-xs text-muted-foreground">
            {t("skills.owner")}
          </Label>
          <NativeSelect id="new-skill-owner" className="w-full" value={owner} onChange={(e) => setOwner(e.target.value)}>
            {owners.map((o) => (
              <NativeSelectOption key={o || "shared"} value={o}>
                {o || t("common.sharedTeam")}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <SkillFields parts={parts} onChange={setParts} readOnly={false} nameLocked={false} idPrefix="new-skill" />
        {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
        <HiddenChars
          fields={[
            { label: t("skills.description"), text: parts.description },
            { label: t("skills.body"), text: parts.body },
          ]}
          onStrip={() => setParts({ ...parts, description: stripHidden(parts.description), body: stripHidden(parts.body) })}
        />
        <div className="flex flex-wrap gap-2">
          <Button
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
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        </div>
        <ErrorNote error={action.error} />
      </CardContent>
    </Card>
  );
}
