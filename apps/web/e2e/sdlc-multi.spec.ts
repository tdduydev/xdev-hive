import { expect, type Page, test } from "@playwright/test";
import {
  type AgentPolicy,
  type AgentPolicyInput,
  DEFAULT_AGENT_POLICY,
  DEFAULT_ORG_SDLC_POLICY,
  type OrgSdlcPolicy,
  type ProjectSettings,
  type SdlcMetrics,
} from "@xdev-hive/contracts";
import { fail, ok } from "./fake-hub.ts";
import { inOrg } from "./reviews-fixture.ts";
import { MOBILE, PAYMENT, sdlcFixture, WEB } from "./sdlc-fixture.ts";

/*
 * AI SDLC nhiều dự án và tự duyệt (specs/011 T054): hạng mục ba dự án (SC-016), thu hồi tự duyệt, mục AI SDLC và Tự duyệt
 * AI trong cài đặt dự án, mục AI SDLC trong chính sách tổ chức.
 */

function policyOf(sdlc: OrgSdlcPolicy = DEFAULT_ORG_SDLC_POLICY): AgentPolicy {
  return {
    ...DEFAULT_AGENT_POLICY,
    sdlc,
    updatedAt: null,
    updatedBy: null,
    templateSync: null,
    defaultTemplates: { agents: "", claude: "", mcp: "" },
  } as AgentPolicy;
}

// Hub chỉ trả tỉ lệ theo chế độ/dự án; mục chính sách chọn dòng cao nhất của cả chế độ.
const metricsOf = (): SdlcMetrics => ({
  from: "2026-09-14T03:42:00.000Z",
  to: "2026-10-14T03:42:00.000Z",
  items: 9,
  leadTimeHours: [],
  gateWaitHours: { p50: null, p90: null, count: 0 },
  returnRate: null,
  questionsPerItem: null,
  coverage: null,
  convergeRounds: null,
  codeReviewRoundsPerPr: null,
  costUsdPerItem: null,
  autoApproval: [
    { modeRef: "speckit", projectKey: null, autoRate: 0.4, revokeRate: 0.05 },
    { modeRef: "bugfix", projectKey: null, autoRate: 0.25, revokeRate: 0.125 },
    { modeRef: "speckit", projectKey: PAYMENT.key, autoRate: 0.9, revokeRate: 0.5 },
  ],
});

async function setup(page: Page, opts: { orgPolicy?: AgentPolicy; metrics?: null } = {}) {
  const sdlc = sdlcFixture({ participants: [WEB, MOBILE] });
  // Hub giả giữ bản đã lưu như hub thật: lưu mục sau ghép lên bản của lần trước.
  let settings: ProjectSettings = PAYMENT.settings;
  let policy = opts.orgPolicy ?? policyOf();
  const hub = await inOrg(page, "admin", {
    ...sdlc.rpc,
    "projects/get": () => ok({ ...PAYMENT, settings }),
    "projects/updateSettings": (input) => {
      settings = { ...settings, ...(input as { settings: Partial<ProjectSettings> }).settings };
      return ok(settings);
    },
    "policies/get": () => ok(policy),
    "sdlc/metrics": () => (opts.metrics === null ? fail("FORBIDDEN", 403, "Không có quyền.") : ok(metricsOf())),
    "policies/update": (input) => {
      policy = { ...policy, ...(input as AgentPolicyInput) } as AgentPolicy;
      return ok(policy);
    },
  });
  const settingsSaves = () =>
    hub.rpcCalls
      .filter((c) => c.path === "projects/updateSettings")
      .map((c) => c.input as { key: string; settings: Partial<ProjectSettings> });
  const policySaves = () =>
    hub.rpcCalls.filter((c) => c.path === "policies/update").map((c) => c.input as AgentPolicyInput);
  return { ...sdlc, hub, settingsSaves, policySaves };
}

const group = (page: Page, name: string) => page.getByRole("group", { name, exact: true });

test("hạng mục ba dự án (SC-016): dự án chính và hai dự án tham gia của đội khác", async ({ page }) => {
  await setup(page);
  await page.goto("/sdlc/payment-api/12/projects");
  const table = page.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(4);
  for (const key of ["payment-api", "web-shop", "mobile-app"]) await expect(table).toContainText(key);
  // Chỉ dự án tham gia bỏ được; dự án chính giữ hạng mục.
  await expect(page.getByRole("button", { name: /web-shop$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /mobile-app$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /payment-api$/ })).toHaveCount(0);
});

