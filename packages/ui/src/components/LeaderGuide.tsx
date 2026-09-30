// The guide a project's chat leader follows (roadmap 17i-1): the team's hive-leader skill, or the project's own version
// of it, edited here by the project's managers. It is saved as the project's skill, so the Skills page shows it too,
// and the leader reads it with skill_get before it answers.
import { useState } from "react";
import { skillDocKey } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@xdev-hive/ui/components/ui/sheet";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { useAction, useHive, useQuery } from "../hooks.ts";
import { useT } from "../i18n/index.tsx";
import { buildSkill, LEADER_SKILL, leaderGuide } from "../lib/skills.ts";
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
