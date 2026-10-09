// Chính sách agent dạng hàng (R-72l, design `setRows`): mỗi hàng một điều khiển, đổi là lưu ngay. Giá trị hiệu lực chính là
// giá trị của ô chọn/công tắc, nên không còn dòng tóm tắt lặp lại; mức vượt trần hub bị khoá (disabled) chứ không ẩn.
import { useMemo, useState } from "react";
import { AUTONOMY, effectivePolicy, modelsFor, NETWORK, OPEN_POLICY, POLICY_AGENT_KINDS, type AgentPolicy, type ToolView } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Toggle } from "@xdev-hive/ui/components/ui/primitives";
import { ErrorNote } from "#ui/components/common.tsx";
import { useAction, useCan, useHive, useProjects, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { scopeProject } from "#ui/lib/scope.ts";
import { SettingsRow } from "#ui/pages/SettingsRows.tsx";

const MODEL_NAME = /^[A-Za-z0-9._:[\]-]{1,100}$/;

export function AgentPolicyRows({ hubOnly = false }: { hubOnly?: boolean }) {
  const { client, scope } = useHive();
  const t = useT();
  const can = useCan();
  const known = useProjects();
  const [picked, setPicked] = useState("");
  const [tick, setTick] = useState(0);
  const [bad, setBad] = useState<string | null>(null);
  const action = useAction();
  const view = useQuery(() => client.call("agentPolicy.get", {}), [client, tick]);
  const router = useQuery(() => client.call("modelRouter.get", {}), [client]);
  const catalog = useQuery(() => client.call("tools.list", {}).catch((): ToolView[] => []), [client]);
  const projects = useMemo(() => known.filter((p) => can(p, "projectSettings")).sort(), [known, can]);
  const selected = hubOnly ? null : projects.includes(picked) ? picked : projects.includes(scopeProject(scope) ?? "") ? scopeProject(scope)! : projects[0];
  if (!view.data) return <ErrorNote error={view.error} />;
  if (!hubOnly && !selected) return <p className="text-sm text-fg-secondary">{t("agentPolicy.noProjects")}</p>;
  const hub = view.data.hub;
  const saved: Partial<AgentPolicy> = selected ? view.data.projects[selected] ?? {} : {};
  const part: Partial<AgentPolicy> = hubOnly ? hub : saved;
  const effective: AgentPolicy = hubOnly ? { ...OPEN_POLICY, ...part } : effectivePolicy(hub, part);
  const ceiling = t("settingsTidy.hubCeiling");
  const save = (change: Partial<AgentPolicy>) => void action.run(async () => {
    const next = { ...part, ...change };
    await client.call("agentPolicy.set", { project: selected ?? null, policy: hubOnly ? { ...OPEN_POLICY, ...next } : next });
    setBad(null);
    setTick((n) => n + 1);
  });
  const mcpIds = (catalog.data ?? []).filter((tool) => tool.kind === "mcp").map((tool) => tool.id);
  const suggestions = [...new Set(Object.values(router.data?.tiers ?? {}).flatMap((row) => POLICY_AGENT_KINDS.map((k) => row[k as keyof typeof row]?.model)).filter((n): n is string => !!n))];
  const limit = (key: "mcpOutputTokens" | "bashOutputChars") => part.limits?.[key] ?? null;
  const setLimit = (key: "mcpOutputTokens" | "bashOutputChars", raw: string) => {
    const value = raw ? Number(raw) : null;
    const hubLimit = hub.limits?.[key];
    if (value !== null && (value < 1000 || (!hubOnly && hubLimit != null && value > hubLimit))) return setBad(`${t(`agentPolicy.limit.${key === "mcpOutputTokens" ? "mcpTokens" : "bashChars"}`)}: ${value < 1000 ? "≥ 1000" : `${ceiling} (${hubLimit})`}`);
    save({ limits: { mcpOutputTokens: part.limits?.mcpOutputTokens ?? null, bashOutputChars: part.limits?.bashOutputChars ?? null, [key]: value } });
  };
  const setModels = (kind: (typeof POLICY_AGENT_KINDS)[number], raw: string) => {
    const names = [...new Set(raw.split(",").map((x) => x.trim()).filter(Boolean))];
    const held = !hubOnly ? modelsFor(hub, kind) : null;
    const wrong = names.find((n) => !MODEL_NAME.test(n) || (held !== null && !held.includes(n)));
    if (wrong) return setBad(`${kind}: ${wrong} · ${held !== null && MODEL_NAME.test(wrong) ? ceiling : t("settingsTidy.addModel")}`);
    save({ models: { ...part.models, [kind]: names } });
  };
  const key = `${selected ?? "hub"}-${tick}`;
  return <div className="cx-card" data-settings-rows="agent" data-agent-policy-rows>
    {!hubOnly && projects.length > 1 ? <SettingsRow label={t("settingsRows.project")} hint={t("settingsRows.projectHint")}>
      <select className="cx-select" aria-label={t("settingsRows.project")} value={selected ?? ""} onChange={(e) => { setPicked(e.target.value); setBad(null); }}>{projects.map((p) => <option key={p} value={p}>{p}</option>)}</select>
    </SettingsRow> : null}
    <SettingsRow label={t("agentPolicy.colAutonomy")} hint={t(`settingsTidy.autonomy.${effective.autonomy}`)}>
      <select className="cx-select" data-policy-autonomy aria-label={t("agentPolicy.colAutonomy")} disabled={action.busy} value={effective.autonomy} onChange={(e) => save({ autonomy: e.target.value as AgentPolicy["autonomy"] })}>
        {AUTONOMY.map((level) => { const held = !hubOnly && AUTONOMY.indexOf(level) > AUTONOMY.indexOf(hub.autonomy); return <option key={level} value={level} disabled={held} title={held ? ceiling : undefined}>{t(`agentPolicy.autonomy.${level}`)}{held ? ` · ${ceiling}` : ""}</option>; })}
      </select>
    </SettingsRow>
    <SettingsRow label={t("agentPolicy.colNetwork")} hint={t("settingsRows.networkHint")}>
      <select className="cx-select" data-policy-network aria-label={t("agentPolicy.colNetwork")} disabled={action.busy} value={effective.network.mode} onChange={(e) => { const mode = e.target.value as AgentPolicy["network"]["mode"]; save({ network: { mode, allow: mode === "allowlist" ? part.network?.allow ?? [] : [] } }); }}>
        {NETWORK.map((mode) => { const held = !hubOnly && NETWORK.indexOf(mode) > NETWORK.indexOf(hub.network.mode); return <option key={mode} value={mode} disabled={held} title={held ? ceiling : undefined}>{t(`agentPolicy.network.${mode}`)}{held ? ` · ${ceiling}` : ""}</option>; })}
      </select>
    </SettingsRow>
    {effective.network.mode === "allowlist" ? <SettingsRow label={t("agentPolicy.allow")} hint={t("settingsRows.allowHint")}>
      <input key={`${key}-allow`} className="cx-select min-w-56" aria-label={t("agentPolicy.allow")} defaultValue={effective.network.allow.join(", ")} onBlur={(e) => { const allow = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); if (allow.join(",") !== effective.network.allow.join(",")) save({ network: { mode: "allowlist", allow } }); }} />
    </SettingsRow> : null}
    <SettingsRow label={t("agentPolicy.colMcp")} hint={t("settingsRows.mcpHint")}>
      <select className="cx-select" data-policy-mcp aria-label={t("agentPolicy.colMcp")} disabled={action.busy} value={effective.mcp === null ? "all" : "list"} onChange={(e) => save({ mcp: e.target.value === "all" ? null : part.mcp ?? effective.mcp ?? [] })}>
        <option value="all" disabled={!hubOnly && hub.mcp !== null} title={!hubOnly && hub.mcp !== null ? ceiling : undefined}>{t("agentPolicy.mcpAll")}</option>
        <option value="list">{t("agentPolicy.mcpList")}</option>
      </select>
    </SettingsRow>
    {effective.mcp !== null ? mcpIds.map((id) => { const held = !hubOnly && hub.mcp !== null && !hub.mcp.includes(id); const on = effective.mcp!.includes(id); return <SettingsRow key={id} label={id} hint={held ? ceiling : t("settingsRows.mcpToolHint")}>
      <Toggle aria-label={id} checked={on} disabled={held || action.busy} onChange={() => save({ mcp: on ? effective.mcp!.filter((x) => x !== id) : [...effective.mcp!, id] })} />
    </SettingsRow>; }) : null}
    <datalist id="agent-policy-models">{suggestions.map((n) => <option key={n} value={n} />)}</datalist>
    {POLICY_AGENT_KINDS.map((kind) => <SettingsRow key={kind} label={`${t("agentPolicy.colModels")} · ${kind}`} hint={t("settingsRows.modelsHint")}>
      <input key={`${key}-${kind}`} className="cx-select min-w-56" list="agent-policy-models" data-policy-models={kind} aria-label={`${t("agentPolicy.colModels")} ${kind}`} placeholder={t("agentPolicy.anyModel")} defaultValue={(part.models?.[kind] ?? []).join(", ")} onBlur={(e) => { if (e.target.value.trim() !== (part.models?.[kind] ?? []).join(", ")) setModels(kind, e.target.value); }} />
    </SettingsRow>)}
    {(["mcpOutputTokens", "bashOutputChars"] as const).map((k) => <SettingsRow key={k} label={t(`agentPolicy.limit.${k === "mcpOutputTokens" ? "mcpTokens" : "bashChars"}`)} hint={t("agentPolicy.limitHint")}>
      <input key={`${key}-${k}`} type="number" min={1000} className="cx-select w-32" aria-label={t(`agentPolicy.limit.${k === "mcpOutputTokens" ? "mcpTokens" : "bashChars"}`)} placeholder={String(effective.limits?.[k] ?? t("agentPolicy.limitNone"))} defaultValue={limit(k) ?? ""} onBlur={(e) => { if ((e.target.value ? Number(e.target.value) : null) !== limit(k)) setLimit(k, e.target.value); }} />
    </SettingsRow>)}
    {!hubOnly && Object.keys(saved).length ? <SettingsRow label={t("agentPolicy.clear")} hint={t("agentPolicy.ceilingTitle")}>
      <Button variant="outline" size="sm" className="max-md:min-h-11" disabled={action.busy} onClick={() => void action.run(async () => { await client.call("agentPolicy.set", { project: selected!, policy: null }); setTick((n) => n + 1); })}>{t("agentPolicy.clear")}</Button>
    </SettingsRow> : null}
    {bad || action.error ? <div className="cx-row"><ErrorNote error={bad ?? action.error} /></div> : null}
  </div>;
}
