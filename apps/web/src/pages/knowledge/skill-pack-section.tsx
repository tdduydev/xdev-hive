import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PackSkill } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Markdown } from "@xdev-hive/ui/markdown";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { useId, useState } from "react";
import { type Column, DataTable } from "@/components/data-table/data-table.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { DetailCard, QueryState } from "@/pages/knowledge/common.tsx";
import { useOrg } from "@/shell/org-context.ts";

type Row = PackSkill & { id: string };

const text: Dict<{
  aria: string;
  title: string;
  badge: string;
  lead: string;
  source: string;
  applyTo: string;
  wholeOrg: string;
  search: string;
  group: string;
  groups: Record<string, string>;
  license: string;
  state: string;
  on: string;
  off: string;
  byDefault: string;
  byOrg: string;
  byProject: string;
  shadowed: (level: string) => string;
  levels: Record<string, string>;
  toggle: (name: string) => string;
  onlyAdmin: string;
  upstream: string;
  ownSkill: string;
  files: (n: number, kb: number) => string;
  reset: string;
  choose: string;
  empty: string;
}> = {
  vi: {
    aria: "Skill mặc định của Hive",
    title: "Skill mặc định của Hive",
    badge: "Hive mặc định",
    lead: "Đóng gói sẵn trong Hive, chỉ đọc. Mỗi skill đang bật thêm mô tả của nó vào mọi run, nên chỉ bật thứ dự án cần. Skill cùng tên của tổ chức, đội hay dự án được dùng thay bản mặc định.",
    source: "Nguồn",
    applyTo: "Áp cho",
    wholeOrg: "Cả tổ chức",
    search: "Tìm skill mặc định, mô tả, giấy phép…",
    group: "Nhóm",
    groups: {
      ui: "Giao diện",
      engineering: "Quy trình kỹ sư",
      testing: "Kiểm thử",
      security: "Bảo mật",
      tools: "Công cụ",
      sdlc: "Spec Kit",
      hive: "Hive",
    },
    license: "Giấy phép",
    state: "Trạng thái",
    on: "Đang bật",
    off: "Đang tắt",
    byDefault: "Theo mặc định của Hive",
    byOrg: "Tổ chức đặt",
    byProject: "Dự án đặt",
    shadowed: (level) => `Đang dùng bản của ${level}`,
    levels: { org: "tổ chức", team: "đội", project: "dự án" },
    toggle: (name) => `Bật ${name}`,
    onlyAdmin: "Chỉ quản trị tổ chức bật, tắt cho cả tổ chức. Chọn một dự án để đặt riêng (quản trị đội).",
    upstream: "Bản gốc",
    ownSkill: "Viết riêng cho Hive",
    files: (n, kb) => `${n} file · ${kb} KB`,
    reset: "Theo phạm vi rộng hơn",
    choose: "Chọn một skill để xem SKILL.md, nguồn và giấy phép.",
    empty: "Không có skill nào khớp.",
  },
  en: {
    aria: "Hive default skills",
    title: "Hive default skills",
    badge: "Hive default",
    lead: "Bundled with Hive, read-only. Every skill that is on adds its description to each run, so turn on only what the project needs. A skill with the same name in the organization, team or project is used instead.",
    source: "Source",
    applyTo: "Apply to",
    wholeOrg: "Whole organization",
    search: "Search default skills, descriptions, licenses…",
    group: "Group",
    groups: {
      ui: "UI",
      engineering: "Engineering",
      testing: "Testing",
      security: "Security",
      tools: "Tools",
      sdlc: "Spec Kit",
      hive: "Hive",
    },
    license: "License",
    state: "Status",
    on: "On",
    off: "Off",
    byDefault: "Hive default",
    byOrg: "Set by organization",
    byProject: "Set by project",
    shadowed: (level) => `Using the ${level} version`,
    levels: { org: "organization", team: "team", project: "project" },
    toggle: (name) => `Turn on ${name}`,
    onlyAdmin: "Only organization admins change the whole organization. Pick a project to set it there (team admins).",
    upstream: "Upstream",
    ownSkill: "Written for Hive",
    files: (n, kb) => `${n} files · ${kb} KB`,
    reset: "Follow the wider scope",
    choose: "Pick a skill to see its SKILL.md, source and license.",
    empty: "No skill matches.",
  },
};

const shortSha = (sha: string) => sha.slice(0, 7);

