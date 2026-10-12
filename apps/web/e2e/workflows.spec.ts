import { expect, type Page, test } from "@playwright/test";
import { inOrg, PRD_WORKFLOW_ID, type Role, TEAM_ID, workflowsFixture } from "./reviews-fixture.ts";

async function setup(page: Page, role: Role = "admin", mine?: string[]) {
  const fixture = workflowsFixture();
  const hub = await inOrg(page, role, fixture.rpc, mine);
  return { ...fixture, hub };
}

const config = (page: Page) => page.getByRole("complementary", { name: "Cấu hình checkpoint" });
const gateCard = (page: Page, name: RegExp) =>
  page.getByRole("region", { name: "Các checkpoint" }).getByRole("button", { name });

test("tạo quy trình từ khung Spec Kit, sửa checkpoint rồi áp dụng đúng dữ liệu", async ({ page }) => {
  const { state } = await setup(page);
  await page.goto("/knowledge/workflows");
  await expect(page.getByRole("heading", { name: "Quy trình duyệt", level: 1 })).toBeVisible();
  // Quy trình đang có hiện như thiết kế: giai đoạn AI-DLC, gate điều kiện có dòng ⤷.
  await expect(gateCard(page, /Pháp chế/)).toContainText("⤷ khi có phí, hoàn tiền, fee, refund");
  await expect(gateCard(page, /Product owner duyệt/)).toContainText("Quản trị đội · 1 người");
  await expect(page.getByText("2 phiên duyệt đang chạy theo quy trình này")).toBeVisible();

  await page.getByRole("button", { name: "Quy trình mới" }).click();
  await page.getByRole("button", { name: "Spec Kit" }).click();
  await expect(page.getByRole("button", { name: "Spec Kit" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("textbox", { name: "Tên quy trình" }).fill("Spec tính năng");
  await page.getByRole("combobox", { name: "Đội sở hữu" }).selectOption({ label: "Thanh toán" });
  await page.getByRole("textbox", { name: "Thêm tiền tố tài liệu" }).fill("project/payment-api/specs/");
  await page.keyboard.press("Enter");
  // Mô tả giai đoạn sửa được; giai đoạn chưa có mô tả thì gợi ý mô tả mặc định của khung mẫu.
  await page.getByRole("textbox", { name: "Mô tả giai đoạn 1" }).fill("Mô tả tính năng và user story");
  await expect(page.getByRole("textbox", { name: "Mô tả giai đoạn 2" })).toHaveAttribute(
    "placeholder",
    "Kỹ thuật, ràng buộc constitution",
  );

  // Gate người duyệt: đổi tên, thêm người, mọi người phải duyệt, điều kiện, SLA, trả lại cho agent, tạo việc kế.
  await gateCard(page, /Duyệt plan/).click();
  const panel = config(page);
  await panel.getByRole("textbox", { name: "Tên checkpoint" }).fill("Kiến trúc sư duyệt plan");
  await panel.getByRole("combobox", { name: "Thêm người duyệt" }).selectOption({ label: "Phạm Hà" });
  await expect(panel.getByText("Phạm Hà")).toBeVisible();
  await panel.getByRole("combobox", { name: "Thêm người duyệt" }).selectOption({ label: "Thanh toán" });
  await expect(panel.getByText("Đội: Thanh toán")).toBeVisible();
  await panel.getByRole("combobox", { name: "Cách duyệt" }).selectOption({ label: "Tất cả phải duyệt" });
  await panel.getByRole("button", { name: "+ Điều kiện" }).click();
  await panel.getByRole("textbox", { name: "Có một trong các từ khoá" }).fill("phí, hoàn tiền");
  await panel.getByRole("checkbox", { name: /Bỏ qua khi chỉ sửa chính tả/ }).check();
  await panel.getByRole("combobox", { name: "SLA" }).selectOption("48");
  await panel.getByRole("combobox", { name: "Khi bị trả lại" }).selectOption({ label: "Agent sửa theo góp ý" });
  await panel.getByRole("combobox", { name: "Khi đạt" }).selectOption({ label: "Tạo việc cho agent bước sau" });
  await panel.getByRole("textbox", { name: "Tiêu đề việc cho bước sau" }).fill("Viết tasks.md cho {title}");
  await expect(gateCard(page, /Kiến trúc sư duyệt plan/)).toContainText(
    "Quản trị đội, Đội Thanh toán, Phạm Hà · tất cả",
  );

  // Gate AI: chọn model và điểm đạt.
  await gateCard(page, /AI đối chiếu constitution/).click();
  await expect(panel.getByText("Bỏ trống là model review của dự án.", { exact: false })).toBeVisible();
  await panel.getByRole("combobox", { name: "Model kiểm" }).fill("gpt-5-codex");
  await panel.getByRole("spinbutton", { name: "Điểm đạt" }).fill("8");
  await expect(gateCard(page, /AI đối chiếu constitution/)).toContainText("gpt-5-codex · 2 mục kiểm · đạt từ 8/10");

  // Gate quy tắc thêm kiểm secret.
  await gateCard(page, /Mọi yêu cầu có tiêu chí/).click();
  await panel.getByRole("checkbox", { name: "Không có secret, token, mật khẩu" }).check();

  // Thêm checkpoint (mặc định người duyệt) vào giai đoạn Tasks, đổi thành cổng CI rồi dời lên trước gate truy vết:
  // cấu hình người duyệt không gửi đi nữa.
  await page.getByRole("button", { name: "+ Thêm checkpoint" }).nth(2).click();
  await expect(panel.getByRole("textbox", { name: "Tên checkpoint" })).toHaveValue("Checkpoint mới");
  await panel.getByRole("radio", { name: "Cổng CI" }).check();
  await panel.getByRole("button", { name: "Dời checkpoint lên" }).click();

  await expect(page.getByText("Có thay đổi chưa áp dụng.")).toBeVisible();
  await page.getByRole("button", { name: "Áp dụng quy trình" }).click();
  await expect(page.getByText("Đã áp dụng quy trình.")).toBeVisible();

  const saved = state.saved.at(-1);
  expect(saved).toMatchObject({
    name: "Spec tính năng",
    preset: "speckit",
    teamId: TEAM_ID,
    docPrefixes: ["project/payment-api/specs/"],
    enabled: true,
  });
  expect(saved?.id).toBeUndefined();
  expect(saved?.phases.map((p) => p.gates.map((g) => g.id))).toEqual([
    ["po"],
    ["ai-plan", "design"],
    ["checkpoint-moi", "trace"],
  ]);
  expect(saved?.phases.map((p) => p.description)).toEqual(["Mô tả tính năng và user story", undefined, undefined]);
  const [ai, human] = saved?.phases[1]?.gates ?? [];
  expect(ai?.ai).toEqual({
    checks: ["Plan tuân theo các nguyên tắc trong constitution", "Không có ràng buộc mâu thuẫn"],
    passScore: 8,
    model: "gpt-5-codex",
  });
  expect(human).toEqual({
    id: "design",
    name: "Kiến trúc sư duyệt plan",
    kind: "human",
    reviewers: { users: ["u-ha"], roles: ["team-admin"], teams: [TEAM_ID], quorum: 0 },
    conditions: { docTypes: [], keywords: ["phí", "hoàn tiền"], minChangedLines: null, skipFormattingOnly: true },
    slaHours: 48,
    onReject: "agent",
    onPass: "task",
    nextTaskTitle: "Viết tasks.md cho {title}",
  });
  const [ci, trace] = saved?.phases[2]?.gates ?? [];
  expect(ci).toMatchObject({ kind: "ext", ext: { check: "ci" } });
  expect(ci?.reviewers).toBeUndefined();
  expect(trace).toMatchObject({ kind: "rule", rules: ["requirements", "no-secrets"] });
  // Quy trình mới có mã của hub và nằm trong danh sách chọn.
  await expect(page.getByRole("combobox", { name: "Quy trình" })).toHaveValue(/^3c3c3c3c-.*2$/);
  await expect(page.getByText("Có thay đổi chưa áp dụng.")).toHaveCount(0);
});

test("lỗi của quy trình hiện trước khi gửi; lỗi của hub hiện nguyên văn", async ({ page }) => {
  const { state } = await setup(page);
  await page.goto("/knowledge/workflows");
  await gateCard(page, /Product owner duyệt/).click();
  await config(page).getByRole("button", { name: "Bỏ Vai trò: Quản trị đội" }).click();
  await expect(gateCard(page, /Product owner duyệt/)).toContainText("Chưa chọn người duyệt");
  await page.getByRole("button", { name: "Áp dụng quy trình" }).click();
  await expect(page.getByRole("alert")).toContainText("Checkpoint “Product owner duyệt” cần người duyệt.");
  expect(state.saved).toHaveLength(0);

  await config(page).getByRole("combobox", { name: "Thêm người duyệt" }).selectOption({ label: "Quản trị đội" });
  await expect(page.getByRole("alert")).toHaveCount(0);
  // Trở lại đúng bản đã lưu thì không còn gì để áp dụng.
  await expect(page.getByRole("button", { name: "Áp dụng quy trình" })).toBeDisabled();
  await config(page).getByRole("combobox", { name: "SLA" }).selectOption("8");
  state.saveConflict = "Tiền tố project/payment-api/prd đã thuộc quy trình “PRD v2” của đội.";
  await page.getByRole("button", { name: "Áp dụng quy trình" }).click();
  await expect(page.getByRole("alert")).toContainText("Tiền tố project/payment-api/prd đã thuộc quy trình “PRD v2”");
  expect(state.saved.at(-1)?.id).toBe(PRD_WORKFLOW_ID);
});

test("tắt rồi xoá quy trình", async ({ page }) => {
  const { state } = await setup(page);
  await page.goto("/knowledge/workflows");
  await page.getByRole("switch", { name: "Đang bật" }).click();
  await page.getByRole("button", { name: "Áp dụng quy trình" }).click();
  await expect(page.getByText("Đã áp dụng quy trình.")).toBeVisible();
  expect(state.saved.at(-1)?.enabled).toBe(false);
  await expect(page.getByRole("combobox", { name: "Quy trình" })).toContainText("PRD chuẩn (đang tắt)");

  await page.getByRole("button", { name: "Xoá quy trình" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("2 phiên duyệt đang chạy");
  await dialog.getByRole("button", { name: "Xoá quy trình" }).click();
  await expect(dialog).toBeHidden();
  expect(state.removed).toEqual([PRD_WORKFLOW_ID]);
  // Không còn quy trình: quản trị thấy ngay bản nháp mới theo AI-DLC.
  await expect(page.getByRole("textbox", { name: "Tên quy trình" })).toHaveValue("Quy trình mới");
});

test("chạy thử trên một tài liệu: checkpoint chạy hay bỏ qua, lý do và danh sách quy tắc", async ({ page }) => {
  const { state } = await setup(page);
  await page.goto("/knowledge/workflows");
  await page.getByRole("button", { name: "Chạy thử trên 1 tài liệu" }).click();
  const dialog = page.getByRole("dialog", { name: "Chạy thử trên 1 tài liệu" });
  await dialog.getByRole("textbox", { name: "Key tài liệu" }).fill("project/payment-api/prd");
  await dialog.getByRole("button", { name: "Chạy thử" }).click();
  const gates = dialog.getByRole("list", { name: "Checkpoint với tài liệu này" });
  await expect(gates.getByRole("listitem").filter({ hasText: "Pháp chế" })).toContainText(
    "Bỏ quaKhông có từ khoá phí, hoàn tiền, fee, refund.",
  );
  const trace = gates.getByRole("listitem").filter({ hasText: "Truy vết R-n → tiêu chí" }).first();
  await expect(trace).toContainText("Chạy");
  await expect(trace).toContainText("✓ R-1 có tiêu chí chấp nhận");
  await expect(trace).toContainText("✗ R-3 có tiêu chí chấp nhận");
  await expect(trace).toContainText("Mục 3 chưa nhắc R-3.");
  expect(state.dryRuns.at(-1)).toMatchObject({ docKey: "project/payment-api/prd", workflow: { id: PRD_WORKFLOW_ID } });
  expect(state.saved).toHaveLength(0);
});

test("thành viên không có quyền chỉ xem quy trình", async ({ page }) => {
  await setup(page, "member");
  await page.goto("/knowledge/workflows");
  await expect(page.getByRole("alert")).toContainText("Bạn chỉ xem được quy trình duyệt.");
  await expect(page.getByRole("button", { name: "Áp dụng quy trình" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Quy trình mới" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "+ Thêm checkpoint" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Xoá quy trình" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Tên quy trình" })).toBeDisabled();
  await expect(page.getByText("Ý định → yêu cầu, story")).toBeVisible();
  await gateCard(page, /Pháp chế/).click();
  await expect(config(page).getByRole("textbox", { name: "Tên checkpoint" })).toHaveValue("Pháp chế");
  await expect(config(page).getByRole("radio", { name: "Người duyệt" })).toBeDisabled();
  await expect(config(page).getByRole("combobox", { name: "Thêm người duyệt" })).toHaveCount(0);
  // Chạy thử vẫn dùng được: không đổi gì trên hub.
  await expect(page.getByRole("button", { name: "Chạy thử trên 1 tài liệu" })).toBeEnabled();
});

test("thành viên có quyền sửa quy trình duyệt qua vai trò tự tạo thì sửa được", async ({ page }) => {
  await setup(page, "member", ["docs.read", "workflows.write"]);
  await page.goto("/knowledge/workflows");
  await expect(page.getByRole("button", { name: "Áp dụng quy trình" })).toBeVisible();
  await expect(page.getByText("Bạn chỉ xem được quy trình duyệt.")).toHaveCount(0);
});

test("English: labels, kinds and the config panel follow the language", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hive.lang", "en"));
  await setup(page);
  await page.goto("/knowledge/workflows");
  await expect(page.getByRole("heading", { name: "Review workflows", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish workflow" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dry-run on a doc" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Phase 1 description" })).toHaveAttribute(
    "placeholder",
    "Intent → requirements, stories",
  );
  await page
    .getByRole("region", { name: "Checkpoints" })
    .getByRole("button", { name: /AI kiểm đủ mục PRD/ })
    .click();
  const panel = page.getByRole("complementary", { name: "Checkpoint settings" });
  await expect(panel.getByRole("radio", { name: "AI check" })).toBeChecked();
  await expect(panel.getByText("What the AI checks")).toBeVisible();
  await expect(panel.getByRole("combobox", { name: "Checking model" })).toHaveValue("");
  await expect(panel.getByRole("combobox", { name: "On pass" })).toHaveValue("next");
  await page.setViewportSize({ width: 360, height: 800 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const scheme of ["light", "dark"] as const) {
  test(`ảnh màn quy trình 1440×1000, ${scheme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: scheme });
    await setup(page);
    await page.goto("/knowledge/workflows");
    await gateCard(page, /Product owner duyệt/).click();
    await expect(config(page).getByRole("textbox", { name: "Tên checkpoint" })).toHaveValue("Product owner duyệt");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`workflows-${scheme}.png`), fullPage: true });
  });
}
