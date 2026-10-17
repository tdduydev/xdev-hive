import { expect, type Page, test } from "@playwright/test";
import { doc, docTreeItem } from "@xdev-hive/contracts";
import { expandDocTree } from "./docsync-docs-fixture.ts";
import { DOC_HOME_ID } from "./docsync-settings-fixture.ts";
import { ok, type RpcHandler } from "./fake-hub.ts";
import { inOrg, ORG_ID } from "./reviews-fixture.ts";

const NOW = "2026-10-17T03:00:00.000Z";
const uuid = (n: number) => `7b7b7b7b-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TEAM_A = uuid(1);
const TEAM_B = uuid(2);
const SYSTEM_A = uuid(11);
const SYSTEM_B = uuid(12);
const P1 = uuid(21);
const P2 = uuid(22);
const Q1 = uuid(23);
const Q2 = uuid(24);
const PROJECT_NAMES = ["Dự án P1", "Dự án P2", "Dự án Q1", "Dự án Q2"];

const team = (id: string, name: string) => ({
  id,
  name,
  slug: name.toLowerCase().replace(/\s+/g, "-"),
  color: null,
  createdAt: NOW,
  systemCount: 1,
  memberCount: 1,
});
const system = (id: string, teamId: string, name: string) => ({
  id,
  teamId,
  slug: name.toLowerCase().replace(/\s+/g, "-"),
  name,
  description: null,
  createdAt: NOW,
});
const project = (id: string, systemId: string, teamId: string, name: string) => ({
  id,
  systemId,
  teamId,
  key: name.toLowerCase().replace(/\s+/g, "-"),
  name,
  state: "active",
  createdAt: NOW,
});

interface Row {
  key: string;
  title: string;
  state: "synced" | "failed";
  scope: { level: "org" | "team" | "project"; teamId: string | null; projectId: string | null };
}
const orgScope = { level: "org", teamId: null, projectId: null } as const;
const inTeam = (teamId: string) => ({ level: "team", teamId, projectId: null }) as const;
const inProject = (teamId: string, projectId: string) => ({ level: "project", teamId, projectId }) as const;
const rows: Row[] = [
  { key: "org/guide", title: "Hướng dẫn chung", state: "synced", scope: orgScope },
  { key: "team/a/quy-uoc", title: "Quy ước đơn vị A", state: "synced", scope: inTeam(TEAM_A) },
  { key: "project/p1/spec", title: "Đặc tả P1", state: "synced", scope: inProject(TEAM_A, P1) },
  { key: "project/p1/loi", title: "Tài liệu lỗi P1", state: "failed", scope: inProject(TEAM_A, P1) },
  { key: "project/p2/spec", title: "Đặc tả P2", state: "synced", scope: inProject(TEAM_A, P2) },
  { key: "project/p2/loi", title: "Tài liệu lỗi P2", state: "failed", scope: inProject(TEAM_A, P2) },
  { key: "project/q1/spec", title: "Đặc tả Q1", state: "synced", scope: inProject(TEAM_B, Q1) },
  { key: "project/q2/spec", title: "Đặc tả Q2", state: "synced", scope: inProject(TEAM_B, Q2) },
];

function scenario(mine: { projectIds: string[]; teamIds: string[] }) {
  const items = rows.map((row, i) =>
    docTreeItem.parse({
      homeId: DOC_HOME_ID,
      path: `docs/${i}.md`,
      key: row.key,
      title: row.title,
      kind: "doc",
      state: row.state,
      prNumber: null,
      prUrl: null,
      repoUrl: `https://github.com/acme/handbook/blob/main/docs/${i}.md`,
      repoCommit: "a".repeat(40),
      docId: uuid(100 + i),
      assetId: null,
      version: 1,
      error: row.state === "failed" ? "Không kết nối được repo." : null,
      scope: row.scope,
    }),
  );
  const docs = rows.map((row, i) =>
    doc.parse({
      id: uuid(100 + i),
      key: row.key,
      title: row.title,
      scope: row.scope,
      version: 1,
      updatedAt: NOW,
      updatedBy: { userId: "u1", runId: null },
      content: "Nội dung.",
    }),
  );
  const rpc: Record<string, RpcHandler> = {
    "teams/list": () => ok([team(TEAM_A, "Đơn vị A"), team(TEAM_B, "Đơn vị B")]),
    "systems/list": () => ok([system(SYSTEM_A, TEAM_A, "Hệ thống A"), system(SYSTEM_B, TEAM_B, "Hệ thống B")]),
    "projects/list": () =>
      ok([
        project(P1, SYSTEM_A, TEAM_A, "Dự án P1"),
        project(P2, SYSTEM_A, TEAM_A, "Dự án P2"),
        project(Q1, SYSTEM_B, TEAM_B, "Dự án Q1"),
        project(Q2, SYSTEM_B, TEAM_B, "Dự án Q2"),
      ]),
    "projectMembers/mine": () => ok(mine),
    "docs/list": (input) => ok((input as { archived?: boolean }).archived ? [] : docs),
    "docTree/list": () => ok({ items, nextCursor: null }),
  };
  return { items, rpc };
}

