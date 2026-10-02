// Tool (roadmap 28a): the hub's tool catalog. Everyone sees what runs may use and at which pinned version; a project's
// manager turns each tool on or off for their project; a hub admin adds, changes and removes entries. Machines read the
// catalog from 28b on, so until then this only records the choice.
import { useMemo, useState, type ReactNode } from "react";
import {
  TOOL_AGENTS,
  TOOL_HOOK_EVENTS,
  TOOL_KINDS,
  TOOL_REGISTRIES,
  toolProblem,
  type ErrorText,
  type ToolEntry,
  type ToolKind,
  type ToolRegistry,
  type ToolView,
} from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Switch } from "@xdev-hive/ui/components/ui/switch";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Badge, Empty, ErrorNote, Notice, Page, PageHeader } from "#ui/components/common.tsx";
import { errorMessage, formatTime, useAction, useCan, useHive, useProjects, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { scopeProject } from "#ui/lib/scope.ts";

type ProjectState = "default" | "on" | "off";
const stateOf = (enabled: boolean | null): ProjectState => (enabled === null ? "default" : enabled ? "on" : "off");
const enabledOf = (s: ProjectState): boolean | null => (s === "default" ? null : s === "on");

export function ToolsPage() {
  const { client, me, scope } = useHive();
  const t = useT();
  const known = useProjects();
  // The project picked here, else the one of the sidebar's scope (the Web Admin has none: it looks at every project).
  const [picked, setPicked] = useState<string | null>(null);
  const project = picked ?? scopeProject(scope);
  const [tick, setTick] = useState(0);
  const list = useQuery(() => client.call("tools.list", project ? { project } : {}), [client, project, tick]);
  // null: no form open; "": a new entry; else the id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const hubAdmin = me.role === "admin" && !me.access;
  const tools = list.data ?? [];
  const reload = () => setTick((n) => n + 1);

  return (
    <Page wide>
      <PageHeader
        title={t("nav.tools")}
        subtitle={t("tools.subtitle")}
        actions={
          hubAdmin && editing !== "" ? (
            <Button size="sm" data-tool-add onClick={() => setEditing("")}>
              {t("tools.add")}
            </Button>
          ) : null
        }
      />
      <Notice tone="info">{t("tools.machineNote")}</Notice>
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="tools-project" className="text-sm">
          {t("tools.project")}
        </Label>
        <NativeSelect
          id="tools-project"
          size="sm"
          wrapperClassName="w-56"
          value={project ?? ""}
          onChange={(e) => setPicked(e.target.value || null)}
        >
          <NativeSelectOption value="">{t("tools.noProject")}</NativeSelectOption>
          {[...new Set([...known, ...(project ? [project] : [])])].sort().map((p) => (
            <NativeSelectOption key={p} value={p}>
              {p}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {project ? null : <span className="text-xs text-fg-muted">{t("tools.pickProject")}</span>}
      </div>
      <ErrorNote error={list.error} />
      {editing === "" ? (
        <ToolEditor
          tool={null}
          onDone={(saved) => {
            setEditing(null);
            if (saved) reload();
          }}
        />
      ) : null}
      {list.data && !tools.length ? <Empty>{t("tools.none")}</Empty> : null}
      {tools.map((tool) =>
        editing === tool.id ? (
          <ToolEditor
            key={tool.id}
            tool={tool}
            onDone={(saved) => {
              setEditing(null);
              if (saved) reload();
            }}
          />
        ) : (
          <ToolCard key={tool.id} tool={tool} project={project} hubAdmin={hubAdmin} busy={editing !== null} onEdit={() => setEditing(tool.id)} onChanged={reload} />
        ),
      )}
    </Page>
  );
}

function ToolCard({
  tool,
  project,
  hubAdmin,
  busy,
  onEdit,
  onChanged,
}: {
  tool: ToolView;
  project: string | null;
  hubAdmin: boolean;
  busy: boolean;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const { client } = useHive();
  const t = useT();
  const can = useCan();
  const action = useAction();
  const [confirming, setConfirming] = useState(false);
  const mine = project ? tool.projects.find((p) => p.project === project) : undefined;
  const editable = project !== null && can(project, "projectSettings");
  const env = Object.entries(tool.env);
  const setProject = (enabled: boolean | null, required: boolean) =>
    void action.run(async () => {
      await client.call("tools.setProject", { id: tool.id, project: project!, enabled, required });
      onChanged();
    });

  return (
    <Card data-tool={tool.id}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {tool.name}
          <span className="font-mono text-xs font-normal text-fg-muted">{tool.id}</span>
          <Badge tone="info">{t(`tools.kind.${tool.kind}`)}</Badge>
          {tool.builtin ? <Badge tone="accent">{t("tools.builtin")}</Badge> : null}
        </CardTitle>
        {tool.description ? <CardDescription>{tool.description}</CardDescription> : null}
        {hubAdmin ? (
          <CardAction className="flex gap-2">
            <Button size="sm" variant="outline" disabled={busy || action.busy} onClick={onEdit}>
              {t("tools.edit")}
            </Button>
            {tool.builtin ? null : confirming ? (
              <Button
                size="sm"
                variant="destructive"
                data-tool-remove-confirm
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await client.call("tools.remove", { id: tool.id });
                    onChanged();
                  })
                }
              >
                {t("tools.removeConfirm")}
              </Button>
            ) : (
              <Button size="sm" variant="ghost" className="text-destructive" data-tool-remove disabled={busy} onClick={() => setConfirming(true)}>
                {t("tools.remove")}
              </Button>
            )}
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-fg-muted">{t("tools.package")}</dt>
          <dd className="font-mono text-xs">{tool.package ? `${tool.package.name}@${tool.package.version}` : "—"}</dd>
          <dt className="text-fg-muted">{t("tools.license")}</dt>
          <dd>{tool.license}</dd>
          <dt className="text-fg-muted">{t("tools.agents")}</dt>
          <dd className="font-mono text-xs">{tool.agents.join(", ")}</dd>
          <dt className="text-fg-muted">{t("tools.env")}</dt>
          <dd className="font-mono text-xs">{env.length ? env.map(([k, v]) => `${k}=${v}`).join(" · ") : "—"}</dd>
          {tool.homepage ? (
            <>
              <dt className="text-fg-muted">{t("tools.homepage")}</dt>
              <dd className="truncate text-xs">
                <a href={tool.homepage} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">
                  {tool.homepage}
                </a>
              </dd>
            </>
          ) : null}
          <dt className="text-fg-muted">{t("tools.default")}</dt>
          <dd>{tool.enabledByDefault ? t("tools.defaultOn") : t("tools.defaultOff")}</dd>
        </dl>
        {project ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line-default bg-sunken p-2.5" data-tool-project={project}>
            <Label htmlFor={`tool-${tool.id}-state`} className="text-sm">
              {t("tools.forProject", { project })}
            </Label>
            <NativeSelect
              id={`tool-${tool.id}-state`}
              size="sm"
              wrapperClassName="w-48"
              value={stateOf(mine?.enabled ?? null)}
              disabled={!editable || action.busy}
              onChange={(e) => setProject(enabledOf(e.target.value as ProjectState), mine?.required ?? false)}
            >
              <NativeSelectOption value="default">{t("tools.stateDefault", { state: tool.enabledByDefault ? t("tools.on") : t("tools.off") })}</NativeSelectOption>
              <NativeSelectOption value="on">{t("tools.stateOn")}</NativeSelectOption>
              <NativeSelectOption value="off">{t("tools.stateOff")}</NativeSelectOption>
            </NativeSelect>
            <div className="flex items-center gap-2">
              <Checkbox
                id={`tool-${tool.id}-required`}
                checked={mine?.required ?? false}
                disabled={!editable || action.busy}
                onCheckedChange={(v) => setProject(mine?.enabled ?? null, v === true)}
              />
              <Label htmlFor={`tool-${tool.id}-required`} className="text-sm font-normal">
                {t("tools.required")}
              </Label>
            </div>
            <span className="ml-auto" data-tool-effective={mine?.effective ? "on" : "off"}>
              <Badge tone={mine?.effective ? "ok" : "neutral"}>{mine?.effective ? t("tools.effectiveOn") : t("tools.effectiveOff")}</Badge>
            </span>
            {editable ? null : <span className="basis-full text-xs text-fg-muted">{t("tools.needSettings")}</span>}
          </div>
        ) : tool.projects.length ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-fg-muted">{t("tools.projects")}</span>
            {tool.projects.map((p) => (
              <Badge key={p.project} tone={p.effective ? "ok" : "neutral"} className="font-mono">
                {p.project}: {p.effective ? t("tools.on") : t("tools.off")}
                {p.required ? ` · ${t("tools.required")}` : ""}
              </Badge>
            ))}
          </div>
        ) : null}
        <span className="text-xs text-fg-muted">{t("tools.updated", { version: tool.version, time: formatTime(tool.updatedAt), who: tool.updatedBy })}</span>
        <ErrorNote error={action.error} />
      </CardContent>
    </Card>
  );
}

// ── The form (hub admins) ──

/** An entry as typed: commands one argument a line, env one NAME=value a line. */
interface Draft {
  id: string;
  name: string;
  description: string;
  kind: ToolKind;
  registry: ToolRegistry | "";
  pkgName: string;
  pkgVersion: string;
  mcpCommand: string;
  mcpArgs: string;
  plugin: string;
  hooks: Array<{ event: ToolEntry["hooks"][number]["event"]; matcher: string; command: string }>;
  agents: ToolEntry["agents"];
  check: string;
  install: string;
  prepareInit: string;
  prepareSync: string;
  prepareMarker: string;
  env: string;
  secretEnv: string;
  license: string;
  homepage: string;
  handler: ToolEntry["handler"];
  enabledByDefault: boolean;
}

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
const unlines = (list: readonly string[] | null | undefined) => (list ?? []).join("\n");

const EMPTY: Draft = {
  id: "",
  name: "",
  description: "",
  kind: "mcp",
  registry: "npm",
  pkgName: "",
  pkgVersion: "",
  mcpCommand: "npx",
  mcpArgs: "-y\n{package}",
  plugin: "",
  hooks: [],
  agents: ["claude"],
  check: "",
  install: "",
  prepareInit: "",
  prepareSync: "",
  prepareMarker: "",
  env: "",
  secretEnv: "",
  license: "MIT",
  homepage: "",
  handler: null,
  enabledByDefault: false,
};

function toDraft(e: ToolEntry): Draft {
  return {
    id: e.id,
    name: e.name,
    description: e.description,
    kind: e.kind,
    registry: e.package?.registry ?? "",
    pkgName: e.package?.name ?? "",
    pkgVersion: e.package?.version ?? "",
    mcpCommand: e.mcp?.command ?? "",
    mcpArgs: unlines(e.mcp?.args),
    plugin: e.plugin ?? "",
    hooks: e.hooks.map((h) => ({ event: h.event, matcher: h.matcher, command: unlines(h.command) })),
    agents: [...e.agents],
    check: unlines(e.check),
    install: unlines(e.install),
    prepareInit: unlines(e.prepare?.init),
    prepareSync: unlines(e.prepare?.sync),
    prepareMarker: e.prepare?.marker ?? "",
    env: Object.entries(e.env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    secretEnv: unlines(e.secretEnv),
    license: e.license,
    homepage: e.homepage ?? "",
    handler: e.handler,
    enabledByDefault: e.enabledByDefault,
  };
}

/** Only the fields of its kind: an mcp entry sends no plugin, a cli none of the server's command. */
function toEntry(d: Draft): ToolEntry {
  const argv = (s: string) => {
    const list = lines(s);
    return list.length ? list : null;
  };
  const prepareInit = argv(d.prepareInit);
  const prepareSync = argv(d.prepareSync);
  return {
    id: d.id.trim(),
    name: d.name.trim(),
    description: d.description.trim(),
    kind: d.kind,
    package: d.registry ? { registry: d.registry, name: d.pkgName.trim(), version: d.pkgVersion.trim() } : null,
    mcp: d.kind === "mcp" && d.mcpCommand.trim() ? { command: d.mcpCommand.trim(), args: lines(d.mcpArgs) } : null,
    plugin: d.kind === "plugin" && d.plugin.trim() ? d.plugin.trim() : null,
    hooks: d.kind === "hook" ? d.hooks.map((h) => ({ event: h.event, matcher: h.matcher.trim(), command: lines(h.command) })) : [],
    agents: d.agents,
    check: argv(d.check),
    install: argv(d.install),
    prepare: prepareInit && prepareSync && d.prepareMarker.trim() ? { init: prepareInit, sync: prepareSync, marker: d.prepareMarker.trim() } : null,
    env: Object.fromEntries(
      lines(d.env).map((l) => {
        const at = l.indexOf("=");
        return at < 0 ? [l, ""] : [l.slice(0, at).trim(), l.slice(at + 1).trim()];
      }),
    ),
    secretEnv: lines(d.secretEnv),
    license: d.license.trim(),
    homepage: d.homepage.trim() || null,
    handler: d.handler,
    enabledByDefault: d.enabledByDefault,
  };
}

/** What the form cannot send yet, before the hub's own checks (toolProblem): those show under their field. */
function missing(d: Draft): string | null {
  if (!d.name.trim()) return "name";
  if (d.registry && (!d.pkgName.trim() || !d.pkgVersion.trim())) return "package.version";
  if (!d.agents.length) return "agents";
  if (d.kind === "hook" && d.hooks.some((h) => !lines(h.command).length)) return "hooks";
  if ((lines(d.prepareInit).length || lines(d.prepareSync).length || d.prepareMarker.trim()) && !(lines(d.prepareInit).length && lines(d.prepareSync).length && d.prepareMarker.trim())) return "prepare.marker";
  return null;
}

function ToolEditor({ tool, onDone }: { tool: ToolView | null; onDone: (saved: boolean) => void }) {
  const { client } = useHive();
  const t = useT();
  const action = useAction();
  const [draft, setDraft] = useState<Draft>(() => (tool ? toDraft(tool) : EMPTY));
  const set = (next: Partial<Draft>) => setDraft((d) => ({ ...d, ...next }));
  const entry = useMemo(() => toEntry(draft), [draft]);
  const problem = useMemo(() => toolProblem(entry, tool?.builtin ?? false), [entry, tool]);
  const gap = missing(draft);
  const builtin = tool?.builtin ?? false;
  const prefix = `tool-form-${tool?.id ?? "new"}`;

  /** The check's message under the field it is about ("hooks.0" and "mcp.args" count for "hooks" and "mcp"). */
  const under = (field: string): ReactNode => {
    const at = problem ? String(problem.vars?.field ?? "") : "";
    if (problem && (at === field || at.startsWith(`${field}.`))) return <FieldError text={problem} />;
    if (gap === field) return <p className="text-xs text-danger">{t("tools.form.missing")}</p>;
    return null;
  };
  const field = (id: string, label: string, control: ReactNode, error: string, hint?: string) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${prefix}-${id}`}>{label}</Label>
      {control}
      {hint ? <span className="text-xs text-fg-muted">{hint}</span> : null}
      {under(error)}
    </div>
  );
  const argvBox = (id: string, value: string, onChange: (v: string) => void, invalid: string) => (
    <Textarea
      id={`${prefix}-${id}`}
      className="min-h-16 font-mono text-xs"
      value={value}
      aria-invalid={!!problem && String(problem.vars?.field ?? "").startsWith(invalid)}
      onChange={(e) => onChange(e.target.value)}
    />
  );

  return (
    <Card data-tool-form>
      <CardHeader>
        <CardTitle>{tool ? t("tools.form.editTitle", { name: tool.name }) : t("tools.form.newTitle")}</CardTitle>
        <CardDescription>{t("tools.form.hint")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await client.call("tools.save", tool ? { entry, baseVersion: tool.version } : { entry });
              onDone(true);
            });
          }}
        >
          {field(
            "id",
            t("tools.form.id"),
            <Input id={`${prefix}-id`} className="font-mono" value={draft.id} disabled={!!tool} placeholder="rtk" onChange={(e) => set({ id: e.target.value.toLowerCase() })} />,
            "id",
            t("tools.form.idHint"),
          )}
          {field("name", t("tools.form.name"), <Input id={`${prefix}-name`} value={draft.name} onChange={(e) => set({ name: e.target.value })} />, "name")}
          <div className="md:col-span-2">
            {field(
              "description",
              t("tools.form.description"),
              <Textarea id={`${prefix}-description`} className="min-h-16" value={draft.description} onChange={(e) => set({ description: e.target.value })} />,
              "description",
            )}
          </div>
          {field(
            "kind",
            t("tools.form.kind"),
            <NativeSelect id={`${prefix}-kind`} value={draft.kind} disabled={builtin} onChange={(e) => set({ kind: e.target.value as ToolKind })}>
              {TOOL_KINDS.map((k) => (
                <NativeSelectOption key={k} value={k}>
                  {t(`tools.kind.${k}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>,
            "kind",
            builtin ? t("tools.form.builtinHint") : undefined,
          )}
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">{t("tools.agents")}</legend>
            <div className="flex flex-wrap gap-3">
              {TOOL_AGENTS.map((a) => (
                <div key={a} className="flex items-center gap-2">
                  <Checkbox
                    id={`${prefix}-agent-${a}`}
                    checked={draft.agents.includes(a)}
                    onCheckedChange={(v) => set({ agents: v === true ? TOOL_AGENTS.filter((x) => x === a || draft.agents.includes(x)) : draft.agents.filter((x) => x !== a) })}
                  />
                  <Label htmlFor={`${prefix}-agent-${a}`} className="font-mono text-sm font-normal">
                    {a}
                  </Label>
                </div>
              ))}
            </div>
            {under("agents")}
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr_8rem] md:col-span-2">
            {field(
              "registry",
              t("tools.form.registry"),
              <NativeSelect id={`${prefix}-registry`} value={draft.registry} onChange={(e) => set({ registry: e.target.value as Draft["registry"] })}>
                <NativeSelectOption value="">{t("tools.form.noPackage")}</NativeSelectOption>
                {TOOL_REGISTRIES.map((r) => (
                  <NativeSelectOption key={r} value={r}>
                    {r}
                  </NativeSelectOption>
                ))}
              </NativeSelect>,
              "package.registry",
            )}
            {field(
              "pkg-name",
              t("tools.form.pkgName"),
              <Input id={`${prefix}-pkg-name`} className="font-mono" value={draft.pkgName} disabled={!draft.registry} onChange={(e) => set({ pkgName: e.target.value })} />,
              "package.name",
            )}
            {field(
              "pkg-version",
              t("tools.form.pkgVersion"),
              <Input
                id={`${prefix}-pkg-version`}
                className="font-mono"
                value={draft.pkgVersion}
                disabled={!draft.registry}
                placeholder="1.2.3"
                aria-invalid={problem?.vars?.field === "package.version"}
                onChange={(e) => set({ pkgVersion: e.target.value })}
              />,
              "package.version",
            )}
            <span className="text-xs text-fg-muted sm:col-span-3">{t("tools.form.packageHint")}</span>
          </div>
          {draft.kind === "mcp" ? (
            <>
              {field("mcp-command", t("tools.form.mcpCommand"), <Input id={`${prefix}-mcp-command`} className="font-mono" value={draft.mcpCommand} onChange={(e) => set({ mcpCommand: e.target.value })} />, "mcp")}
              {field("mcp-args", t("tools.form.mcpArgs"), argvBox("mcp-args", draft.mcpArgs, (v) => set({ mcpArgs: v }), "mcp"), "mcp.args", t("tools.form.argvHint"))}
            </>
          ) : null}
          {draft.kind === "plugin"
            ? field(
                "plugin",
                t("tools.form.plugin"),
                <Input id={`${prefix}-plugin`} className="font-mono" value={draft.plugin} placeholder="name@marketplace" onChange={(e) => set({ plugin: e.target.value })} />,
                "plugin",
              )
            : null}
          {draft.kind === "hook" ? (
            <fieldset className="flex flex-col gap-2 md:col-span-2">
              <legend className="mb-1.5 text-sm font-medium">{t("tools.form.hooks")}</legend>
              {draft.hooks.map((h, i) => (
                <div key={i} className="grid gap-2 rounded-lg border border-line-default p-2.5 sm:grid-cols-[10rem_12rem_1fr_auto]">
                  <NativeSelect
                    size="sm"
                    aria-label={t("tools.form.hookEvent")}
                    value={h.event}
                    onChange={(e) => set({ hooks: draft.hooks.map((x, j) => (j === i ? { ...x, event: e.target.value as typeof h.event } : x)) })}
                  >
                    {TOOL_HOOK_EVENTS.map((ev) => (
                      <NativeSelectOption key={ev} value={ev}>
                        {ev}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <Input
                    className="h-7 font-mono text-xs"
                    aria-label={t("tools.form.hookMatcher")}
                    placeholder={t("tools.form.hookMatcher")}
                    value={h.matcher}
                    onChange={(e) => set({ hooks: draft.hooks.map((x, j) => (j === i ? { ...x, matcher: e.target.value } : x)) })}
                  />
                  <Textarea
                    className="min-h-16 font-mono text-xs"
                    aria-label={t("tools.form.hookCommand")}
                    placeholder={t("tools.form.hookCommand")}
                    value={h.command}
                    onChange={(e) => set({ hooks: draft.hooks.map((x, j) => (j === i ? { ...x, command: e.target.value } : x)) })}
                  />
                  <Button type="button" size="xs" variant="ghost" onClick={() => set({ hooks: draft.hooks.filter((_, j) => j !== i) })}>
                    {t("tools.form.hookRemove")}
                  </Button>
                </div>
              ))}
              <Button type="button" size="xs" variant="outline" className="self-start" onClick={() => set({ hooks: [...draft.hooks, { event: "PreToolUse", matcher: "", command: "" }] })}>
                {t("tools.form.hookAdd")}
              </Button>
              <span className="text-xs text-fg-muted">{t("tools.form.argvHint")}</span>
              {under("hooks")}
            </fieldset>
          ) : null}
          {field("check", t("tools.form.check"), argvBox("check", draft.check, (v) => set({ check: v }), "check"), "check", t("tools.form.checkHint"))}
          {field("install", t("tools.form.install"), argvBox("install", draft.install, (v) => set({ install: v }), "install"), "install", t("tools.form.argvHint"))}
          {field("prepare-init", t("tools.form.prepareInit"), argvBox("prepare-init", draft.prepareInit, (v) => set({ prepareInit: v }), "prepare"), "prepare.init", t("tools.form.prepareHint"))}
          {field("prepare-sync", t("tools.form.prepareSync"), argvBox("prepare-sync", draft.prepareSync, (v) => set({ prepareSync: v }), "prepare"), "prepare.sync")}
          {field(
            "prepare-marker",
            t("tools.form.prepareMarker"),
            <Input id={`${prefix}-prepare-marker`} className="font-mono" value={draft.prepareMarker} placeholder=".codegraph/codegraph.db" onChange={(e) => set({ prepareMarker: e.target.value })} />,
            "prepare.marker",
          )}
          <span />
          {field("env", t("tools.form.env"), argvBox("env", draft.env, (v) => set({ env: v }), "env"), "env", t("tools.form.envHint"))}
          {field("secret-env", t("tools.form.secretEnv"), argvBox("secret-env", draft.secretEnv, (v) => set({ secretEnv: v }), "secretEnv"), "secretEnv", t("tools.form.secretEnvHint"))}
          {field("license", t("tools.license"), <Input id={`${prefix}-license`} value={draft.license} placeholder="MIT" onChange={(e) => set({ license: e.target.value })} />, "license")}
          {field("homepage", t("tools.homepage"), <Input id={`${prefix}-homepage`} value={draft.homepage} placeholder="https://" onChange={(e) => set({ homepage: e.target.value })} />, "homepage")}
          <div className="flex items-center gap-2 md:col-span-2">
            <Switch id={`${prefix}-default`} checked={draft.enabledByDefault} onCheckedChange={(v) => set({ enabledByDefault: v })} />
            <Label htmlFor={`${prefix}-default`} className="font-normal">
              {t("tools.form.enabledByDefault")}
            </Label>
          </div>
          {under("handler")}
          <div className="md:col-span-2">
            <ErrorNote error={action.error} />
          </div>
          <div className="flex flex-wrap items-center gap-2 md:col-span-2">
            <Button type="submit" data-tool-save disabled={!!problem || !!gap || action.busy}>
              {t("tools.form.save")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => onDone(false)}>
              {t("tools.form.cancel")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function FieldError({ text }: { text: ErrorText }) {
  return <p className="text-xs text-danger">{errorMessage(text)}</p>;
}
