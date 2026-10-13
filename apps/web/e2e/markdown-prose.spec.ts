import { expect, test } from "@playwright/test";
import { fakeHub, ok, USER } from "./fake-hub.ts";

const at = "2026-10-14T03:00:00.000Z";
const orgId = "0a0a0a0a-0000-4000-8000-000000000001";
const teamId = "0a0a0a0a-0000-4000-8000-000000000002";
const projectId = "0a0a0a0a-0000-4000-8000-000000000003";
const key = "project/hive/kien-truc";

const CONTENT = [
  "# Kiến trúc kênh worker",
  "",
  "Worker giữ một **WebSocket** tới hub, thử lại với `backoff` tăng dần. Xem [thiết kế](https://example.com).",
  "",
  "- [x] Kênh WebSocket",
  "- [ ] Proxy công ty",
  "",
  "> Mọi truy vấn của tổ chức đi qua `withTenant()`.",
  "",
  "| Thành phần | Ngôn ngữ | Ghi chú |",
  "| --- | --- | --- |",
  "| Hub | TypeScript | Hono + oRPC |",
  "| Worker | Go | Module riêng |",
  "| Web | React | Vite |",
  "",
  "```ts",
  "export async function connect(url: string): Promise<WebSocket> {",
  "  // Thử lại tăng dần để không dồn tải lên hub.",
  "  const delay = Math.min(30_000, 2 ** attempt * 500);",
  "  return new WebSocket(url);",
  "}",
  "```",
  "",
  "```mermaid",
  "flowchart LR",
  "  W[Worker] -->|WebSocket| H[Hub]",
  "  H --> D[(Postgres)]",
  "```",
  "",
  "```mermaid",
  "flowchart LR",
  "  A -->",
  "```",
  "",
].join("\n");

async function open(page: import("@playwright/test").Page, scheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: scheme });
  await page.addInitScript((s) => {
    document.documentElement.classList.toggle("dark", s === "dark");
  }, scheme);
  await fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () =>
        ok({
          orgs: [{ id: orgId, slug: "acme", name: "Acme", role: "member", emailDomain: null, createdAt: at }],
          canCreateOrg: false,
        }),
      "orgMembers/list": () => ok([]),
      "teams/list": () => ok([]),
      "projects/list": () => ok([{ id: projectId, teamId, name: "Hive", key: "hive", createdAt: at }]),
      "notifications/unreadCount": () => ok({ count: 0 }),
      "docs/list": () =>
        ok([
          {
            id: "0a0a0a0a-0000-4000-8000-000000000004",
            key,
            title: "Kiến trúc kênh worker",
            scope: { level: "project", teamId, projectId },
            version: 1,
            updatedAt: at,
            updatedBy: { userId: USER.id, runId: null },
          },
        ]),
      "docs/get": () =>
        ok({
          id: "0a0a0a0a-0000-4000-8000-000000000004",
          key,
          title: "Kiến trúc kênh worker",
          scope: { level: "project", teamId, projectId },
          version: 1,
          updatedAt: at,
          updatedBy: { userId: USER.id, runId: null },
          content: CONTENT,
        }),
    },
  });
  await page.goto("/knowledge/docs");
  await page.getByRole("button", { name: "Mở dòng Kiến trúc kênh worker" }).click();
}

for (const scheme of ["light", "dark"] as const) {
  test(`markdown view: code highlight, table and mermaid look right (${scheme})`, async ({ page }, testInfo) => {
    await open(page, scheme);
    const prose = page.locator(".hive-prose").first();
    await expect(prose.locator("table")).toBeVisible();
    // Khối code có tô màu cú pháp: ít nhất hai màu chữ khác nhau trong cùng một khối.
    const code = prose.locator("pre code").first();
    await expect(code.locator("span[class*='hljs']").first()).toBeVisible();
    const colors = await code
      .locator("span[class*='hljs']")
      .evaluateAll((els) => new Set(els.map((e) => getComputedStyle(e).color)).size);
    expect(colors).toBeGreaterThan(1);
    // Sơ đồ hợp lệ thành SVG; sơ đồ lỗi hiện thông báo kèm mã nguồn.
    await expect(prose.locator("svg").first()).toBeVisible({ timeout: 15_000 });
    await expect(prose.getByRole("alert")).toContainText("Sơ đồ");
    await page.screenshot({ path: testInfo.outputPath(`markdown-${scheme}.png`), fullPage: true });
  });
}
