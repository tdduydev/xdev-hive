import { Tabs } from "@base-ui/react/tabs";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { SkillSummary } from "@xdev-hive/contracts";
import { Markdown } from "@xdev-hive/ui/markdown";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { useId, useState } from "react";
import { type Column, DataTable } from "@/components/data-table/data-table.tsx";
import { PageSection } from "@/components/page/page-section.tsx";
import { DescriptionList } from "@/components/ui/description-list.tsx";
import { LoadFailure, TableSkeleton } from "@/components/ui/query-state.tsx";
import { useT } from "@/lib/i18n.ts";
import type { SkillTab } from "@/lib/route-search.ts";
import { authorLabel, DetailFallback, EmptyRows, QueryState, ScopeBadge, When } from "@/pages/knowledge/common.tsx";
import { SkillLearningTab, usePendingLearned } from "@/pages/knowledge/skill-learning-tab.tsx";
import { SkillPackSection } from "@/pages/knowledge/skill-pack-section.tsx";
import { SkillRepoCard } from "@/pages/knowledge/skill-repo-card.tsx";
import { knowledgeText } from "@/pages/knowledge/text.ts";
import { useOrg } from "@/shell/org-context.ts";
import { DetailHeader, PageBody, PageHeader, PageTab, PageTabList } from "@/shell/page-header.tsx";

const text = knowledgeText;

export function SkillsPage() {
  const { org } = useOrg();
  return <SkillsScreen key={org.id} />;
}
function SkillsScreen() {
  const t = useT(text);
  const { api } = useOrg();
  const list = useQuery(api.skills.list.queryOptions({ input: {} }));
  const navigate = useNavigate();
  const learned = usePendingLearned();
  const { tab = "skills" } = useSearch({ from: "/session/app/in-org/knowledge/skills" });
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
      <Tabs.Root
        value={tab}
        onValueChange={(value) =>
          navigate({ to: "/knowledge/skills", search: value === "de-xuat" ? { tab: "de-xuat" } : {}, replace: true })
        }
      >
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
                  facets={[{ key: "scope", label: t.scope, value: (row) => t[row.scope.level] }]}
                  rowLabel={(row) => row.name}
                  onRowClick={(row) => navigate({ to: "/knowledge/skills/$skillId", params: { skillId: row.id } })}
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
    </>
  );
}
export function SkillDetailPage() {
  const { org } = useOrg();
  const { skillId } = useParams({ from: "/session/app/in-org/knowledge/skills/$skillId" });
  return <SkillDetailScreen key={`${org.id}:${skillId}`} id={skillId} />;
}

function SkillDetailScreen({ id }: { id: string }) {
  const t = useT(text);
  const { api } = useOrg();
  const navigate = useNavigate();
  const { tab = "tong-quan" } = useSearch({ from: "/session/app/in-org/knowledge/skills/$skillId" });
  const detail = useQuery(api.skills.get.queryOptions({ input: { id } }));
  const skill = detail.data;
  if (!skill) return <DetailFallback query={detail} title="Skills" back="/knowledge/skills" />;
  return (
    <>
      <DetailHeader
        back={{ to: "/knowledge/skills", label: "Skills" }}
        title={skill.name}
        status={skill.repoPath ? <Pill tone="ok">{t.inGit}</Pill> : <Pill>{t.hubOnly}</Pill>}
        meta={
          <>
            <ScopeBadge scope={skill.scope} />
            <span className="font-mono">v{skill.version}</span>
            <span>
              {authorLabel(skill.updatedBy)} · <When iso={skill.updatedAt} />
            </span>
            <span className="basis-full text-sm">{skill.description}</span>
          </>
        }
      />
      <Tabs.Root
        value={tab}
        onValueChange={(value: SkillTab | "tong-quan") =>
          navigate({
            to: "/knowledge/skills/$skillId",
            params: { skillId: id },
            search: value === "tong-quan" ? {} : { tab: value },
            replace: true,
          })
        }
      >
        <PageTabList label={t.skillViews}>
          <PageTab value="tong-quan">{t.overview}</PageTab>
          <PageTab value="hoc-duoc">{t.learnedTab}</PageTab>
          <PageTab value="phien-ban" count={skill.version}>
            {t.versionsTab}
          </PageTab>
        </PageTabList>
        <Tabs.Panel value="tong-quan">
          <PageBody width="wide">
            <DescriptionList
              items={[
                { term: t.path, detail: skill.repoPath ?? t.hubOnlyHint, mono: !!skill.repoPath },
                { term: t.version, detail: `v${skill.version}`, mono: true },
                { term: t.updated, detail: <When iso={skill.updatedAt} /> },
              ]}
            />
            <PageSection title="SKILL.md">
              <Markdown content={skill.content} />
            </PageSection>
          </PageBody>
        </Tabs.Panel>
        <Tabs.Panel value="hoc-duoc">
          <PageBody width="wide">
            <SkillLearningTab skill={skill.name} />
          </PageBody>
        </Tabs.Panel>
        <Tabs.Panel value="phien-ban">
          <PageBody width="wide">
            <SkillVersions id={id} latest={skill.version} />
          </PageBody>
        </Tabs.Panel>
      </Tabs.Root>
    </>
  );
}

/** Hub giữ mọi bản của skill nhưng không có danh sách bản: chọn số bản rồi đọc nội dung bản đó. */
function SkillVersions({ id, latest }: { id: string; latest: number }) {
  const t = useT(text);
  const fieldId = useId();
  const { api } = useOrg();
  const [version, setVersion] = useState(latest);
  const detail = useQuery(api.skills.get.queryOptions({ input: { id, version } }));
  return (
    <PageSection
      title={t.versionsTab}
      description={t.versionsLead}
      actions={
        <label htmlFor={fieldId} className="flex items-center gap-2 text-sm">
          {t.versionPick}
          <NativeSelect
            id={fieldId}
            value={String(version)}
            onChange={(event) => setVersion(Number(event.currentTarget.value))}
          >
            {Array.from({ length: latest }, (_, index) => latest - index).map((value) => (
              <option key={value} value={value}>
                v{value}
              </option>
            ))}
          </NativeSelect>
        </label>
      }
    >
      <QueryState query={detail} />
      {detail.data && (
        <>
          <p className="text-xs text-muted-foreground">
            {authorLabel(detail.data.updatedBy)} · <When iso={detail.data.updatedAt} />
          </p>
          <Markdown content={detail.data.content} />
        </>
      )}
    </PageSection>
  );
}
