import { expect, type Page, test } from "@playwright/test";
import { fail, fakeHub, ok, type RpcHandler, USER } from "./fake-hub.ts";

const at = "2026-10-12T03:00:00.000Z";
const orgId = "0a0a0a0a-0000-4000-8000-000000000001";
const teamId = "0a0a0a0a-0000-4000-8000-000000000002";
const projectId = "0a0a0a0a-0000-4000-8000-000000000003";
const scope = { level: "org", teamId: null, projectId: null };
const author = { userId: USER.id, runId: null };
const doc = {
  id: "0a0a0a0a-0000-4000-8000-000000000004",
  key: "org/money",
  title: "Quy ước tiền tệ",
  scope,
  version: 2,
  updatedAt: at,
  updatedBy: author,
};
const skill = {
  id: "0a0a0a0a-0000-4000-8000-000000000005",
  name: "code-review",
  description: "Kiểm tra code",
  scope,
  version: 2,
  updatedAt: at,
  updatedBy: author,
};
const commit = "d246ca68816356dc3cea9737e7d41a82569582eb";
const packSkill = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  description: `Mô tả ${name}`,
  group: "ui",
  license: "MIT",
  upstream: { repo: "vercel-labs/agent-skills", commit, path: `skills/${name}`, url: `https://github.com/x/${name}` },
  defaultOn: false,
  org: null as boolean | null,
  project: null as boolean | null,
  enabled: false,
  shadowedBy: null as string | null,
  version: 1,
  files: 3,
  bytes: 4096,
  ...over,
});
const memory = {
  id: "0a0a0a0a-0000-4000-8000-000000000006",
  kind: "decision",
  status: "approved",
  content: "Lưu tiền theo đơn vị nhỏ nhất.",
  files: ["money.ts"],
  scope,
  author,
  createdAt: at,
  supersededBy: null as string | null,
};
const proposal = {
  id: "0a0a0a0a-0000-4000-8000-000000000007",
  kind: "doc",
  target: doc.key,
  scope,
  baseVersion: 1,
  title: null,
  description: null,
  content: "# Money\nRound per line.\nNo float.",
  reason: "Làm tròn theo từng dòng",
  status: "pending",
  author,
  createdAt: at,
  decidedBy: null,
  decidedAt: null,
  decisionNote: null as string | null,
  resultVersion: null,
};

