// Systems (roadmap 19b): the projects that make one product, a repository (service) each. Picked in the sidebar,
// the pages show the tasks, runs, merge requests and chat of every project in the system.
import { useState } from "react";
import { Boxes } from "lucide-react";
import { PROJECT_NAME, type HiveSystem } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { Badge, Empty, ErrorNote, Page, PageHeader } from "#ui/components/common.tsx";
import { formatTime, useAction, useCan, useHive } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { systemScope } from "#ui/lib/scope.ts";
import { AgentPolicyCard } from "#ui/pages/admin/AgentPolicy.tsx";
import { SdlcGatesCard } from "#ui/pages/admin/SdlcGates.tsx";

export function SystemsPage() {
  const { systems, setScope, me, projects } = useHive();
  const t = useT();
  const allow = useCan();
  // The system being edited, "" for a new one.
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <Page>
      <PageHeader
        title={t("nav.systems")}
        subtitle={t("systems.subtitle")}
        actions={
          editing === "" ? null : (
            <Button size="sm" onClick={() => setEditing("")}>
              {t("systems.new")}
            </Button>
          )
        }
      />
      {editing === "" ? <SystemEditor system={null} onDone={() => setEditing(null)} /> : null}
      {systems.length === 0 && editing !== "" ? <Empty>{t("systems.none")}</Empty> : null}
      {systems.map((s) =>
        editing === s.name ? (
          <SystemEditor key={s.name} system={s} onDone={() => setEditing(null)} />
        ) : (
          <Card key={s.name}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 font-mono">
                <Boxes className="size-4 text-muted-foreground" />
                {s.name}
              </CardTitle>
              <CardDescription>{t("systems.updated", { time: formatTime(s.updatedAt), name: s.updatedBy })}</CardDescription>
              <CardAction className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setScope(systemScope(s.name, s.projects));
                    window.location.hash = "#/overview";
                  }}
                >
                  {t("systems.open")}
                </Button>
                {/* Roadmap 19c: the system's own docs and memory, shared by its services; its scope shows them first. */}
                {(["docs", "memory"] as const).map((page) => (
                  <Button
                    key={page}
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setScope(systemScope(s.name, s.projects));
                      window.location.hash = `#/${page}`;
                    }}
                  >
                    {t(page === "docs" ? "systems.docs" : "systems.memory")}
                  </Button>
                ))}
                {s.projects.every((p) => allow(p, "projectSettings")) ? (
                  <Button size="sm" variant="outline" onClick={() => setEditing(s.name)}>
                    {t("systems.edit")}
                  </Button>
                ) : null}
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-1.5">
              {s.projects.map((p) => (
                <Badge key={p} tone="neutral" className="font-mono">
                  {p}
                </Badge>
              ))}
            </CardContent>
          </Card>
        ),
      )}
      {/* A project manager has no Web Admin: their project's agent policy row lives here, with its other settings. */}
      {me.mode === "hub" && !(me.role === "admin" && !me.access) && projects.some((p) => allow(p, "projectSettings")) ? (
        <>
          <AgentPolicyCard editableOnly />
          <SdlcGatesCard editableOnly />
        </>
      ) : null}
    </Page>
  );
}

/** A new system (its name and projects), or the projects of one there is. */
function SystemEditor({ system, onDone }: { system: HiveSystem | null; onDone: () => void }) {
  const { client, projects, bump, scope, setScope } = useHive();
  const t = useT();
  const allow = useCan();
  const [name, setName] = useState(system?.name ?? "");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(system?.projects ?? []));
  const [confirming, setConfirming] = useState(false);
  const action = useAction();
  const choices = [...new Set([...projects, ...(system?.projects ?? [])])].sort();
  const nameOk = PROJECT_NAME.test(name);
  const toggle = (p: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(p);
      else next.delete(p);
      return next;
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{system ? system.name : t("systems.new")}</CardTitle>
        <CardDescription>{t("systems.editHint")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              const saved = await client.call("systems.save", { name, projects: [...picked] });
              // Looking at it: the sidebar follows its new projects.
              if (scope.kind === "system" && scope.system === saved.name) setScope(systemScope(saved.name, saved.projects));
              bump();
              onDone();
            });
          }}
        >
          {system ? null : (
            <div className="flex max-w-xs flex-col gap-1.5">
              <Label htmlFor="system-name">{t("systems.name")}</Label>
              <Input
                id="system-name"
                className="font-mono"
                placeholder="ehealth"
                value={name}
                aria-invalid={name !== "" && !nameOk}
                onChange={(e) => setName(e.target.value.toLowerCase())}
              />
            </div>
          )}
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">{t("systems.projects")}</legend>
            {choices.length === 0 ? <p className="text-sm text-muted-foreground">{t("scope.noProjects")}</p> : null}
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {choices.map((p) => {
                const id = `system-project-${p}`;
                return (
                  <div key={p} className="flex items-center gap-2">
                    <Checkbox id={id} checked={picked.has(p)} disabled={!allow(p, "projectSettings")} onCheckedChange={(v) => toggle(p, v === true)} />
                    <Label htmlFor={id} className="font-mono text-sm font-normal">
                      {p}
                    </Label>
                  </div>
                );
              })}
            </div>
          </fieldset>
          <ErrorNote error={action.error} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!nameOk || picked.size === 0 || action.busy}>
              {t("systems.save")}
            </Button>
            <Button type="button" variant="ghost" onClick={onDone}>
              {t("systems.cancel")}
            </Button>
            {system ? (
              confirming ? (
                <Button
                  type="button"
                  variant="destructive"
                  className="ml-auto"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await client.call("systems.remove", { name: system.name });
                      bump();
                      onDone();
                    })
                  }
                >
                  {t("systems.removeConfirm")}
                </Button>
              ) : (
                <Button type="button" variant="ghost" className="ml-auto text-destructive" onClick={() => setConfirming(true)}>
                  {t("systems.remove")}
                </Button>
              )
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
