// The guide a project's chat leader follows (roadmap 17i-1): the team's hive-leader skill, or the project's own version
// of it, edited here by the project's managers. It is saved as the project's skill, so the Skills page shows it too,
// and the leader reads it with skill_get before it answers.
import { useState } from "react";
import { LEADER_COMMAND, MAX_LEADER_COMMANDS, skillDocKey } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@xdev-hive/ui/components/ui/sheet";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { useAction, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { buildSkill, LEADER_SKILL, leaderGuide } from "#ui/lib/skills.ts";
import { Badge, ErrorNote, Notice } from "./common.tsx";

export function LeaderGuideSheet({
  projects,
  defaultProject,
  open,
  onOpenChange,
}: {
  projects: string[];
  defaultProject: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const [project, setProject] = useState(defaultProject && projects.includes(defaultProject) ? defaultProject : (projects[0] ?? ""));
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-2xl">
        <SheetHeader className="border-b pr-10">
          <SheetTitle>{t("chat.guideTitle")}</SheetTitle>
          <SheetDescription>{t("chat.guideHint")}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {projects.length > 1 ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="guide-project">{t("chat.project")}</Label>
              <NativeSelect id="guide-project" size="sm" className="w-full sm:w-64" value={project} onChange={(e) => setProject(e.target.value)}>
                {projects.map((p) => (
                  <NativeSelectOption key={p} value={p}>
                    {p}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          ) : null}
          {project ? <GuideEditor key={project} project={project} /> : null}
          {project ? <CommandsEditor key={`commands-${project}`} project={project} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function GuideEditor({ project }: { project: string }) {
  const { client } = useHive();
  const t = useT();
  const [tick, setTick] = useState(0);
  // Kept here: the form starts over from each saved version.
  const [saved, setSaved] = useState(false);
  const docs = useQuery(async () => {
    const [own, team] = await Promise.all([
      client.call("docs.get", { key: skillDocKey(LEADER_SKILL, project) }),
      client.call("docs.get", { key: skillDocKey(LEADER_SKILL) }),
    ]);
    return { own, team };
  }, [client, project, tick]);
  if (docs.error) return <ErrorNote error={docs.error} />;
  if (!docs.data) return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  const guide = leaderGuide(docs.data.own, docs.data.team);
  // A new form for each saved version: what was typed is what was saved.
  return (
    <GuideForm
      key={guide.baseVersion}
      project={project}
      guide={guide}
      saved={saved}
      onEdit={() => setSaved(false)}
      onSaved={() => (setSaved(true), setTick((n) => n + 1))}
    />
  );
}

function GuideForm({
  project,
  guide,
  saved,
  onEdit,
  onSaved,
}: {
  project: string;
  guide: ReturnType<typeof leaderGuide>;
  saved: boolean;
  onEdit: () => void;
  onSaved: () => void;
}) {
  const { client } = useHive();
  const t = useT();
  const action = useAction();
  const [description, setDescription] = useState(guide.parts.description);
  const [body, setBody] = useState(guide.parts.body);
  const changed = description !== guide.parts.description || body !== guide.parts.body;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          await client.call("docs.save", {
            key: skillDocKey(LEADER_SKILL, project),
            content: buildSkill({ ...guide.parts, description, body }),
            title: LEADER_SKILL,
            baseVersion: guide.baseVersion,
            note: t("chat.guideNote"),
          });
          onSaved();
        });
      }}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {guide.from === "project" ? (
          <Badge tone="accent">{t("chat.guideOwn", { project, version: guide.baseVersion })}</Badge>
        ) : guide.from === "team" ? (
          <Badge tone="neutral">{t("chat.guideTeam")}</Badge>
        ) : (
          <Badge tone="warn">{t("chat.guideNone")}</Badge>
        )}
        <a className="font-medium text-primary underline underline-offset-2" href="#/skills">
          {t("chat.guideSkills")}
        </a>
      </div>
      {guide.from !== "project" ? <Notice tone="info">{t("chat.guideFromTeam", { project })}</Notice> : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="guide-description">{t("skills.description")}</Label>
        <Input id="guide-description" maxLength={1024} value={description} onChange={(e) => (setDescription(e.target.value), onEdit())} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="guide-body">{t("chat.guideBody")}</Label>
        <Textarea id="guide-body" rows={18} className="font-mono text-xs" value={body} onChange={(e) => (setBody(e.target.value), onEdit())} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" type="submit" disabled={action.busy || !description.trim() || !body.trim() || (!changed && guide.from === "project")}>
          {t("chat.guideSave", { project })}
        </Button>
        {saved ? <span className="text-xs text-success">{t("chat.guideSaved", { project })}</span> : null}
      </div>
      <ErrorNote error={action.error} />
    </form>
  );
}

/**
 * The commands the project's leader may run (roadmap 17i-2), one per line: Claude Code Bash prefixes, so each with any
 * arguments; anything else, a chained command included, stays refused. An empty list runs none.
 */
function CommandsEditor({ project }: { project: string }) {
  const { client } = useHive();
  const t = useT();
  const action = useAction();
  const defaults = useQuery(() => client.call("chat.defaults", { project }), [client, project]);
  const [text, setText] = useState<string>();
  const [saved, setSaved] = useState(false);
  if (defaults.error) return <ErrorNote error={defaults.error} />;
  if (!defaults.data) return null;
  const value = text ?? defaults.data.commands.join("\n");
  const lines = value.split("\n").map((l) => l.trim()).filter(Boolean);
  const bad = lines.filter((l) => !LEADER_COMMAND.test(l) || l.length > 60);
  const tooMany = lines.length > MAX_LEADER_COMMANDS;
  return (
    <form
      className="flex flex-col gap-2 border-t pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          const next = await client.call("chat.setCommands", { project, commands: lines });
          setText(next.commands.join("\n"));
          setSaved(true);
        });
      }}
    >
      <div className="flex flex-col gap-0.5">
        <Label htmlFor="guide-commands">{t("chat.commandsTitle")}</Label>
        <p className="text-xs text-muted-foreground">{t("chat.commandsHint", { max: MAX_LEADER_COMMANDS })}</p>
      </div>
      <Textarea
        id="guide-commands"
        rows={5}
        className="font-mono text-xs"
        placeholder={"git status\ngit log"}
        value={value}
        onChange={(e) => (setText(e.target.value), setSaved(false))}
      />
      {bad.length ? <p className="text-xs text-destructive wrap-anywhere">{t("chat.commandsBad", { commands: bad.join(", ") })}</p> : null}
      {tooMany ? <p className="text-xs text-destructive">{t("chat.commandsTooMany", { max: MAX_LEADER_COMMANDS })}</p> : null}
      <Notice tone="warn">{t("chat.commandsWarn")}</Notice>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" type="submit" disabled={action.busy || bad.length > 0 || tooMany}>
          {t("chat.commandsSave", { project })}
        </Button>
        {saved ? <span className="text-xs text-success">{lines.length ? t("chat.commandsSaved", { project }) : t("chat.commandsNone", { project })}</span> : null}
      </div>
      <ErrorNote error={action.error} />
    </form>
  );
}