async function setup(
  page: Page,
  options: { role?: string; teamRole?: string; overrides?: Record<string, RpcHandler> } = {},
) {
  let memories = [memory];
  let proposals = [proposal];
  // Bộ skill mặc định giả: đặt riêng theo tổ chức ("") hoặc theo key dự án, như skill_pack_settings của hub.
  const packBase = [
    packSkill("web-design-guidelines", { defaultOn: true }),
    packSkill("shadcn"),
    packSkill("systematic-debugging", { group: "engineering", defaultOn: true, shadowedBy: "org" }),
    packSkill("hive-run-etiquette", { group: "hive", defaultOn: true, upstream: null }),
  ];
  const overrides = new Map<string, boolean>();
  const packView = (project: string) =>
    packBase.map((s) => {
      const org = overrides.get(`:${s.name}`) ?? null;
      const own = project ? (overrides.get(`${project}:${s.name}`) ?? null) : null;
      return { ...s, org, project: own, enabled: own ?? org ?? s.defaultOn };
    });
  return fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () =>
        ok({
          orgs: [
            { id: orgId, slug: "acme", name: "Acme", role: options.role ?? "owner", emailDomain: null, createdAt: at },
          ],
          canCreateOrg: false,
        }),
      "orgMembers/list": () =>
        ok([
          {
            userId: USER.id,
            name: USER.name,
            email: USER.email,
            image: null,
            role: "member",
            status: "active",
            joinedAt: at,
            teams: [{ teamId, name: "Platform", role: options.teamRole ?? "viewer" }],
          },
        ]),
      "teams/list": () =>
        ok([
          {
            id: teamId,
            name: "Platform",
            slug: "platform",
            color: null,
            createdAt: at,
            systemCount: 0,
            memberCount: 1,
          },
        ]),
      "projects/list": () => ok([{ id: projectId, teamId, name: "Hive", key: "hive", createdAt: at }]),
      "notifications/unreadCount": () => ok({ count: 0 }),
      "docs/list": () => ok([doc]),
      "docs/get": (input) =>
        ok({
          ...doc,
          version: (input as { version?: number }).version ?? 2,
          content:
            (input as { version?: number }).version === 1
              ? "# Money\nRound total.\nNo float."
              : "# Money\nRound per line.\n**No float.**\n[Unsafe](javascript:alert)\n<script>alert(1)</script>\n\n| Rule | Value |\n| --- | --- |\n| Currency | VND |",
        }),
      "docs/history": () =>
        ok(
          [2, 1].map((version) => ({
            version,
            title: doc.title,
            author,
            message: `Revision ${version}`,
            proposalId: null,
            chars: 40,
            createdAt: at,
          })),
        ),
      "skills/list": () => ok([skill]),
      "skills/get": () => ok({ ...skill, content: "# Review\n- Check permissions\n```ts\nconst safe = true;\n```" }),
      "skills/pack": (input) =>
        ok({
          source: { repo: "tdduydev/xdev-skills", commit },
          skills: packView((input as { project?: string }).project ?? ""),
        }),
      "skills/packGet": (input) => {
        const { name, project } = input as { name: string; project?: string };
        const s = packView(project ?? "").find((x) => x.name === name);
        return ok({ ...s, content: `---\nname: ${name}\n---\n# ${name}\nCác bước của skill.`, paths: ["SKILL.md"] });
      },
      "skills/packSet": (input) => {
        const { name, project, enabled } = input as { name: string; project?: string; enabled: boolean | null };
        const key = `${project ?? ""}:${name}`;
        if (enabled === null) overrides.delete(key);
        else overrides.set(key, enabled);
        return ok(packView(project ?? "").find((x) => x.name === name));
      },
      "memory/list": (input) => {
        const { includeSuperseded, status } = input as { includeSuperseded?: boolean; status?: string };
        // Hub chỉ liệt kê memory đã duyệt khi không chọn trạng thái; ở đây chưa có memory chờ duyệt nào.
        if (status === "pending") return ok([]);
        return ok(includeSuperseded ? memories : memories.filter((item) => !item.supersededBy));
      },
      "memory/search": () => ok([{ ...memory, score: 0.98, matchedBy: ["text", "vector"] }]),
      "memory/write": (input) => {
        const item = { ...memory, ...(input as object), id: "0a0a0a0a-0000-4000-8000-000000000008" };
        memories = [item, ...memories];
        return ok(item);
      },
      "memory/supersede": (input) => {
        const item = { ...memory, ...(input as object), id: "0a0a0a0a-0000-4000-8000-000000000009" };
        memories = [item, { ...memory, supersededBy: item.id }];
        return ok(item);
      },
      "proposals/list": (input) =>
        ok(
          proposals.filter(
            (item) => !(input as { status?: string }).status || item.status === (input as { status?: string }).status,
          ),
        ),
      ...Object.fromEntries(
        ["approve", "reject"].map((action) => [
          `proposals/${action}`,
          (input: unknown) => {
            const item = {
              ...proposal,
              status: action === "approve" ? "approved" : "rejected",
              decisionNote: (input as { note: string }).note,
            };
            proposals = [item];
            return ok(item);
          },
        ]),
      ),
      ...options.overrides,
    },
  });
}

