// The "Agent" part of the policy page (roadmap 27a): the hub's default and one row per project, each with what a run
// of it may use after the merge. A project's row only tightens the default, so the Hiệu lực column is what runs get,
// at most: each profile's own CLI flags can hold a run lower still, and the policy never widens them (report of 2/10).
import { useMemo, useState } from "react";
import {
  AUTONOMY,
  effectivePolicy,
  modelsFor,
  NETWORK,
  OPEN_POLICY,
  POLICY_AGENT_KINDS,
  type AgentPolicy,
  type Autonomy,
  type NetworkMode,
  type ToolView,
} from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@xdev-hive/ui/components/ui/table";
import { Empty, ErrorNote, Notice } from "#ui/components/common.tsx";
import { formatTime, useAction, useCan, useHive, useProjects, useQuery } from "#ui/hooks.ts";
import { rich, useT } from "#ui/i18n/index.tsx";

const CODE = "rounded bg-muted px-1 py-0.5 font-mono text-xs";
/** The hub's row; "@" is not allowed in a project name, so it never collides with one. */
const HUB = "@hub";
type Kind = (typeof POLICY_AGENT_KINDS)[number];

/** A row as typed: "" in a select means "as the hub" (projects only), models and hosts are comma lists. */
interface Draft {
  models: Record<Kind, string>;
  autonomy: Autonomy | "";
  network: NetworkMode | "";
  allow: string;
  mcp: "" | "all" | "list";
  mcpList: string;
  /** Output limits (roadmap 28c), "" for none. */
  mcpTokens: string;
  bashChars: string;
}

const split = (s: string) => [...new Set(s.split(",").map((x) => x.trim()).filter(Boolean))];

function toDraft(p: Partial<AgentPolicy>): Draft {
  return {
    models: Object.fromEntries(POLICY_AGENT_KINDS.map((k) => [k, (p.models?.[k] ?? []).join(", ")])) as Record<Kind, string>,
    autonomy: p.autonomy ?? "",
    network: p.network?.mode ?? "",
    allow: (p.network?.allow ?? []).join(", "),
    mcp: p.mcp === undefined ? "" : p.mcp === null ? "all" : "list",
    mcpList: (p.mcp ?? []).join(", "),
    mcpTokens: p.limits?.mcpOutputTokens?.toString() ?? "",
    bashChars: p.limits?.bashOutputChars?.toString() ?? "",
  };
}

const limitOf = (s: string): number | null => (s.trim() ? Number.parseInt(s, 10) || null : null);

/** Only the fields set; the hub's row always sets them all (its selects have no "as the hub"). */
function toPart(d: Draft): Partial<AgentPolicy> {
  const part: Partial<AgentPolicy> = {};
  const models = Object.fromEntries(POLICY_AGENT_KINDS.map((k) => [k, split(d.models[k])] as const).filter(([, list]) => list.length));
  if (Object.keys(models).length) part.models = models;
  if (d.autonomy) part.autonomy = d.autonomy;
  if (d.network) part.network = { mode: d.network, allow: d.network === "allowlist" ? split(d.allow) : [] };
  if (d.mcp) part.mcp = d.mcp === "all" ? null : split(d.mcpList);
  const limits = { mcpOutputTokens: limitOf(d.mcpTokens), bashOutputChars: limitOf(d.bashChars) };
  if (limits.mcpOutputTokens !== null || limits.bashOutputChars !== null) part.limits = limits;
  return part;
}

