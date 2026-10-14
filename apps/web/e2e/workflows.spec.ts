import { expect, type Page, test } from "@playwright/test";
import { CODE_WORKFLOW_ID, codeWorkflowsFixture, fail, PAYMENT_PROJECT_ID } from "./fake-hub.ts";
import { inOrg, PRD_WORKFLOW_ID, type Role, TEAM_ID, workflowsFixture } from "./reviews-fixture.ts";

async function setup(page: Page, role: Role = "admin", mine?: string[]) {
  const fixture = workflowsFixture();
  const hub = await inOrg(page, role, fixture.rpc, mine);
  return { ...fixture, hub };
}

/** Như setup, thêm quy trình Code "Code payment-api" và các route của hub cho quy trình code. */
async function setupCode(page: Page, role: Role = "admin", mine?: string[]) {
  const fixture = workflowsFixture();
  const code = codeWorkflowsFixture(fixture.state);
  const hub = await inOrg(page, role, { ...fixture.rpc, ...code.rpc }, mine);
  return { ...fixture, code, hub };
}

const subjectRadio = (page: Page, name: string) => page.getByRole("radio", { name });
const filterButton = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

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

test("tạo quy trình Code từ khung mẫu: phạm vi, checkpoint và dữ liệu gửi hub", async ({ page }) => {
  const { state } = await setupCode(page);
  await page.goto("/knowledge/workflows");
  await page.getByRole("button", { name: "Quy trình mới" }).click();
  await subjectRadio(page, "Code (PR)").check();
  await expect(page.getByRole("button", { name: "Chặt" })).toBeVisible();
  await page.getByRole("button", { name: "Chặt" }).click();
  await page.getByRole("textbox", { name: "Tên quy trình" }).fill("Code reconcile");
  await page.getByRole("combobox", { name: "Đội sở hữu" }).selectOption({ label: "Thanh toán" });
  await page.getByRole("combobox", { name: "thêm dự án" }).selectOption("reconcile");
  await expect(page.getByRole("button", { name: "Bỏ dự án reconcile" })).toBeVisible();
  await page.getByRole("textbox", { name: "Nhánh đích" }).fill("main, release/*");
  await page.getByRole("textbox", { name: "Loại task" }).fill("feature, bug");
  await page.getByRole("spinbutton", { name: "Số lượt agent sửa tối đa" }).fill("1");
  await page.getByRole("button", { name: "Áp dụng quy trình" }).click();
  await expect(page.getByText("Đã áp dụng quy trình.")).toBeVisible();

  const saved = state.saved.at(-1);
  expect(saved).toMatchObject({
    name: "Code reconcile",
    preset: "code-strict",
    subject: "code",
    docPrefixes: [],
    code: { projects: ["reconcile"], baseBranches: ["main", "release/*"], taskTypes: ["feature", "bug"] },
  });
  expect(saved?.code?.maxAgentRevisions).toBe(1);
  expect(saved?.phases.map((p) => p.name)).toEqual(["Kiểm tự động", "Review AI", "CI", "Người duyệt"]);
  expect(saved?.phases[1]?.gates[0]).toMatchObject({
    kind: "ai",
    ai: { reviewers: [{ cli: "claude" }, { cli: "codex" }] },
  });
  // Đã lưu thì loại áp dụng bị khoá: hub từ chối đổi loại.
  await expect(page.getByText("Loại áp dụng cố định sau khi lưu")).toBeVisible();
  await expect(subjectRadio(page, "Tài liệu")).toBeDisabled();
});

test("nhãn và bộ lọc loại: Code và Tài liệu tách nhau", async ({ page }) => {
  await setupCode(page);
  await page.goto("/knowledge/workflows");
  const select = page.getByRole("combobox", { name: "Quy trình" });
  await expect(select).toContainText("PRD chuẩn");
  await expect(select).toContainText("Code payment-api · Code (PR)");

  await filterButton(page, "Code (PR)").click();
  await expect(select).toHaveValue(CODE_WORKFLOW_ID);
  await expect(select).not.toContainText("PRD chuẩn");
  await expect(page.getByRole("textbox", { name: "Tên giai đoạn 1" })).toHaveValue("Kiểm tự động");

  await filterButton(page, "Tài liệu").click();
  await expect(select).toHaveValue(PRD_WORKFLOW_ID);
  await expect(select).not.toContainText("Code payment-api");
});

test("quy tắc sai loại: Code không dùng quy tắc của tài liệu, hiện lỗi và chặn lưu", async ({ page }) => {
  const { state } = await setupCode(page);
  await page.goto("/knowledge/workflows");
  await filterButton(page, "Code (PR)").click();
  await gateCard(page, /Quy tắc tự động/).click();
  const panel = config(page);
  await panel.getByRole("checkbox", { name: /Mỗi R-n có tiêu chí chấp nhận/ }).check();
  await expect(panel.getByRole("alert")).toContainText("Quy tắc này chỉ dùng cho tài liệu.");
  await page.getByRole("button", { name: "Áp dụng quy trình" }).click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  expect(state.saved).toHaveLength(0);

  await panel.getByRole("checkbox", { name: /Mỗi R-n có tiêu chí chấp nhận/ }).uncheck();
  await expect(panel.getByRole("alert")).toHaveCount(0);
});

