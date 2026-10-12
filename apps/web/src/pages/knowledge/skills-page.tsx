import { useQuery } from "@tanstack/react-query";
import type { SkillSummary } from "@xdev-hive/contracts";
import { useState } from "react";
import { type Column, DataTable } from "@/components/data-table/data-table.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useT } from "@/lib/i18n.ts";
import { authorLabel, DetailCard, KnowledgeLayout, QueryState, ScopeBadge } from "@/pages/knowledge/common.tsx";
import { Markdown } from "@/pages/knowledge/markdown.tsx";
import { knowledgeText } from "@/pages/knowledge/text.ts";
import { useOrg } from "@/shell/org-context.ts";

const text = knowledgeText;
export function SkillsPage() {
  const { org } = useOrg();
  return <SkillsScreen key={org.id} />;
}
function SkillsScreen() {
  const t = useT(text);
  const { api } = useOrg();
  const list = useQuery(api.skills.list.queryOptions({ input: {} }));
  const [selected, setSelected] = useState<SkillSummary>();
  const columns: Column<SkillSummary>[] = [
    {
      key: "name",
      label: "Skill",
      value: (row) => row.name,
      sortable: true,
      cell: (row) => (
        <div>
          <strong className="font-mono">{row.name}</strong>
          <p className="text-xs text-muted-foreground">{row.description}</p>
        </div>
      ),
    },
    { key: "description", label: t.content, value: (row) => row.description, hidden: true },
    {
      key: "scope",
      label: t.scope,
      value: (row) => t[row.scope.level],
      cell: (row) => <ScopeBadge scope={row.scope} />,
    },
    { key: "version", label: t.version, value: (row) => row.version, sortable: true },
    { key: "author", label: t.author, value: (row) => authorLabel(row.updatedBy) },
    { key: "updated", label: t.updated, value: (row) => row.updatedAt, sortable: true },
  ];
  return (
    <KnowledgeLayout title="Skills" lead={t.skillsLead}>
      <DetailCard>
        <section aria-label={t.skillsRepoAria} className="flex min-w-0 flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1 basis-full sm:basis-auto">
            <p className="text-xs text-muted-foreground">{t.skillsRepoLabel}</p>
            <p className="font-medium">{t.repoNone}</p>
            <p className="mt-1 text-sm text-warning">{t.repoUnavailable}</p>
          </div>
          <Button disabled size="sm">
            {t.skillsSyncNow}
          </Button>
          <Button disabled variant="outline" size="sm">
            {t.skillsRepoSettings}
          </Button>
        </section>
      </DetailCard>
      <QueryState query={list} />
      {list.data && (
        <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[3fr_2fr]">
          <DataTable
            columns={columns}
            rows={list.data}
            placeholder={t.skillsSearch}
            selectable={false}
            facets={[{ key: "scope", label: t.scope, value: (row) => t[row.scope.level] }]}
            rowLabel={(row) => row.name}
            activeId={selected?.id ?? ""}
            onRowClick={setSelected}
            emptyContent={t.empty}
          />
          {selected ? <SkillDetail key={selected.id} skill={selected} /> : <DetailCard>{t.choose}</DetailCard>}
        </div>
      )}
    </KnowledgeLayout>
  );
}
function SkillDetail({ skill }: { skill: SkillSummary }) {
  const t = useT(text);
  const { api } = useOrg();
  const detail = useQuery(api.skills.get.queryOptions({ input: { id: skill.id } }));
  return (
    <DetailCard>
      <ScopeBadge scope={skill.scope} />
      <h2 className="break-all font-mono text-lg font-semibold">{skill.name}</h2>
      <p className="text-muted-foreground">{skill.description}</p>
      <p className="font-mono text-xs text-muted-foreground">SKILL.md · v{skill.version}</p>
      <QueryState query={detail} />
      {detail.data && <Markdown content={detail.data.content} />}
      {!detail.isPending && <p className="text-xs text-warning">{t.repoUnavailable}</p>}
    </DetailCard>
  );
}