const tree = (page: Page) => page.getByRole("list", { name: "Cây tài liệu" });
const node = (page: Page, name: string) => tree(page).getByRole("button", { name: new RegExp(` nhóm ${name}$`) });
const scope = (page: Page) => page.getByRole("group", { name: "Phạm vi tài liệu" });
const titles = (page: Page) =>
  tree(page)
    .getByRole("button", { name: /^Mở dòng / })
    .evaluateAll((els) => els.map((el) => (el.getAttribute("aria-label") ?? "").replace(/^Mở dòng /, "")).sort());

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

test("mặc định Dự án của tôi, đổi sang Tất cả và nhớ qua lần tải lại", async ({ page }) => {
  const { rpc } = scenario({ projectIds: [P1], teamIds: [TEAM_A] });
  await inOrg(page, "member", rpc);
  await page.goto("/knowledge/docs");
  await expect(tree(page)).toBeVisible({ timeout: 20_000 });
  await expect(scope(page).getByRole("button", { name: "Dự án của tôi" })).toHaveAttribute("aria-pressed", "true");
  await expect(node(page, "Dự án P1")).toBeVisible();
  await expect(node(page, "Dự án P2")).toHaveCount(0);
  await expect(node(page, "Dự án Q1")).toHaveCount(0);
  await expect(node(page, "Đơn vị B")).toHaveCount(0);

  await scope(page).getByRole("button", { name: "Tất cả" }).click();
  await expandDocTree(page);
  for (const name of PROJECT_NAMES) await expect(node(page, name)).toBeVisible();

  await page.reload();
  await expect(tree(page)).toBeVisible({ timeout: 20_000 });
  await expect(scope(page).getByRole("button", { name: "Tất cả" })).toHaveAttribute("aria-pressed", "true");
  await expandDocTree(page);
  await expect(node(page, "Dự án Q1")).toBeVisible();
});

test("người chưa thuộc dự án nào mặc định thấy Tất cả", async ({ page }) => {
  const { rpc } = scenario({ projectIds: [], teamIds: [] });
  await inOrg(page, "member", rpc);
  // Dù lần trước đã chọn "Dự án của tôi", người không có dự án nào vẫn thấy Tất cả để trang không trống.
  await page.addInitScript((id) => localStorage.setItem(`hive.docScope.${id}`, "mine"), ORG_ID);
  await page.goto("/knowledge/docs");
  await expect(tree(page)).toBeVisible({ timeout: 20_000 });
  await expect(scope(page).getByRole("button", { name: "Tất cả" })).toHaveAttribute("aria-pressed", "true");
  await expandDocTree(page);
  for (const name of PROJECT_NAMES) await expect(node(page, name)).toBeVisible();
});

test("bộ lọc trạng thái đồng bộ áp cùng bộ lọc phạm vi", async ({ page }) => {
  const { rpc } = scenario({ projectIds: [P1], teamIds: [TEAM_A] });
  await inOrg(page, "member", rpc);
  await page.goto("/knowledge/docs");
  await expect(tree(page)).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Trạng thái đồng bộ", { exact: true }).selectOption("failed");
  await expandDocTree(page);
  expect(await titles(page)).toEqual(["Tài liệu lỗi P1"]);
  await expect(node(page, "Dự án P2")).toHaveCount(0);
});

test("Tất cả hiện đúng tập tài liệu như trước", async ({ page }) => {
  const { items, rpc } = scenario({ projectIds: [P1], teamIds: [TEAM_A] });
  await inOrg(page, "member", rpc);
  await page.goto("/knowledge/docs");
  await expect(tree(page)).toBeVisible({ timeout: 20_000 });
  await scope(page).getByRole("button", { name: "Tất cả" }).click();
  await expandDocTree(page);
  // Mỗi tiêu đề trong fixture ứng với đúng một key, nên so tiêu đề là so tập key (SC-001).
  expect(await titles(page)).toEqual(items.map((item) => item.title).sort());
});