export function AgentPolicyCard({ editableOnly = false }: { editableOnly?: boolean }) {
  const { client, me } = useHive();
  const t = useT();
  const can = useCan();
  const known = useProjects();
  const [tick, setTick] = useState(0);
  const view = useQuery(() => client.call("agentPolicy.get", {}), [client, tick]);
  // The catalog's MCP servers (roadmap 28a), offered in the MCP list; a hub older than it has none.
  const catalog = useQuery(() => client.call("tools.list", {}).catch((): ToolView[] => []), [client]);
  const mcpIds = useMemo(() => (catalog.data ?? []).filter((x) => x.kind === "mcp").map((x) => x.id), [catalog.data]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const action = useAction();
  // The default binds every project: a hub admin's only, as on the hub (agentPolicy.set).
  const hubAdmin = me.role === "admin" && !me.access;

  const projects = useMemo(() => {
    const names = new Set<string>([...known, ...Object.keys(view.data?.projects ?? {})]);
    return [...names].filter((p) => !editableOnly || can(p, "projectSettings")).sort();
  }, [known, view.data, editableOnly, can]);

  if (!view.data) return <ErrorNote error={view.error} />;
  const data = view.data;
  const draftOf = (key: string): Draft => drafts[key] ?? toDraft(key === HUB ? data.hub : (data.projects[key] ?? {}));
  // Whole, not merged onto the saved one: models cleared in the draft must clear them.
  const hub: AgentPolicy = { ...OPEN_POLICY, ...toPart(draftOf(HUB)) };
  const edit = (key: string, next: Partial<Draft>) => {
    setSaved(null);
    setDrafts((d) => ({ ...d, [key]: { ...draftOf(key), ...next } }));
  };
  const save = (key: string, policy: Partial<AgentPolicy> | null) =>
    void action.run(async () => {
      if (key === HUB) await client.call("agentPolicy.set", { project: null, policy: policy as AgentPolicy | null });
      else await client.call("agentPolicy.set", { project: key, policy });
      setDrafts(({ [key]: _done, ...rest }) => rest);
      setSaved(key);
      setTick((n) => n + 1);
    });

  const row = (key: string) => {
    const isHub = key === HUB;
    const d = draftOf(key);
    const editable = isHub ? hubAdmin : can(key, "projectSettings");
    const part = toPart(d);
    // What the row would give runs once saved: the drafted default for the hub, merged with it for a project.
    const effective = isHub ? hub : effectivePolicy(hub, part);
    const inherit = isHub ? null : <NativeSelectOption value="">{t("agentPolicy.inherit")}</NativeSelectOption>;
    return (
      <TableRow key={key}>
        <TableCell className="align-top font-mono text-xs">{isHub ? <span className="font-sans font-medium">{t("agentPolicy.hubDefault")}</span> : key}</TableCell>
        <TableCell className="align-top">
          <div className="flex min-w-48 flex-col gap-1.5">
            {POLICY_AGENT_KINDS.map((k) => (
              <label key={k} className="flex items-center gap-2 text-xs">
                <span className="w-12 shrink-0 font-mono text-muted-foreground">{k}</span>
                <Input
                  className="h-7 text-xs"
                  value={d.models[k]}
                  disabled={!editable}
                  placeholder={isHub ? t("agentPolicy.anyModel") : t("agentPolicy.inherit")}
                  onChange={(e) => edit(key, { models: { ...d.models, [k]: e.target.value } })}
                />
              </label>
            ))}
          </div>
        </TableCell>
        <TableCell className="align-top">
          <NativeSelect
            size="sm"
            value={isHub ? d.autonomy || "full" : d.autonomy}
            disabled={!editable}
            aria-label={t("agentPolicy.colAutonomy")}
            onChange={(e) => edit(key, { autonomy: e.target.value as Draft["autonomy"] })}
          >
            {inherit}
            {AUTONOMY.map((a) => (
              <NativeSelectOption key={a} value={a}>
                {t(`agentPolicy.autonomy.${a}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </TableCell>
        <TableCell className="align-top">
          <div className="flex min-w-40 flex-col gap-1.5">
            <NativeSelect
              size="sm"
              value={isHub ? d.network || "open" : d.network}
              disabled={!editable}
              aria-label={t("agentPolicy.colNetwork")}
              onChange={(e) => edit(key, { network: e.target.value as Draft["network"] })}
            >
              {inherit}
              {NETWORK.map((n) => (
                <NativeSelectOption key={n} value={n}>
                  {t(`agentPolicy.network.${n}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {d.network === "allowlist" ? (
              <Input
                className="h-7 text-xs"
                value={d.allow}
                disabled={!editable}
                placeholder={t("agentPolicy.allowPlaceholder")}
                aria-label={t("agentPolicy.allow")}
                onChange={(e) => edit(key, { allow: e.target.value })}
              />
            ) : null}
          </div>
        </TableCell>
        <TableCell className="align-top">
          <div className="flex min-w-40 flex-col gap-1.5">
            <NativeSelect
              size="sm"
              value={isHub ? d.mcp || "all" : d.mcp}
              disabled={!editable}
              aria-label={t("agentPolicy.colMcp")}
              onChange={(e) => edit(key, { mcp: e.target.value as Draft["mcp"] })}
            >
              {inherit}
              <NativeSelectOption value="all">{t("agentPolicy.mcpAll")}</NativeSelectOption>
              <NativeSelectOption value="list">{t("agentPolicy.mcpList")}</NativeSelectOption>
            </NativeSelect>
            {d.mcp === "list" ? (
              <Input
                className="h-7 text-xs"
                value={d.mcpList}
                disabled={!editable}
                placeholder={t("agentPolicy.mcpPlaceholder")}
                aria-label={t("agentPolicy.mcpList")}
                onChange={(e) => edit(key, { mcpList: e.target.value })}
              />
            ) : null}
            {/* Roadmap 28c: Claude Code's output limits for the row's runs; a project only lowers the hub's. */}
            {(["mcpTokens", "bashChars"] as const).map((f) => (
              <label key={f} className="flex items-center gap-2 text-xs" title={t("agentPolicy.limitHint")}>
                <span className="w-20 shrink-0 text-muted-foreground">{t(`agentPolicy.limit.${f}`)}</span>
                <Input
                  className="h-7 font-mono text-xs"
                  inputMode="numeric"
                  value={d[f]}
                  disabled={!editable}
                  placeholder={isHub ? t("agentPolicy.limitNone") : t("agentPolicy.inherit")}
                  aria-label={t(`agentPolicy.limit.${f}`)}
                  onChange={(e) => edit(key, { [f]: e.target.value.replace(/[^\d]/g, "") })}
                />
              </label>
            ))}
            {/* Other names stay allowed: Codex has servers of its own in ~/.codex/config.toml. */}
            {d.mcp === "list" && editable && mcpIds.some((id) => !split(d.mcpList).includes(id)) ? (
              <div className="flex flex-wrap items-center gap-1 text-[11px] text-fg-muted">
                {t("agentPolicy.mcpSuggest")}
                {mcpIds
                  .filter((id) => !split(d.mcpList).includes(id))
                  .map((id) => (
                    <Button key={id} type="button" size="xs" variant="outline" className="font-mono" onClick={() => edit(key, { mcpList: [...split(d.mcpList), id].join(", ") })}>
                      + {id}
                    </Button>
                  ))}
              </div>
            ) : null}
          </div>
        </TableCell>
        <TableCell className="align-top whitespace-normal">
          <Effective policy={effective} />
        </TableCell>
        <TableCell className="align-top">
          {editable ? (
            <div className="flex flex-col items-start gap-1.5">
              <Button size="sm" disabled={action.busy || !drafts[key]} onClick={() => save(key, isHub ? hub : part)}>
                {t("agentPolicy.save")}
              </Button>
              {!isHub && data.projects[key] ? (
                <Button size="sm" variant="outline" disabled={action.busy} onClick={() => save(key, null)}>
                  {t("agentPolicy.clear")}
                </Button>
              ) : null}
              {saved === key ? <span className="text-xs text-success">{t("agentPolicy.saved")}</span> : null}
            </div>
          ) : null}
        </TableCell>
      </TableRow>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("agentPolicy.title")}</CardTitle>
        <CardDescription>{t("agentPolicy.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Notice tone="info" title={t("agentPolicy.ceilingTitle")}>
          {/* One paragraph: the alert lays out each child on a row of its own. */}
          <p className="m-0">
            {rich(t("agentPolicy.ceiling"), {
              flag: <code className={CODE}>--permission-mode acceptEdits</code>,
              widen: (
                <>
                  <code className={CODE}>--allowedTools</code>, <code className={CODE}>--permission-mode</code>
                </>
              ),
            })}
          </p>
        </Notice>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("agentPolicy.colScope")}</TableHead>
                <TableHead>{t("agentPolicy.colModels")}</TableHead>
                <TableHead>{t("agentPolicy.colAutonomy")}</TableHead>
                <TableHead>{t("agentPolicy.colNetwork")}</TableHead>
                <TableHead>{t("agentPolicy.colMcp")}</TableHead>
                <TableHead>{t("agentPolicy.colEffective")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {row(HUB)}
              {projects.map(row)}
            </TableBody>
          </Table>
        </div>
        {projects.length === 0 ? <Empty>{t("agentPolicy.noProjects")}</Empty> : null}
        {data.updatedAt ? <span className="text-sm text-muted-foreground">{t("admin.policyUpdated", { time: formatTime(data.updatedAt), who: data.updatedBy ?? "" })}</span> : null}
        <ErrorNote error={action.error} />
      </CardContent>
    </Card>
  );
}

/** What runs of the row get, in words. */
export function Effective({ policy: p }: { policy: AgentPolicy }) {
  const t = useT();
  const models = POLICY_AGENT_KINDS.map((k) => [k, modelsFor(p, k)] as const).filter(([, list]) => list !== null);
  return (
    <ul className="flex min-w-48 flex-col gap-0.5 text-xs">
      <li>
        {models.length
          ? models.map(([k, list]) => `${k}: ${list!.length ? list!.join(", ") : t("agentPolicy.noModel")}`).join(" · ")
          : t("agentPolicy.anyModel")}
      </li>
      <li>{t("agentPolicy.autonomyMax", { level: t(`agentPolicy.autonomy.${p.autonomy}`) })}</li>
      <li>
        {t(`agentPolicy.network.${p.network.mode}`)}
        {p.network.mode === "allowlist" ? `: ${p.network.allow.join(", ") || "—"}` : ""}
      </li>
      <li>MCP: {p.mcp === null ? t("agentPolicy.mcpAll") : p.mcp.length ? p.mcp.join(", ") : t("agentPolicy.mcpNone")}</li>
      {p.limits?.mcpOutputTokens != null || p.limits?.bashOutputChars != null ? (
        <li>{t("agentPolicy.limitsEffective", { mcp: p.limits.mcpOutputTokens ?? "—", bash: p.limits.bashOutputChars ?? "—" })}</li>
      ) : null}
    </ul>
  );
}
