import { useMemo, useState } from "react";
import { LockKeyhole } from "lucide-react";
import { AUTONOMY, effectivePolicy, modelsFor, NETWORK, OPEN_POLICY, POLICY_AGENT_KINDS, type AgentPolicy, type Autonomy, type NetworkMode, type ToolView } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@xdev-hive/ui/components/ui/sheet";
import { ErrorNote } from "#ui/components/common.tsx";
import { useAction, useCan, useHive, useProjects, useQuery } from "#ui/hooks.ts";
import { rich, useT } from "#ui/i18n/index.tsx";
import { scopeProject } from "#ui/lib/scope.ts";

type Kind = (typeof POLICY_AGENT_KINDS)[number];
const autonomyRank = (a: Autonomy) => AUTONOMY.indexOf(a);
const networkRank = (n: NetworkMode) => NETWORK.indexOf(n);

export function CompactAgentPolicy({ hubOnly = false }: { hubOnly?: boolean }) {
  const { client, scope } = useHive();
  const t = useT();
  const can = useCan();
  const known = useProjects();
  const [project, setProject] = useState("");
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const [draft, setDraft] = useState<Partial<AgentPolicy> | null>(null);
  const [other, setOther] = useState<Partial<Record<Kind, string>>>({});
  const action = useAction();
  const view = useQuery(() => client.call("agentPolicy.get", {}), [client, tick]);
  const router = useQuery(() => client.call("modelRouter.get", {}), [client]);
  const catalog = useQuery(() => client.call("tools.list", {}).catch((): ToolView[] => []), [client]);
  const projects = useMemo(() => known.filter((p) => can(p, "projectSettings")), [known, can]);
  const selected = hubOnly ? null : projects.includes(project) ? project : projects.includes(scopeProject(scope) ?? "") ? scopeProject(scope)! : projects[0];
  if (!view.data) return <ErrorNote error={view.error} />;
  if (!hubOnly && !selected) return <p className="text-sm text-fg-secondary">{t("agentPolicy.noProjects")}</p>;
  const hub = view.data.hub;
  const saved = selected ? view.data.projects[selected] ?? {} : {};
  const part = draft ?? (hubOnly ? hub : saved);
  const effective = hubOnly ? { ...OPEN_POLICY, ...part } as AgentPolicy : effectivePolicy(hub, part);
  const modelOptions = (kind: Kind) => [...new Set(Object.values(router.data?.tiers ?? {}).map((row) => row[kind as keyof typeof row]?.model).filter((name): name is string => !!name))];
  const set = (change: Partial<AgentPolicy>) => setDraft({ ...part, ...change });
  const setModels = (kind: Kind, names: string[]) => set({ models: { ...part.models, [kind]: names } });
  const modelNames = (kind: Kind) => part.models?.[kind]?.length ? part.models[kind]! : !hubOnly ? modelsFor(hub, kind) ?? [] : [];
  const modelHeld = (kind: Kind, name: string) => !hubOnly && modelsFor(hub, kind) !== null && !modelsFor(hub, kind)?.includes(name);
  const mcpIds = (catalog.data ?? []).filter((tool) => tool.kind === "mcp").map((tool) => tool.id);
  const summary = `${t(`agentPolicy.autonomy.${effective.autonomy}`)} · ${t(`agentPolicy.network.${effective.network.mode}`)} · ${effective.mcp === null ? t("agentPolicy.mcpAll") : effective.mcp.length ? effective.mcp.join(", ") : t("agentPolicy.mcpNone")} · ${POLICY_AGENT_KINDS.some((kind) => modelsFor(effective, kind) !== null) ? POLICY_AGENT_KINDS.map((kind) => `${kind}: ${(modelsFor(effective, kind) ?? []).join(", ") || t("agentPolicy.anyModel")}`).join(" · ") : t("settingsTidy.modelsByProcess")}`;
  const lock = (reason: string) => <span title={reason} aria-label={reason}><LockKeyhole className="size-4 shrink-0 text-warning" /></span>;
  const ceiling = t("settingsTidy.hubCeiling");
  const save = () => void action.run(async () => {
    await client.call("agentPolicy.set", { project: selected ?? null, policy: hubOnly ? { ...OPEN_POLICY, ...part } as AgentPolicy : part });
    setDraft(null);
    setTick((n) => n + 1);
    setOpen(false);
  });
  return <div data-compact-agent-policy className="space-y-4">
    {!hubOnly && projects.length > 1 ? <label className="block max-w-sm text-sm">{t("agentPolicy.colScope")}
      <NativeSelect value={selected ?? ""} onChange={(event) => { setProject(event.target.value); setDraft(null); }} aria-label={t("agentPolicy.colScope")}>{projects.map((p) => <NativeSelectOption key={p} value={p}>{p}</NativeSelectOption>)}</NativeSelect>
    </label> : null}
    <div className="max-w-2xl rounded-xl border border-line-default bg-card p-4">
      <p className="mb-3 text-sm leading-relaxed text-fg-secondary" data-policy-summary>{summary}</p>
      <Button className="max-md:min-h-11" variant="outline" onClick={() => setOpen(true)}>{t("settingsTidy.edit")}</Button>
    </div>
    <Sheet open={open} onOpenChange={(next) => { setOpen(next); if (!next) setDraft(null); }}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg max-md:!w-full max-md:[&_button]:!min-h-11 max-md:[&>button]:!min-w-11" data-policy-editor>
        <SheetHeader><SheetTitle>{t("agentPolicy.title")}</SheetTitle><SheetDescription>{hubOnly ? t("settingsTidy.hubPolicy") : selected}</SheetDescription></SheetHeader>
        <div className="space-y-6 px-4 pb-6">
          <fieldset className="space-y-2"><legend className="font-semibold">{t("agentPolicy.colAutonomy")}</legend>
            <div className="grid grid-cols-2 gap-2">{AUTONOMY.map((level) => {
              const held = !hubOnly && autonomyRank(level) > autonomyRank(hub.autonomy);
              return <button key={level} type="button" disabled={held} aria-pressed={effective.autonomy === level} title={held ? ceiling : undefined} className="min-h-11 rounded-lg border border-line-default p-3 text-left text-sm aria-pressed:border-primary aria-pressed:bg-primary/10 disabled:opacity-60" onClick={() => set({ autonomy: level })}>
                <span className="flex items-center gap-1 font-medium">{t(`agentPolicy.autonomy.${level}`)}{held ? lock(ceiling) : null}</span><span className="mt-1 block text-xs text-fg-secondary">{t(`settingsTidy.autonomy.${level}`)}</span>
              </button>;
            })}</div>
          </fieldset>
          <fieldset className="space-y-2"><legend className="font-semibold">{t("agentPolicy.colNetwork")}</legend>
            <div className="flex flex-wrap gap-2">{NETWORK.map((mode) => {
              const held = !hubOnly && networkRank(mode) > networkRank(hub.network.mode);
              return <Button key={mode} type="button" className="max-md:min-h-11" variant={effective.network.mode === mode ? "default" : "outline"} disabled={held} title={held ? ceiling : undefined} onClick={() => set({ network: { mode, allow: mode === "allowlist" ? part.network?.allow ?? [] : [] } })}>{t(`agentPolicy.network.${mode}`)}{held ? lock(ceiling) : null}</Button>;
            })}</div>
            {part.network?.mode === "allowlist" ? <Input className="min-h-11 max-md:text-base" aria-label={t("agentPolicy.allow")} value={part.network.allow.join(", ")} onChange={(e) => set({ network: { mode: "allowlist", allow: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) } })} /> : null}
          </fieldset>
          <fieldset className="space-y-2"><legend className="font-semibold">{t("agentPolicy.colMcp")}</legend>
            <div className="flex gap-2"><Button type="button" className="max-md:min-h-11" variant={effective.mcp === null ? "default" : "outline"} disabled={!hubOnly && hub.mcp !== null} title={!hubOnly && hub.mcp !== null ? ceiling : undefined} onClick={() => set({ mcp: null })}>{t("agentPolicy.mcpAll")}</Button><Button type="button" className="max-md:min-h-11" variant={effective.mcp !== null ? "default" : "outline"} onClick={() => set({ mcp: part.mcp ?? [] })}>{t("agentPolicy.mcpList")}</Button></div>
            {part.mcp !== null && part.mcp !== undefined ? <div className="flex flex-wrap gap-2">{mcpIds.map((id) => { const held = !hubOnly && hub.mcp !== null && !hub.mcp.includes(id); const checked = part.mcp?.includes(id) ?? false; return <label key={id} title={held ? ceiling : undefined} className="flex min-h-11 items-center gap-2 rounded-lg border border-line-default px-3 text-sm"><input type="checkbox" disabled={held} checked={checked} onChange={() => set({ mcp: checked ? part.mcp?.filter((x) => x !== id) : [...part.mcp ?? [], id] })} />{id}{held ? lock(ceiling) : null}</label>; })}</div> : null}
          </fieldset>
          <fieldset className="space-y-3"><legend className="font-semibold">{t("agentPolicy.colModels")}</legend>
            {POLICY_AGENT_KINDS.map((kind) => <div key={kind} className="space-y-2">
              <div className="font-mono text-sm">{kind}</div>
              <div className="flex flex-wrap gap-2">{[...new Set([...modelOptions(kind), ...modelNames(kind)])].map((name) => {
                const held = modelHeld(kind, name);
                const selectedModel = modelNames(kind).includes(name);
                return <button key={name} type="button" disabled={held} title={held ? ceiling : undefined} aria-pressed={selectedModel}
                  className="min-h-11 rounded-full border border-line-default px-3 text-sm aria-pressed:border-primary aria-pressed:bg-primary/10 disabled:opacity-60"
                  onClick={() => setModels(kind, selectedModel ? modelNames(kind).filter((x) => x !== name) : [...modelNames(kind), name])}>
                  {name}{held ? lock(ceiling) : null}
                </button>;
              })}</div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input className="min-h-11 min-w-0 flex-1 max-md:text-base" aria-label={`${t("settingsTidy.addModel")} ${kind}`} value={other[kind] ?? ""} onChange={(e) => setOther({ ...other, [kind]: e.target.value })} />
                <Button type="button" className="min-h-11 max-md:w-full" variant="outline" title={modelHeld(kind, other[kind] ?? "") ? ceiling : undefined}
                  disabled={!/^[A-Za-z0-9._:[\]-]{1,100}$/.test(other[kind] ?? "") || modelHeld(kind, other[kind] ?? "")}
                  onClick={() => { const name = other[kind]!.trim(); setModels(kind, [...new Set([...modelNames(kind), name])]); setOther({ ...other, [kind]: "" }); }}>
                  {t("settingsTidy.addModel")}{modelHeld(kind, other[kind] ?? "") ? lock(ceiling) : null}
                </Button>
              </div>
            </div>)}
          </fieldset>
          <fieldset className="space-y-2"><legend className="font-semibold">{t("agentPolicy.colEffective")}</legend>
            {(["mcpOutputTokens", "bashOutputChars"] as const).map((key) => { const hubLimit = hub.limits?.[key]; const value = part.limits?.[key] ?? null; return <label key={key} className="flex items-center gap-2 text-sm"><span className="w-32 shrink-0">{t(`agentPolicy.limit.${key === "mcpOutputTokens" ? "mcpTokens" : "bashChars"}`)}</span><Input type="number" min={1000} className="min-h-11" value={value ?? ""} placeholder={String(effective.limits?.[key] ?? t("agentPolicy.limitNone"))} onChange={(e) => set({ limits: { mcpOutputTokens: part.limits?.mcpOutputTokens ?? null, bashOutputChars: part.limits?.bashOutputChars ?? null, [key]: e.target.value ? Number(e.target.value) : null } })} />{!hubOnly && hubLimit !== null && hubLimit !== undefined && value !== null && value > hubLimit ? lock(ceiling) : null}</label>; })}
          </fieldset>
          <details className="text-sm"><summary className="min-h-11 cursor-pointer text-fg-link">{t("settingsTidy.learnMore")}</summary><p>{rich(t("agentPolicy.ceiling"), { flag: <code>--permission-mode acceptEdits</code>, widen: <code>--allowedTools, --permission-mode</code> })}</p></details>
          <ErrorNote error={action.error} />
          <div className="flex gap-2"><Button className="min-h-11" disabled={action.busy || !draft} onClick={save}>{t("agentPolicy.save")}</Button>{!hubOnly && saved && Object.keys(saved).length ? <Button className="min-h-11" variant="outline" disabled={action.busy} onClick={() => { setDraft({}); void action.run(async () => { await client.call("agentPolicy.set", { project: selected!, policy: null }); setTick((n) => n + 1); setOpen(false); }); }}>{t("agentPolicy.clear")}</Button> : null}</div>
        </div>
      </SheetContent>
    </Sheet>
  </div>;
}