test("chạy thử trên một PR: chọn run gần đây, khớp phạm vi, checkpoint chạy hay bỏ qua", async ({ page }) => {
  const { state, code } = await setupCode(page);
  await page.goto("/knowledge/workflows");
  await filterButton(page, "Code (PR)").click();
  await page.getByRole("button", { name: "Chạy thử trên 1 PR" }).click();
  const dialog = page.getByRole("dialog", { name: "Chạy thử trên 1 PR" });
  await expect(dialog.getByRole("combobox", { name: "Dự án" })).toHaveValue(PAYMENT_PROJECT_ID);
  const runs = dialog.getByRole("combobox", { name: "Run để thử" });
  // Run mới nhất có PR đứng đầu; run chưa mở PR không chạy thử được nên không có trong danh sách.
  await expect(runs.getByRole("option")).toHaveCount(2);
  await expect(runs).toContainText("PAY-2 · #128 · 7ff9637");
  await expect(runs).toContainText("PAY-1 · #121 · 0c4e2ab");
  await dialog.getByRole("button", { name: "Chạy thử", exact: true }).click();
  await expect(dialog.getByText("Khớp phạm vi")).toBeVisible();
  await expect(dialog.getByText("Quy trình được chọn:")).toContainText("Code payment-api");
  await expect(dialog.getByText("Quy trình bị lấn:")).toContainText("Code mặc định của tổ chức");
  const gates = dialog.getByRole("list", { name: "Checkpoint với tài liệu này" });
  await expect(gates.getByRole("listitem").first()).toContainText("Chạy");
  expect(code.calls.dryRuns.at(-1)).toMatchObject({ runId: "6e6e6e6e-0000-4000-8000-000000000102" });
  expect(state.saved).toHaveLength(0);
});

test("tạo từ cấu hình dự án: bản nháp chưa lưu cho tới khi áp dụng", async ({ page }) => {
  const { state, code } = await setupCode(page);
  await page.goto("/knowledge/workflows");
  await filterButton(page, "Code (PR)").click();
  await page.getByRole("button", { name: "Tạo từ cấu hình dự án" }).click();
  const dialog = page.getByRole("dialog", { name: "Tạo từ cấu hình dự án" });
  await dialog.getByRole("combobox", { name: "Dự án" }).selectOption({ label: "reconcile · Reconcile" });
  await dialog.getByRole("button", { name: "Tạo bản nháp" }).click();
  await expect(dialog).toBeHidden();
  expect(code.calls.fromProject).toEqual(["reconcile"]);
  expect(state.saved).toHaveLength(0);
  await expect(page.getByText("Có thay đổi chưa áp dụng.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Áp dụng quy trình" })).toBeEnabled();
  await page.getByRole("button", { name: "Áp dụng quy trình" }).click();
  await expect(page.getByText("Đã áp dụng quy trình.")).toBeVisible();
  expect(state.saved.at(-1)).toMatchObject({ subject: "code", code: { projects: ["reconcile"] } });
});

test("?duan= dựng bản nháp từ đúng dự án nguồn, chưa lưu và xoá tham số khỏi URL", async ({ page }) => {
  const { state, code } = await setupCode(page);
  await page.goto("/knowledge/workflows?duan=reconcile");
  await expect(page.getByText("Có thay đổi chưa áp dụng.")).toBeVisible();
  await expect(page).toHaveURL(/\/knowledge\/workflows$/);
  expect(code.calls.fromProject).toEqual(["reconcile"]);
  expect(state.saved).toHaveLength(0);
  await page.getByRole("button", { name: "Áp dụng quy trình" }).click();
  await expect(page.getByText("Đã áp dụng quy trình.")).toBeVisible();
  expect(state.saved.at(-1)).toMatchObject({ subject: "code", code: { projects: ["reconcile"] } });
});

test("?duan= báo lỗi khi hub không dựng được bản nháp và không lưu gì", async ({ page }) => {
  const fixture = workflowsFixture();
  const code = codeWorkflowsFixture(fixture.state);
  await inOrg(page, "admin", {
    ...fixture.rpc,
    ...code.rpc,
    "codeReviews/workflowFromProject": () => fail("NOT_FOUND", 404, "Không tìm thấy dự án."),
  });
  await page.goto("/knowledge/workflows?duan=reconcile");
  await expect(page.getByRole("alert").filter({ hasText: "Không tìm thấy dự án." })).toBeVisible();
  expect(fixture.state.saved).toHaveLength(0);
});

test("người chỉ đọc mở ?duan= thì không dựng bản nháp", async ({ page }) => {
  const { state, code } = await setupCode(page, "member");
  await page.goto("/knowledge/workflows?duan=reconcile");
  await expect(page.getByText("Bạn chỉ xem được quy trình duyệt.")).toBeVisible();
  await expect(page).toHaveURL(/\/knowledge\/workflows$/);
  expect(code.calls.fromProject).toEqual([]);
  expect(state.saved).toHaveLength(0);
});

test("người chỉ đọc xem quy trình Code nhưng không sửa được", async ({ page }) => {
  await setupCode(page, "member");
  await page.goto("/knowledge/workflows");
  await filterButton(page, "Code (PR)").click();
  await expect(page.getByText("Bạn chỉ xem được quy trình duyệt.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Áp dụng quy trình" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Tạo từ cấu hình dự án" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Nhánh đích" })).toBeDisabled();
  // Chạy thử vẫn dùng được: không đổi gì trên hub.
  await expect(page.getByRole("button", { name: "Chạy thử trên 1 PR" })).toBeEnabled();
});

test("quy trình Code ở 360 px không tràn ngang", async ({ page }) => {
  await setupCode(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/knowledge/workflows");
  await filterButton(page, "Code (PR)").click();
  await expect(page.getByRole("combobox", { name: "Quy trình" })).toHaveValue(CODE_WORKFLOW_ID);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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
  test(`ảnh quy trình Code 1440×1000, ${scheme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: scheme });
    await setupCode(page);
    await page.goto("/knowledge/workflows");
    await filterButton(page, "Code (PR)").click();
    await gateCard(page, /AI tự kiểm/).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`workflows-code-${scheme}.png`), fullPage: true });
  });

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