test("tự duyệt AI hiện điểm và thu hồi được trong hạn, cần lý do", async ({ page }) => {
  const { state } = await setup(page);
  await page.goto("/sdlc/payment-api/12");
  await expect(page.getByText("Tự duyệt bởi AI · 9,3/10").first()).toBeVisible();
  await page.getByRole("button", { name: "Thu hồi tự duyệt" }).first().click();
  const reason = page.getByLabel("Lý do");
  await reason.fill("thiếu");
  const submit = page.getByRole("button", { name: "Thu hồi tự duyệt" }).last();
  await expect(submit).toBeDisabled();
  await reason.fill("thiếu bước rollback");
  await submit.click();
  await expect.poll(() => state.revoked).toEqual([{ id: expect.any(String), reason: "thiếu bước rollback" }]);
  await expect(page.getByText("Đã thu hồi tự duyệt").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Thu hồi tự duyệt" })).toHaveCount(0);
});

test("cài đặt dự án: mục AI SDLC và Tự duyệt AI lưu riêng, mỗi lần gửi cả cấu hình sdlc", async ({ page }) => {
  const { settingsSaves } = await setup(page);
  await page.goto("/projects/payment-api/settings");
  const main = group(page, "AI SDLC");
  await expect(main.getByRole("switch", { name: "Bật AI SDLC cho dự án" })).toBeChecked();
  await expect(main.getByRole("combobox", { name: "Chế độ mặc định" })).toHaveValue("speckit");

  await main.getByRole("textbox", { name: "Mức song song" }).fill("4");
  await main.getByRole("radio", { name: /Máy của người bấm/ }).check();
  await main.getByRole("button", { name: "Lưu" }).click();
  await expect(main.getByRole("status")).toContainText("Đã lưu");
  expect(settingsSaves()).toHaveLength(1);
  expect(Object.keys(settingsSaves()[0]?.settings ?? {})).toEqual(["sdlc"]);
  expect(settingsSaves()[0]?.settings.sdlc).toMatchObject({
    enabled: true,
    defaultMode: "speckit",
    maxParallel: 4,
    runner: "requester",
    autoApprove: { enabled: false },
  });

  const auto = group(page, "Tự duyệt AI");
  await expect(auto).toContainText("Tổ chức cho phép");
  await auto.getByRole("switch", { name: "Bật tự duyệt cho dự án" }).click();
  // Spec Kit là chế độ nặng: Specify luôn cần người, Plan và Tasks theo ngưỡng 9 của chế độ.
  await expect(auto.getByRole("checkbox", { name: "Specify" })).toBeDisabled();
  await expect(auto).toContainText("Chế độ nặng, yêu cầu luôn cần người");
  await expect(auto.getByRole("checkbox", { name: "Plan" })).toBeChecked();
  await expect(auto).toContainText("≥ 9 · 24 giờ");

  // Ô ngoài khoảng báo lỗi tại ô, không gửi lên hub.
  await auto.getByRole("textbox", { name: "Hạn thu hồi" }).fill("200");
  await auto.getByRole("button", { name: "Lưu" }).click();
  await expect(auto.getByRole("alert")).toContainText("Có ô chưa hợp lệ");
  await expect(auto.getByRole("textbox", { name: "Hạn thu hồi" })).toHaveAttribute("aria-invalid", "true");
  expect(settingsSaves()).toHaveLength(1);

  await auto.getByRole("textbox", { name: "Hạn thu hồi" }).fill("48");
  await auto.getByRole("textbox", { name: "Ngưỡng điểm" }).fill("9.5");
  await auto.getByRole("checkbox", { name: "Tasks" }).click();
  await auto.getByRole("textbox", { name: "Thêm từ khoá nhạy cảm" }).fill("chargeback");
  await auto.getByRole("textbox", { name: "Thêm từ khoá nhạy cảm" }).press("Enter");
  await auto.getByRole("textbox", { name: "Đường dẫn nhạy cảm của dự án" }).fill("src/refund/**\n");
  await expect(auto).toContainText("Plan tự duyệt khi review AI đạt ngưỡng");
  await auto.getByRole("button", { name: "Lưu" }).click();
  await expect(auto.getByRole("status")).toContainText("Đã lưu");
  expect(settingsSaves()).toHaveLength(2);
  // Lưu mục Tự duyệt giữ phần AI SDLC đã lưu ở lần trước.
  expect(settingsSaves()[1]?.settings.sdlc).toMatchObject({
    maxParallel: 4,
    runner: "requester",
    autoApprove: {
      enabled: true,
      minScore: 9.5,
      revokeHours: 48,
      phases: ["plan"],
      denyKeywords: ["chargeback"],
      denyPaths: ["src/refund/**"],
    },
  });
});

test("cài đặt dự án: tổ chức tắt tự duyệt thì báo và chỉ tới chính sách agent", async ({ page }) => {
  await setup(page, {
    orgPolicy: policyOf({ autoApprove: { ...DEFAULT_ORG_SDLC_POLICY.autoApprove, allowed: false } }),
  });
  await page.goto("/projects/payment-api/settings");
  const auto = group(page, "Tự duyệt AI");
  await expect(auto).toContainText("Tổ chức đã tắt");
  await expect(auto.getByRole("status")).toContainText("Tổ chức đã tắt tự duyệt");
  await auto.getByRole("link", { name: "Chính sách agent" }).click();
  await expect(page).toHaveURL(/\/admin\/policies#sdlc$/);
});

test("chính sách tổ chức: mục AI SDLC lưu riêng; lưu mục khác không gửi sdlc", async ({ page }) => {
  const { policySaves } = await setup(page);
  await page.goto("/admin/policies");
  const sdlc = group(page, "AI SDLC");
  await expect(sdlc).toContainText("Đang cho phép");
  await expect(sdlc).toContainText("Contract liên repo");

  await sdlc.getByRole("textbox", { name: "Sàn ngưỡng điểm" }).fill("11");
  await expect(sdlc).toContainText("Nhập số từ 0 đến 10");
  await sdlc.getByRole("textbox", { name: "Sàn ngưỡng điểm" }).fill("8.5");
  await sdlc.getByRole("switch", { name: "Cho phép tự duyệt" }).click();
  await expect(sdlc).toContainText("Đã tắt tự duyệt cho toàn tổ chức.");
  await sdlc.getByRole("button", { name: "Lưu" }).click();
  await expect(sdlc.getByRole("status").last()).toContainText("Đã lưu");
  expect(policySaves()[0]?.sdlc?.autoApprove).toMatchObject({ allowed: false, minScoreFloor: 8.5 });

  const limits = group(page, "Giới hạn chung");
  await limits.getByRole("spinbutton", { name: "Trần mỗi run" }).fill("5");
  await limits.getByRole("button", { name: "Lưu" }).click();
  await expect.poll(() => policySaves().length).toBe(2);
  expect(policySaves()[1]).not.toHaveProperty("sdlc");
});

test("chính sách tổ chức: hàng số liệu tự duyệt 30 ngày; không đọc được chỉ số thì ẩn hàng", async ({ page }) => {
  await setup(page);
  await page.goto("/admin/policies");
  const stats = group(page, "AI SDLC").getByRole("region", { name: "Số liệu tự duyệt AI SDLC" });
  // Dòng theo dự án (90%) không tính: so các chế độ với nhau mới có nghĩa với quản trị tổ chức.
  await expect(stats).toContainText("Tỉ lệ tự duyệt cao nhất40%Spec Kit · 30 ngày qua");
  await expect(stats).toContainText("Tỉ lệ thu hồi cao nhất12,5%Sửa lỗi · 30 ngày qua");
  await expect(stats).toContainText("Dự án bật tự duyệt0trên 2 dự án bật AI SDLC");
  await group(page, "AI SDLC").getByRole("link", { name: "Xem chỉ số theo chế độ và dự án" }).click();
  await expect(page).toHaveURL(/\/sdlc\/metrics$/);
});

test("chính sách tổ chức: hub từ chối chỉ số thì form AI SDLC vẫn dùng được", async ({ page }) => {
  await setup(page, { metrics: null });
  await page.goto("/admin/policies");
  const sdlc = group(page, "AI SDLC");
  await expect(sdlc.getByRole("switch", { name: "Cho phép tự duyệt" })).toBeVisible();
  await expect(sdlc.getByRole("region", { name: "Số liệu tự duyệt AI SDLC" })).toHaveCount(0);
});

test("cài đặt AI SDLC ở 360 px, giao diện tối: không tràn ngang", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await setup(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/projects/payment-api/settings");
  const auto = group(page, "Tự duyệt AI");
  await auto.getByRole("switch", { name: "Bật tự duyệt cho dự án" }).click();
  await expect(auto.getByRole("checkbox", { name: "Plan" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
    .toBeLessThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath("sdlc-project-settings-360-dark.png"), fullPage: true });
  await page.goto("/admin/policies");
  await expect(group(page, "AI SDLC")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
    .toBeLessThanOrEqual(0);
});