/** Bộ skill mặc định (packages/skill-pack): bật/tắt theo tổ chức, hoặc đặt riêng cho một dự án. */
export function SkillPackSection() {
  const t = useT(text);
  const { api, org } = useOrg();
  const queryClient = useQueryClient();
  const scopeId = useId();
  const [project, setProject] = useState("");
  const [selected, setSelected] = useState<string>();
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const input = project ? { project } : {};
  const pack = useQuery(api.skills.pack.queryOptions({ input }));
  const set = useMutation({
    mutationFn: (v: { name: string; enabled: boolean | null }) =>
      api.skills.packSet.call({ ...v, ...(project ? { project } : {}) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: api.skills.key() }),
  });
  const canSet = project !== "" || isOrgAdmin(org.role);
  const rows: Row[] = (pack.data?.skills ?? []).map((s) => ({ ...s, id: s.name }));
  const groupOf = (row: Row) => t.groups[row.group] ?? row.group;
  const origin = (row: Row) => (row.project !== null ? t.byProject : row.org !== null ? t.byOrg : t.byDefault);
  const columns: Column<Row>[] = [
    {
      key: "name",
      label: "Skill",
      value: (row) => row.name,
      sortable: true,
      cell: (row) => (
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="font-mono">{row.name}</strong>
            <Pill tone="sel">{t.badge}</Pill>
          </div>
          <p className="line-clamp-2 text-xs text-muted-foreground">{row.description}</p>
        </div>
      ),
    },
    { key: "description", label: t.state, value: (row) => row.description, hidden: true },
    { key: "group", label: t.group, value: groupOf, sortable: true },
    {
      key: "license",
      label: t.license,
      value: (row) => row.license,
      cell: (row) => <span className="font-mono text-xs">{row.license}</span>,
    },
    {
      key: "state",
      label: t.state,
      value: (row) => (row.enabled ? t.on : t.off),
      cell: (row) => (
        <div className="space-y-1">
          <Pill tone={row.enabled ? "ok" : "neutral"}>{row.enabled ? t.on : t.off}</Pill>
          <p className="text-xs text-muted-foreground">
            {row.shadowedBy ? t.shadowed(t.levels[row.shadowedBy] ?? row.shadowedBy) : origin(row)}
          </p>
        </div>
      ),
    },
    {
      key: "toggle",
      label: t.on,
      value: (row) => (row.enabled ? "1" : "0"),
      cell: (row) => (
        // Bấm công tắc không mở chi tiết của dòng.
        // biome-ignore lint/a11y/noStaticElementInteractions: chỉ chặn click lan lên dòng, công tắc tự xử lý bàn phím.
        // biome-ignore lint/a11y/useKeyWithClickEvents: như trên.
        <span onClick={(e) => e.stopPropagation()}>
          <Switch
            aria-label={t.toggle(row.name)}
            checked={row.enabled}
            disabled={!canSet || set.isPending}
            onCheckedChange={(enabled) => set.mutate({ name: row.name, enabled })}
          />
        </span>
      ),
    },
  ];
  const active = rows.find((r) => r.id === selected);
  return (
    <DetailCard>
      <section aria-label={t.aria} className="flex min-w-0 flex-col gap-3">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 className="font-heading text-lg font-semibold">{t.title}</h2>
            <p className="max-w-3xl text-sm text-muted-foreground">{t.lead}</p>
            {pack.data && (
              <p className="text-xs text-muted-foreground">
                {t.source}:{" "}
                <a
                  className="font-mono underline-offset-2 hover:underline"
                  href={`https://github.com/${pack.data.source.repo}/tree/${pack.data.source.commit}/library`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {pack.data.source.repo}@{shortSha(pack.data.source.commit)}
                </a>
              </p>
            )}
          </div>
          <label htmlFor={scopeId} className="flex items-center gap-2 text-sm">
            {t.applyTo}
            <NativeSelect
              id={scopeId}
              value={project}
              onChange={(e) => {
                setProject(e.target.value);
                set.reset();
              }}
            >
              <option value="">{t.wholeOrg}</option>
              {projects.data?.map((p) => (
                <option key={p.id} value={p.key}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </label>
        </header>
        {!canSet && <p className="text-xs text-muted-foreground">{t.onlyAdmin}</p>}
        {set.error && <Alert variant="destructive">{apiErrorMessage(set.error)}</Alert>}
        <QueryState query={pack} />
        {pack.data && (
          <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[3fr_2fr]">
            <DataTable
              columns={columns}
              rows={rows}
              placeholder={t.search}
              selectable={false}
              facets={[
                { key: "group", label: t.group, value: groupOf },
                { key: "state", label: t.state, value: (row) => (row.enabled ? t.on : t.off) },
              ]}
              rowLabel={(row) => row.name}
              activeId={selected ?? ""}
              onRowClick={(row) => setSelected(row.id)}
              emptyContent={t.empty}
            />
            {active ? (
              <PackSkillDetail
                key={`${active.name}:${project}`}
                skill={active}
                project={project}
                canReset={canSet && (project ? active.project !== null : active.org !== null)}
                onReset={() => set.mutate({ name: active.name, enabled: null })}
              />
            ) : (
              <DetailCard>{t.choose}</DetailCard>
            )}
          </div>
        )}
      </section>
    </DetailCard>
  );
}

function PackSkillDetail({
  skill,
  project,
  canReset,
  onReset,
}: {
  skill: Row;
  project: string;
  canReset: boolean;
  onReset: () => void;
}) {
  const t = useT(text);
  const { api } = useOrg();
  const detail = useQuery(
    api.skills.packGet.queryOptions({ input: { name: skill.name, ...(project ? { project } : {}) } }),
  );
  return (
    <DetailCard>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="sel">{t.badge}</Pill>
        <Pill tone={skill.enabled ? "ok" : "neutral"}>{skill.enabled ? t.on : t.off}</Pill>
      </div>
      <h3 className="break-all font-mono text-lg font-semibold">{skill.name}</h3>
      <p className="text-muted-foreground">{skill.description}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t.license}</dt>
        <dd className="font-mono">{skill.license}</dd>
        <dt className="text-muted-foreground">{t.upstream}</dt>
        <dd className="min-w-0 break-all">
          {skill.upstream ? (
            <a
              className="font-mono underline-offset-2 hover:underline"
              href={skill.upstream.url}
              target="_blank"
              rel="noreferrer"
            >
              {skill.upstream.repo}@{shortSha(skill.upstream.commit)}
            </a>
          ) : (
            t.ownSkill
          )}
        </dd>
        <dt className="text-muted-foreground">SKILL.md</dt>
        <dd className="font-mono text-xs">
          v{skill.version} · {t.files(skill.files, Math.ceil(skill.bytes / 1024))}
        </dd>
      </dl>
      {canReset && (
        <Button variant="outline" size="sm" className="self-start" onClick={onReset}>
          {t.reset}
        </Button>
      )}
      <QueryState query={detail} />
      {detail.data && <Markdown content={detail.data.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")} />}
    </DetailCard>
  );
}
