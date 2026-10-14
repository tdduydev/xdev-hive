import { useQuery } from "@tanstack/react-query";
import type { SkillSummary } from "@xdev-hive/contracts";
import { Markdown } from "@xdev-hive/ui/markdown";
import { Pill } from "@xdev-hive/ui/pill";
import { useState } from "react";
import { type Column, DataTable } from "@/components/data-table/data-table.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { useT } from "@/lib/i18n.ts";
import { authorLabel, DetailCard, KnowledgeLayout, QueryState, ScopeBadge } from "@/pages/knowledge/common.tsx";
import { SkillLearningTab, usePendingLearned } from "@/pages/knowledge/skill-learning-tab.tsx";
import { SkillPackSection } from "@/pages/knowledge/skill-pack-section.tsx";
import { SkillRepoCard } from "@/pages/knowledge/skill-repo-card.tsx";
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
  const learned = usePendingLearned();
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
    {
      key: "git",
      label: "Git",
      value: (row) => (row.repoPath ? t.inGit : t.hubOnly),
      cell: (row) => (row.repoPath ? <Pill tone="ok">{t.inGit}</Pill> : <Pill>{t.hubOnly}</Pill>),
    },
    { key: "version", label: t.version, value: (row) => row.version, sortable: true },
    { key: "author", label: t.author, value: (row) => authorLabel(row.updatedBy) },
    { key: "updated", label: t.updated, value: (row) => row.updatedAt, sortable: true },
  ];
  return (
    <KnowledgeLayout title="Skills" lead={t.skillsLead}>
      <Tabs defaultValue="skills">
        <TabsList variant="line" aria-label={t.skillsViews}>
          <TabsTrigger value="skills">Skills</TabsTrigger>
          <TabsTrigger value="learned">
            {t.skillsLearned}
            <Pill small>{learned.data?.length ?? "—"}</Pill>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="skills" className="space-y-4">
          <SkillRepoCard />
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
          <SkillPackSection />
        </TabsContent>
        <TabsContent value="learned">
          <SkillLearningTab />
        </TabsContent>
      </Tabs>
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
      {detail.data && (
        <p className="text-xs text-muted-foreground">
          {skill.repoPath ? <span className="font-mono">{skill.repoPath}</span> : t.hubOnlyHint}
        </p>
      )}
    </DetailCard>
  );
}