test("docs: read markdown safely and select historical version using the keyboard", async ({ page }) => {
  const hub = await setup(page);
  await page.goto("/knowledge/docs");
  await page.getByRole("button", { name: "Mở dòng Quy ước tiền tệ" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Money", exact: true })).toBeVisible();
  await expect(page.locator("article strong")).toHaveText("No float.");
  await expect(page.locator('article a[href^="javascript:"]')).toHaveCount(0);
  await expect(page.locator("article script")).toHaveCount(0);
  await expect(page.locator("article table")).toContainText("Currency");
  await page.getByRole("button", { name: "Lịch sử", exact: true }).click();
  await page.getByLabel("Bản", { exact: true }).selectOption("1");
  await expect(page.locator("article")).toContainText("Round total.");
  expect(
    hub.rpcCalls.some(
      (call) => call.path === "docs/get" && (call.input as { version: number }).version === 1 && call.org === orgId,
    ),
  ).toBeTruthy();
  await expect(page.getByRole("button", { name: "Sửa", exact: true })).toHaveCount(0);
});

test("skills: read SKILL.md; no Git repository yet offers to connect one", async ({ page }) => {
  const hub = await setup(page, { overrides: { "skillRepo/get": () => ok(null) } });
  await page.goto("/knowledge/skills");
  await expect(page.getByText("Chưa kết nối kho Git")).toBeVisible();
  await expect(page.getByRole("button", { name: "Kết nối repo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Đồng bộ ngay" })).toHaveCount(0);
  await page.getByRole("button", { name: "Mở dòng code-review" }).click();
  await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
  await expect(page.locator("article pre")).toContainText("const safe = true;");
  expect(hub.rpcCalls.filter((call) => call.path.includes("sync"))).toHaveLength(0);
});

test("skills: Hive default skills show label, license and source, and turn on per organization or project", async ({
  page,
}) => {
  const hub = await setup(page);
  await page.goto("/knowledge/skills");
  const pack = page.getByRole("region", { name: "Skill mặc định của Hive" });
  await expect(pack.getByRole("heading", { name: "Skill mặc định của Hive" })).toBeVisible();
  await expect(pack.getByRole("link", { name: "tdduydev/xdev-skills@d246ca6" })).toBeVisible();
  const shadcn = pack.getByRole("row", { name: /shadcn/ });
  await expect(shadcn.getByText("Đang tắt")).toBeVisible();
  await expect(
    pack.getByRole("row", { name: /systematic-debugging/ }).getByText("Đang dùng bản của tổ chức"),
  ).toBeVisible();

  await pack.getByRole("switch", { name: "Bật shadcn" }).click();
  await expect(shadcn.getByText("Đang bật")).toBeVisible();
  await expect(shadcn.getByText("Tổ chức đặt")).toBeVisible();
  expect(hub.rpcCalls.find((c) => c.path === "skills/packSet")?.input).toEqual({ name: "shadcn", enabled: true });

  // Đặt riêng cho dự án: tắt skill bật sẵn chỉ trong dự án Hive.
  await pack.getByLabel("Áp cho").selectOption("hive");
  const web = pack.getByRole("row", { name: /web-design-guidelines/ });
  await expect(web.getByText("Theo mặc định của Hive")).toBeVisible();
  await pack.getByRole("switch", { name: "Bật web-design-guidelines" }).click();
  await expect(web.getByText("Dự án đặt")).toBeVisible();
  await expect(web.getByText("Đang tắt")).toBeVisible();
  expect(hub.rpcCalls.filter((c) => c.path === "skills/packSet").at(-1)?.input).toEqual({
    name: "web-design-guidelines",
    enabled: false,
    project: "hive",
  });

  // Chi tiết (hộp thoại): nhãn, giấy phép, bản gốc, SKILL.md; bỏ đặt riêng thì theo tổ chức.
  await pack.getByRole("button", { name: "Mở dòng web-design-guidelines" }).click();
  const detail = page.getByRole("dialog");
  await expect(detail.getByText("Hive mặc định")).toBeVisible();
  await expect(detail.getByText("MIT")).toBeVisible();
  await expect(detail.getByRole("link", { name: /vercel-labs\/agent-skills@d246ca6/ })).toBeVisible();
  await expect(detail.locator("article")).toContainText("Các bước của skill.");
  await detail.getByRole("button", { name: "Theo phạm vi rộng hơn" }).click();
  await page.keyboard.press("Escape");
  await expect(web.getByText("Theo mặc định của Hive")).toBeVisible();
  expect(hub.rpcCalls.filter((c) => c.path === "skills/packSet").at(-1)?.input).toEqual({
    name: "web-design-guidelines",
    enabled: null,
    project: "hive",
  });
  await pack.getByRole("button", { name: "Mở dòng hive-run-etiquette" }).click();
  await expect(page.getByRole("dialog").getByText("Viết riêng cho Hive")).toBeVisible();
});

test("skills: members cannot change Hive default skills for the whole organization", async ({ page }) => {
  await setup(page, { role: "member" });
  await page.goto("/knowledge/skills");
  const pack = page.getByRole("region", { name: "Skill mặc định của Hive" });
  await expect(pack.getByRole("switch", { name: "Bật shadcn" })).toBeDisabled();
  await expect(pack.getByText(/Chỉ quản trị tổ chức bật, tắt cho cả tổ chức/)).toBeVisible();
  await pack.getByLabel("Áp cho").selectOption("hive");
  await expect(pack.getByRole("switch", { name: "Bật shadcn" })).toBeEnabled();
});

test("skills: connected Git repository shows status, sync now and which skills are in Git", async ({ page }) => {
  const repo = {
    id: "0a0a0a0a-0000-4000-8000-000000000099",
    connectionId: "0a0a0a0a-0000-4000-8000-000000000098",
    owner: "acme",
    name: "xdev-skills",
    branch: "main",
    status: "ok",
    lastSha: "abcdef1234567",
    lastSyncedAt: at,
    error: "teams/khong-co/x/SKILL.md: không có đội khong-co trong tổ chức, bỏ qua.",
    webhookUrl: null,
    hubOnly: 1,
  };
  const hub = await setup(page, {
    overrides: {
      "skillRepo/get": () => ok(repo),
      "skillRepo/sync": () => ok({ queued: true }),
      "skills/list": () =>
        ok([
          { ...skill, repoPath: "org/code-review/SKILL.md" },
          { ...skill, id: "0a0a0a0a-0000-4000-8000-000000000097", name: "deploy", repoPath: null },
        ]),
    },
  });
  await page.goto("/knowledge/skills");
  await expect(page.getByText("acme/xdev-skills@main")).toBeVisible();
  await expect(page.getByText("Đã đồng bộ")).toBeVisible();
  await expect(page.getByText(/1 skill chưa vào Git/)).toBeVisible();
  await expect(page.getByText(/Chưa có webhook/)).toBeVisible();
  await expect(page.getByText(/không có đội khong-co/)).toBeVisible();
  await expect(page.getByRole("row", { name: /code-review/ }).getByText("Trong Git")).toBeVisible();
  await expect(page.getByRole("row", { name: /deploy/ }).getByText("Chỉ trên hub")).toBeVisible();
  await page.getByRole("button", { name: "Đồng bộ ngay" }).click();
  await expect.poll(() => hub.rpcCalls.some((c) => c.path === "skillRepo/sync")).toBe(true);
});

test("skills: connect a repository with an existing Git connection", async ({ page }) => {
  const hub = await setup(page, {
    overrides: {
      "skillRepo/get": () => ok(null),
      "scmConnections/list": () =>
        ok([
          {
            id: "0a0a0a0a-0000-4000-8000-000000000098",
            kind: "github",
            name: "GitHub Acme",
            baseUrl: null,
            defaultOwner: "acme",
            authMode: "app",
            appId: "1",
            installationId: 2,
            createdAt: at,
          },
        ]),
      "skillRepo/set": (input) =>
        ok({
          id: "0a0a0a0a-0000-4000-8000-000000000099",
          ...(input as object),
          status: "idle",
          lastSha: null,
          lastSyncedAt: null,
          error: null,
          webhookUrl: "https://hive.example/hooks/skills/x",
          hubOnly: 3,
        }),
    },
  });
  await page.goto("/knowledge/skills");
  await page.getByRole("button", { name: "Kết nối repo" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Owner").fill("acme");
  await dialog.getByLabel("Repo").fill("team-skills");
  await dialog.getByRole("button", { name: "Kết nối" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(hub.rpcCalls.find((c) => c.path === "skillRepo/set")?.input).toEqual({
    connectionId: "0a0a0a0a-0000-4000-8000-000000000098",
    owner: "acme",
    name: "team-skills",
    branch: "main",
  });
});

test("memory: hybrid search, kind filter, write and supersede", async ({ page }) => {
  const hub = await setup(page);
  await page.goto("/knowledge/memory");
  // Một ô tìm duy nhất: không còn ô lọc cục bộ thứ hai trong bảng.
  await expect(page.getByRole("textbox")).toHaveCount(1);
  const kinds = page.getByRole("group", { name: "Loại", exact: true });
  await kinds.getByRole("button", { name: "Bẫy đã gặp" }).click();
  await expect(kinds.getByRole("button", { name: "Bẫy đã gặp" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("table")).not.toContainText(memory.content);
  await expect(page.getByText("Không có memory nào khớp")).toBeVisible();
  await kinds.getByRole("button", { name: "Tất cả" }).click();
  await page.getByRole("button", { name: "Thêm memory" }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Nội dung", exact: true }).fill("Quy ước mới");
  await page.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("table")).toContainText("Quy ước mới");
  // Memory có trang riêng (Decision 2); thay xong thì sang trang của memory mới.
  await page.getByRole("button", { name: "Mở dòng Quy ước mới" }).click();
  await expect(page).toHaveURL(/\/knowledge\/memory\/0a0a0a0a-0000-4000-8000-000000000008$/);
  await page.getByRole("button", { name: "Thay memory", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Nội dung", exact: true }).fill("Quy ước thay thế");
  await page.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(page).toHaveURL(/\/knowledge\/memory\/0a0a0a0a-0000-4000-8000-000000000009$/);
  await expect(page.locator("main").last()).toContainText("Quy ước thay thế");
  await page.locator("main").last().getByRole("link", { name: "Memory", exact: true }).click();
  await expect(page.getByRole("table")).toContainText("Quy ước thay thế");
  await page.getByRole("textbox", { name: "Tìm theo từ và theo nghĩa…" }).fill("tiền");
  await page.getByRole("button", { name: "Tìm", exact: true }).click();
  await expect(page.getByRole("table")).toContainText("Từ, Nghĩa");
  await expect(page.getByRole("status")).toContainText("tiền");
  expect(hub.rpcCalls.find((call) => call.path === "memory/search")?.input).toEqual({ query: "tiền", limit: 50 });
  expect(hub.rpcCalls.find((call) => call.path === "memory/write")?.input).toMatchObject({
    scope: { level: "org" },
    content: "Quy ước mới",
  });
  expect(hub.rpcCalls.find((call) => call.path === "memory/supersede")?.input).toMatchObject({
    content: "Quy ước thay thế",
  });
  await page.getByRole("button", { name: "Bỏ lọc Tìm", exact: true }).click();
  await expect(page.getByRole("table")).not.toContainText("Từ, Nghĩa");
});

for (const action of ["approve", "reject"] as const) {
  test(`proposals: diff and ${action} with a note`, async ({ page }) => {
    const hub = await setup(page);
    await page.goto("/knowledge/proposals");
    await page.getByRole("button", { name: `Mở dòng ${doc.key}` }).click();
    const diff = page.getByRole("region", { name: "Thay đổi nội dung" });
    await expect(diff).toContainText("Round total.");
    await expect(diff).toContainText("Round per line.");
    await expect(diff.locator(".bg-destructive-soft")).toContainText("Round total.");
    await expect(diff.locator(".bg-success-soft")).toContainText("Round per line.");
    await page.getByLabel("Ghi chú khi duyệt").fill("Đã kiểm tra");
    await page.getByRole("button", { name: action === "approve" ? "Duyệt" : "Từ chối", exact: true }).click();
    // Quyết xong thì trang chi tiết ở lại với trạng thái mới, và dòng rời tab "Chờ duyệt".
    const main = page.locator("main").last();
    await expect(main.getByText(action === "approve" ? "Đã duyệt" : "Bị từ chối", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Duyệt", exact: true })).toHaveCount(0);
    await main.getByRole("link", { name: "Đề xuất sửa", exact: true }).click();
    await expect(page.getByRole("table")).not.toContainText(doc.key);
    await page.getByRole("tab", { name: action === "approve" ? "Đã duyệt" : "Bị từ chối" }).click();
    await expect(page.getByRole("table")).toContainText(doc.key);
    expect(hub.rpcCalls.find((call) => call.path === `proposals/${action}`)?.input).toEqual({
      id: proposal.id,
      note: "Đã kiểm tra",
    });
  });
}

test("proposals: conflict preserves note and does not pretend approval succeeded", async ({ page }) => {
  await setup(page, {
    overrides: { "proposals/approve": () => fail("CONFLICT", 409, "Bản gốc đã đổi sau khi đề xuất.") },
  });
  await page.goto("/knowledge/proposals");
  await page.getByRole("button", { name: `Mở dòng ${doc.key}` }).click();
  await page.getByLabel("Ghi chú khi duyệt").fill("Giữ ghi chú");
  await page.getByRole("button", { name: "Duyệt", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Bản gốc đã đổi");
  await expect(page.getByLabel("Ghi chú khi duyệt")).toHaveValue("Giữ ghi chú");
});

test("viewer has no memory write or proposal decision controls", async ({ page }) => {
  await setup(page, { role: "member" });
  await page.goto("/knowledge/memory");
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("button", { name: "Thêm memory" })).toHaveCount(0);
  await page.getByRole("button", { name: `Mở dòng ${memory.content}` }).click();
  await expect(page.getByRole("button", { name: "Thay memory", exact: true })).toHaveCount(0);
  await page.goto("/knowledge/proposals");
  await page.getByRole("button", { name: `Mở dòng ${doc.key}` }).click();
  await expect(page.getByRole("region", { name: "Thay đổi nội dung" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Duyệt", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Từ chối", exact: true })).toHaveCount(0);
});

test("team admin can decide team proposals but cannot decide org proposals", async ({ page }) => {
  await setup(page, {
    role: "member",
    teamRole: "admin",
    overrides: {
      "proposals/list": () =>
        ok([
          proposal,
          {
            ...proposal,
            id: "team-proposal",
            target: "team/platform/money",
            scope: { level: "team", teamId, projectId: null },
          },
        ]),
    },
  });
  await page.goto("/knowledge/proposals");
  await page.getByRole("button", { name: `Mở dòng ${doc.key}` }).click();
  await expect(page.getByRole("region", { name: "Thay đổi nội dung" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Duyệt", exact: true })).toHaveCount(0);
  await page.goBack();
  await page.getByRole("button", { name: "Mở dòng team/platform/money" }).click();
  await expect(page.getByRole("button", { name: "Duyệt", exact: true })).toBeEnabled();
});

test("proposal page opens from a link, keeps its tab in the URL and lists the target's history", async ({ page }) => {
  await setup(page);
  // Link dán tay (không đi qua bảng): trang tự tìm đề xuất trong danh sách của hub.
  await page.goto(`/knowledge/proposals/${proposal.id}?tab=lich-su`);
  await expect(page.getByRole("heading", { name: doc.key, exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Lịch sử" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("row").filter({ hasText: "Đề xuất đang xem" })).toHaveCount(1);
  await page.getByRole("tab", { name: "Thay đổi" }).click();
  await expect(page).not.toHaveURL(/tab=/);
  await expect(page.getByRole("region", { name: "Thay đổi nội dung" })).toContainText("Round per line.");
  await page.goto("/knowledge/proposals/0a0a0a0a-0000-4000-8000-0000000000ff");
  await expect(page.getByRole("alert")).toContainText("Không tìm thấy mục này");
  await expect(page.getByRole("link", { name: "Về danh sách" })).toHaveAttribute("href", "/knowledge/proposals");
});

test("skill page: overview, agent proposals for the skill and older versions", async ({ page }) => {
  const hub = await setup(page);
  await page.goto(`/knowledge/skills/${skill.id}`);
  await expect(page.getByRole("heading", { name: skill.name, exact: true })).toBeVisible();
  await expect(page.locator("article pre")).toContainText("const safe = true;");
  await page.getByRole("tab", { name: "Phiên bản" }).click();
  await expect(page).toHaveURL(/tab=phien-ban/);
  await page.getByLabel("Xem bản").selectOption("1");
  await expect
    .poll(() => hub.rpcCalls.filter((c) => c.path === "skills/get").at(-1)?.input)
    .toEqual({ id: skill.id, version: 1 });
  await page.getByRole("tab", { name: "Học được" }).click();
  await expect(page).toHaveURL(/tab=hoc-duoc/);
});

test("skill proposal reads the exact scope and base version when names repeat", async ({ page }) => {
  const hub = await setup(page, {
    overrides: {
      "proposals/list": () =>
        ok([
          {
            ...proposal,
            kind: "skill",
            target: skill.name,
            scope: { level: "team", teamId, projectId: null },
            content: "# Review\nNew policy",
          },
        ]),
      "skills/list": () =>
        ok([skill, { ...skill, id: "team-skill", scope: { level: "team", teamId, projectId: null } }]),
      "skills/get": () => ok({ ...skill, id: "team-skill", content: "# Review\nOld policy" }),
    },
  });
  await page.goto("/knowledge/proposals");
  await page.getByRole("button", { name: `Mở dòng ${skill.name}` }).click();
  const diff = page.getByRole("region", { name: "Thay đổi nội dung" });
  await expect(diff).toContainText("Old policy");
  await expect(diff).toContainText("New policy");
  expect(hub.rpcCalls.find((call) => call.path === "skills/get")?.input).toEqual({ id: "team-skill", version: 1 });
});

test("memory write error preserves form content", async ({ page }) => {
  await setup(page, { overrides: { "memory/write": () => fail("FORBIDDEN", 403, "Bạn không có quyền ghi.") } });
  await page.goto("/knowledge/memory");
  await page.getByRole("button", { name: "Thêm memory" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Nội dung", exact: true }).fill("Giữ nội dung");
  await dialog.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Bạn không có quyền ghi.");
  await expect(dialog.getByRole("textbox", { name: "Nội dung", exact: true })).toHaveValue("Giữ nội dung");
});

const EMPTY_TITLE = {
  docs: "Chưa có tài liệu nào",
  skills: "Chưa có skill của tổ chức",
  memory: "Chưa có memory nào",
  proposals: "Không có đề xuất nào đang chờ",
} as const;
for (const route of ["docs", "skills", "memory", "proposals"] as const) {
  test(`${route}: empty and recoverable load error`, async ({ page }) => {
    let broken = true;
    await setup(page, {
      overrides: {
        [`${route === "memory" ? "memory" : route}/list`]: () =>
          broken ? fail("FORBIDDEN", 403, "Không có quyền đọc.") : ok([]),
      },
    });
    await page.goto(`/knowledge/${route}`);
    await expect(page.getByRole("alert")).toContainText("Không có quyền đọc.");
    broken = false;
    await page.getByRole("button", { name: "Tải lại", exact: true }).click();
    await expect(page.getByRole("heading", { name: EMPTY_TITLE[route], exact: true })).toBeVisible();
  });
  for (const scheme of ["light", "dark"] as const) {
    test(`${route}: ${scheme}, English, 360px without page overflow`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 360, height: 800 });
      await page.addInitScript(() => localStorage.setItem("hive.lang", "en"));
      await setup(page);
      await page.goto(`/knowledge/${route}`);
      // Trang Skills có thêm bảng skill mặc định của Hive bên dưới.
      if (route === "docs") await expect(page.getByRole("list", { name: "Cây tài liệu theo repo" })).toBeVisible();
      else await expect(page.getByRole("table").first()).toBeVisible();
      await expect(page.locator("main").last()).toContainText(
        route === "docs"
          ? "Versioned markdown docs"
          : route === "skills"
            ? "No Git repository connected"
            : route === "memory"
              ? "Short notes"
              : "team admins decide",
      );
      await page
        .getByRole("button", { name: route === "docs" ? /Mở dòng/ : /Open row/ })
        .first()
        .click();
      // Đề xuất, skill và memory mở trang riêng (Decision 2); tài liệu mở khối chi tiết cạnh danh sách.
      if (route !== "docs") await expect(page).toHaveURL(new RegExp(`/knowledge/${route}/[^/?]+$`));
      if (route === "docs" || route === "skills") await expect(page.locator("article").first()).toBeVisible();
      if (route === "proposals") await expect(page.getByRole("region", { name: "Content changes" })).toBeVisible();
      if (route === "memory") await expect(page.locator("main").last()).toContainText(memory.content);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${route}-${scheme}.png`), fullPage: true });
    });
  }
}
