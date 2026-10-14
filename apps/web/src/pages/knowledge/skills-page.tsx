import { Tabs } from "@base-ui/react/tabs";
import { useQuery } from "@tanstack/react-query";
import type { SkillSummary } from "@xdev-hive/contracts";
import { Markdown } from "@xdev-hive/ui/markdown";
import { Pill } from "@xdev-hive/ui/pill";
import { useState } from "react";
import { type Column, DataTable } from "@/components/data-table/data-table.tsx";
import { PageSection } from "@/components/page/page-section.tsx";
import { LoadFailure, TableSkeleton } from "@/components/ui/query-state.tsx";
import { useT } from "@/lib/i18n.ts";
import {
  authorLabel,
  DetailDialog,
  EmptyRows,
  QueryState,
  ScopeBadge,
  useTabParam,
  When,
} from "@/pages/knowledge/common.tsx";
import { SkillLearningTab, usePendingLearned } from "@/pages/knowledge/skill-learning-tab.tsx";
import { SkillPackSection } from "@/pages/knowledge/skill-pack-section.tsx";
import { SkillRepoCard } from "@/pages/knowledge/skill-repo-card.tsx";
import { knowledgeText } from "@/pages/knowledge/text.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader, PageTab, PageTabList } from "@/shell/page-header.tsx";

const text = knowledgeText;
const TABS = ["de-xuat"] as const;

export function SkillsPage() {
  const { org } = useOrg();
  return <SkillsScreen key={org.id} />;
}
function SkillsScreen() {
  const t = useT(text);
  const { api } = useOrg();
  const list = useQuery(api.skills.list.queryOptions({ input: {} }));
  const [selected, setSelected] = useState<SkillSummary>();
  const learned = usePendingLearned();
  const [tab, setTab] = useTabParam(TABS);
  const columns: Column<SkillSummary>[] = [
    {
      key: "name",
      label: "Skill",
      value: (row) => row.name,
      sortable: true,
      pin: "start",
      cell: (row) => (
        <div className="min-w-0 space-y-0.5">
          <strong className="font-mono">{row.name}</strong>
          <p className="line-clamp-2 text-xs text-muted-foreground">{row.description}</p>
        </div>
      ),
    },
    { key: "description", label: t.content, value: (row) => row.description, hidden: true, hideable: false },
    {
      key: "scope",
      label: t.scope,
      value: (row) => t[row.scope.level],
      cell: (row) => <ScopeBadge scope={row.scope} />,
    },
    {
      key: "git",
      label: "Git",
      value: (row) => (row.repoPath ? t.inGit : t.hubOnly),
      cell: (row) => (row.repoPath ? <Pill tone="ok">{t.inGit}</Pill> : <Pill>{t.hubOnly}</Pill>),
    },
    {
      key: "version",
      label: t.version,
      value: (row) => row.version,
      sortable: true,
      align: "end",
      cell: (row) => `v${row.version}`,
    },
    { key: "author", label: t.author, value: (row) => authorLabel(row.updatedBy), hidden: true },
    {
      key: "updated",
      label: t.updated,
      value: (row) => row.updatedAt,
      sortable: true,
      cell: (row) => <When iso={row.updatedAt} />,
    },
  ];
  return (
    <>
      <PageHeader title="Skills" description={t.skillsLead} />
      <Tabs.Root value={tab ?? "skills"} onValueChange={(value) => setTab(value === "skills" ? undefined : "de-xuat")}>
        <PageTabList label={t.skillsViews}>
          <PageTab value="skills" count={list.data?.length}>
            Skills
          </PageTab>
          <PageTab value="de-xuat" count={learned.data?.length} tone="warning">
            {t.skillsLearned}
          </PageTab>
        </PageTabList>
        <Tabs.Panel value="skills">
          <PageBody>
            <SkillRepoCard />
            <PageSection title={t.skillsOrgTitle} description={t.skillsOrgLead}>
              {list.isPending && <TableSkeleton label={t.loading} columns={5} />}
              {list.isError && <LoadFailure error={list.error} retry={list.refetch} />}
              {list.data && (
                <DataTable
                  columns={columns}
                  rows={list.data}
                  minWidth={620}
                  placeholder={t.skillsSearch}
                  selectable={false}
                  facets={[{ key: "scope", label: t.scope, value: (row) => t[row.scope.level] }]}
                  rowLabel={(row) => row.name}
                  activeId={selected?.id ?? ""}
                  onRowClick={setSelected}
                  emptyContent={<EmptyRows title={t.skillsEmptyTitle} description={t.skillsEmptyBody} />}
                />
              )}
            </PageSection>
            <SkillPackSection />
          </PageBody>
        </Tabs.Panel>
        <Tabs.Panel value="de-xuat">
          <PageBody>
            <SkillLearningTab />
          </PageBody>
        </Tabs.Panel>
      </Tabs.Root>
      {selected && <SkillDetail key={selected.id} skill={selected} onClose={() => setSelected(undefined)} />}
    </>
  );
}
function SkillDetail({ skill, onClose }: { skill: SkillSummary; onClose: () => void }) {
  const t = useT(text);
  const { api } = useOrg();
  const detail = useQuery(api.skills.get.queryOptions({ input: { id: skill.id } }));
  return (
    <DetailDialog
      title={skill.name}
      onClose={onClose}
      badges={<ScopeBadge scope={skill.scope} />}
      description={
        <>
          SKILL.md · v{skill.version} · {skill.repoPath ?? t.hubOnlyHint}
        </>
      }
    >
      <p className="text-sm text-muted-foreground">{skill.description}</p>
      <QueryState query={detail} />
      {detail.data && <Markdown content={detail.data.content} />}
    </DetailDialog>
  );
}
