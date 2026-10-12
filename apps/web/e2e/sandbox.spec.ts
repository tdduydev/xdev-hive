import { expect, type Page, test } from "@playwright/test";
import { fakeHub, ok, type RpcHandler } from "./fake-hub.ts";

const ORG_ID = "0a0a0a0a-0000-4000-8000-00000000000a";
const TEAM_ID = "7e7e7e7e-0000-4000-8000-000000000001";
const PROJECT = {
  id: "9a9a9a9a-0000-4000-8000-000000000001",
  systemId: "5e5e5e5e-0000-4000-8000-000000000001",
  teamId: TEAM_ID,
  key: "PAY",
  name: "payment-api",
  state: "active",
  repo: {
    mode: "existing",
    connectionId: "c0c0c0c0-0000-4000-8000-000000000001",
    kind: "github",
    owner: "acme",
    name: "payment-api",
    defaultBranch: "main",
    visibility: "private",
    httpUrl: null,
    sshUrl: null,
    webUrl: null,
  },
  settings: {
    merge: { mode: "review", requiredApprovals: 1 },
    outcome: { default: [], byType: {} },
    features: { planMode: false, crossReview: false, mergeQueue: false, leaderChat: false, sandbox: false },
    issueIntake: { enabled: false, label: "hive", mention: "hive" },
    budget: {},
  },
  createdBy: "u1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const entry = (n: number, rule: string, projectId: string | null = null) => ({
  id: `3e3e3e3e-0000-4000-8000-00000000000${n}`,
  projectId,
  rule,
  note: null,
  addedBy: "u1",
  createdAt: "2026-10-12T01:00:00.000Z",
});
const HASH = "a".repeat(64);

async function open(page: Page, rpc: Record<string, RpcHandler> = {}) {
  await page.addInitScript((id) => localStorage.setItem("hive.org", id), ORG_ID);
  return fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () =>
        ok({
          orgs: [
            { id: ORG_ID, slug: "acme", name: "Acme", role: "admin", emailDomain: null, createdAt: PROJECT.createdAt },
          ],
          canCreateOrg: false,
        }),
      "projects/list": () => ok([PROJECT]),
      "orgMembers/list": () => ok([]),
      "sandbox/getOrgSettings": () => ok({ locked: false, useSuggestedDefaults: false }),
      "sandbox/listAllowlist": () => ok([entry(1, "registry.npmjs.org:443")]),
      "sandbox/effectiveAllowlist": () =>
        ok({ locked: false, useSuggestedDefaults: false, rules: ["registry.npmjs.org:443"], suggestedRules: [] }),
      "sandbox/getImage": () => ok(null),
      ...rpc,
    },
  });
}

test("sandbox tổ chức: bật danh sách đề xuất, thêm mục hợp lệ, từ chối mục sai, xoá mục", async ({ page }) => {
  const hub = await open(page, {
    "sandbox/updateOrgSettings": (input) => ok(input),
    "sandbox/addAllowlist": (input) => ok(entry(2, (input as { rule: string }).rule)),
    "sandbox/removeAllowlist": () => ok({ removed: true }),
  });
  await page.goto("/admin/sandbox");
  await page.getByLabel(/Dùng danh sách đề xuất/).check();
  await expect
    .poll(() => hub.rpcCalls.find((c) => c.path === "sandbox/updateOrgSettings")?.input)
    .toEqual({
      locked: false,
      useSuggestedDefaults: true,
    });

  await page.getByLabel("Mục mạng", { exact: true }).fill("không phải tên miền");
  await page.getByRole("button", { name: "Thêm", exact: true }).click();
  await expect(page.getByText(/Mục mạng phải là tên miền/)).toBeVisible();
  expect(hub.rpcCalls.some((c) => c.path === "sandbox/addAllowlist")).toBe(false);

  await page.getByLabel("Mục mạng", { exact: true }).fill("api.anthropic.com:443");
  await page.getByLabel("Ghi chú").fill("Claude");
  await page.getByRole("button", { name: "Thêm", exact: true }).click();
  await expect
    .poll(() => hub.rpcCalls.find((c) => c.path === "sandbox/addAllowlist")?.input)
    .toEqual({
      rule: "api.anthropic.com:443",
      note: "Claude",
    });

  await page.getByRole("button", { name: "Xoá registry.npmjs.org:443" }).click();
  await expect
    .poll(() => hub.rpcCalls.find((c) => c.path === "sandbox/removeAllowlist")?.input)
    .toEqual({
      entryId: entry(1, "").id,
    });
});

test("sandbox dự án: allowlist hiệu lực, khoá của tổ chức chặn thêm mục, lưu image môi trường", async ({ page }) => {
  const hub = await open(page, {
    "sandbox/effectiveAllowlist": () =>
      ok({
        locked: true,
        useSuggestedDefaults: true,
        rules: ["api.openai.com:443", "registry.npmjs.org:443"],
        suggestedRules: [],
      }),
    "sandbox/listAllowlist": () => ok([]),
    "sandbox/setImage": (input) => ok({ ...(input as object), updatedAt: "2026-10-12T01:00:00.000Z" }),
  });
  await page.goto("/projects/PAY/sandbox");
  await expect(page.getByText("Dự án chưa bật sandbox")).toBeVisible();
  const effective = page.getByRole("list", { name: "Allowlist hiệu lực" });
  await expect(effective).toContainText("api.openai.com:443");
  await expect(page.getByText("Tổ chức đã khoá allowlist")).toBeVisible();
  await expect(page.getByLabel("Mục mạng", { exact: true })).toHaveCount(0);

  await page.getByLabel("Image gốc").fill("node:24-bookworm-slim");
  await page.getByLabel("SHA-256 của .hive/setup.sh").fill("abc");
  await page.getByRole("button", { name: "Lưu image" }).click();
  await expect(page.getByText(/Hash script phải là SHA-256/)).toBeVisible();
  await page.getByLabel("SHA-256 của .hive/setup.sh").fill(HASH.toUpperCase());
  await page.getByRole("button", { name: "Lưu image" }).click();
  await expect(page.getByRole("status")).toHaveText("Đã lưu image môi trường.");
  expect(hub.rpcCalls.find((c) => c.path === "sandbox/setImage")?.input).toEqual({
    projectId: PROJECT.id,
    baseImage: "node:24-bookworm-slim",
    setupScriptHash: HASH,
  });
});

test("cấu hình dự án: bật sandbox gửi đúng bản vá và có link tới trang sandbox", async ({ page }) => {
  const hub = await open(page, {
    "projects/get": () => ok(PROJECT),
    "projects/updateSettings": (input) => ok({ ...PROJECT.settings, ...(input as { settings: object }).settings }),
  });
  await page.goto("/projects/PAY/settings");
  await page.getByRole("switch", { name: "Sandbox" }).click();
  await page.getByRole("button", { name: "Lưu cấu hình" }).click();
  await expect
    .poll(() => hub.rpcCalls.find((c) => c.path === "projects/updateSettings")?.input)
    .toMatchObject({
      key: "PAY",
      settings: { features: { sandbox: true } },
    });
  await page.getByRole("link", { name: "Allowlist mạng và image môi trường của dự án" }).click();
  await expect(page).toHaveURL("/projects/PAY/sandbox");
});
