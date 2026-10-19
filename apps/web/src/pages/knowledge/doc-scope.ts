import type { DocTreeItem } from "@xdev-hive/contracts";

// File thuần, không import React hay doc-tree.tsx: doc-tree.tsx import ngược lại Folder/folderOf từ đây.
export type Folder = { name: string; path: string; folders: Map<string, Folder>; files: DocTreeItem[] };

export type DocScopeFilter = "mine" | "all";
export interface MyMembership {
  projectIds: ReadonlySet<string>;
  teamIds: ReadonlySet<string>;
}
export interface ScopeNames {
  teams: ReadonlyMap<string, string>;
  systems: ReadonlyMap<string, { name: string; teamId: string }>;
  projects: ReadonlyMap<string, { name: string; systemId: string; teamId: string }>;
}
export type ScopeNodeKind = "org" | "team" | "team-common" | "system" | "project" | "other-projects";
export interface ScopeNode {
  kind: ScopeNodeKind;
  id: string;
  name: string;
  count: number;
  children: ScopeNode[];
  folder: Folder | null;
}

const ORG_NAME = "Chung toàn tổ chức";
const TEAM_COMMON_NAME = "Chung đơn vị";
const OTHER_PROJECTS_NAME = "Dự án khác";
const UNKNOWN_TEAM_NAME = "Đơn vị khác";

// Không có dự án nào thì "Dự án của tôi" luôn rỗng, nên dù đã lưu "mine" vẫn mở "Tất cả".
export function defaultFilter(stored: DocScopeFilter | null, m: MyMembership): DocScopeFilter {
  if (m.projectIds.size === 0) return "all";
  return stored ?? "mine";
}

export function inFilter(item: DocTreeItem, filter: DocScopeFilter, m: MyMembership): boolean {
  if (filter === "all") return true;
  const { teamId, projectId } = item.scope;
  if (teamId === null) return true;
  if (projectId === null) return m.teamIds.has(teamId);
  return m.projectIds.has(projectId);
}

export function folderOf(items: DocTreeItem[], name: string, path: string): Folder {
  const root: Folder = { name, path, folders: new Map(), files: [] };
  for (const item of items) {
    let folder = root;
    const parts = (item.path ?? item.key ?? item.title).split("/");
    for (const part of parts.slice(0, -1)) {
      let child = folder.folders.get(part);
      if (!child) {
        child = { name: part, path: `${folder.path}/${part}`, folders: new Map(), files: [] };
        folder.folders.set(part, child);
      }
      folder = child;
    }
    folder.files.push(item);
  }
  return root;
}

const byName = (a: ScopeNode, b: ScopeNode) => a.name.localeCompare(b.name, "vi");
const countDocs = (items: DocTreeItem[]) => items.filter((item) => item.kind === "doc").length;

function leaf(kind: ScopeNodeKind, id: string, name: string, items: DocTreeItem[]): ScopeNode {
  return { kind, id, name, count: countDocs(items), children: [], folder: folderOf(items, name, id) };
}

function branch(kind: ScopeNodeKind, id: string, name: string, children: ScopeNode[]): ScopeNode {
  return { kind, id, name, count: children.reduce((sum, child) => sum + child.count, 0), children, folder: null };
}

interface TeamBucket {
  common: DocTreeItem[];
  other: DocTreeItem[];
  systems: Map<string, Map<string, DocTreeItem[]>>;
}

export function buildScopeTree(items: DocTreeItem[], names: ScopeNames): ScopeNode[] {
  const org: DocTreeItem[] = [];
  const teams = new Map<string, TeamBucket>();
  const bucket = (teamId: string): TeamBucket => {
    let b = teams.get(teamId);
    if (!b) {
      b = { common: [], other: [], systems: new Map() };
      teams.set(teamId, b);
    }
    return b;
  };

  for (const item of items) {
    const { teamId, projectId } = item.scope;
    if (teamId === null) {
      org.push(item);
      continue;
    }
    const b = bucket(teamId);
    if (projectId === null) {
      b.common.push(item);
      continue;
    }
    const project = names.projects.get(projectId);
    // Dự án hoặc hệ thống không còn trong danh mục thì không có chỗ đặt riêng, gom vào "Dự án khác".
    if (!project || !names.systems.has(project.systemId)) {
      b.other.push(item);
      continue;
    }
    let systemProjects = b.systems.get(project.systemId);
    if (!systemProjects) {
      systemProjects = new Map();
      b.systems.set(project.systemId, systemProjects);
    }
    const list = systemProjects.get(projectId) ?? [];
    list.push(item);
    systemProjects.set(projectId, list);
  }

  const roots: ScopeNode[] = [];
  if (org.length) roots.push(leaf("org", "org", ORG_NAME, org));

  const teamNodes: ScopeNode[] = [];
  for (const [teamId, b] of teams) {
    const children: ScopeNode[] = [];
    if (b.common.length) children.push(leaf("team-common", `team-common:${teamId}`, TEAM_COMMON_NAME, b.common));
    const systemNodes: ScopeNode[] = [];
    for (const [systemId, projects] of b.systems) {
      const projectNodes = [...projects].map(([projectId, list]) =>
        leaf("project", `project:${projectId}`, names.projects.get(projectId)?.name ?? projectId, list),
      );
      systemNodes.push(
        branch(
          "system",
          `system:${systemId}`,
          names.systems.get(systemId)?.name ?? systemId,
          projectNodes.sort(byName),
        ),
      );
    }
    children.push(...systemNodes.sort(byName));
    if (b.other.length) children.push(leaf("other-projects", `other:${teamId}`, OTHER_PROJECTS_NAME, b.other));
    teamNodes.push(branch("team", `team:${teamId}`, names.teams.get(teamId) ?? UNKNOWN_TEAM_NAME, children));
  }
  return [...roots, ...teamNodes.sort(byName)];
}

export function openByDefault(nodes: ScopeNode[], m: MyMembership): Set<string> {
  const open = new Set<string>();
  const visit = (node: ScopeNode): boolean => {
    let hasMine = node.kind === "project" && m.projectIds.has(node.id.slice("project:".length));
    for (const child of node.children) if (visit(child)) hasMine = true;
    if (hasMine) open.add(node.id);
    return hasMine;
  };
  for (const node of nodes) visit(node);
  return open;
}
