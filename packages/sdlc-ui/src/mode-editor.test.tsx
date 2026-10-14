import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModeEditor } from "./mode-editor.tsx";
import { fakeClient, modeView, renderWithEnv, testEnv } from "./test-fixtures.tsx";

function open(ref: "small" | "speckit" = "small", canWrite = true) {
  const save = vi.fn(async (input) => ({
    ...modeView(ref),
    preset: false,
    ref: "custom",
    slug: input.slug,
    definition: input.definition,
  }));
  const dryRun = vi.fn(async () => ({
    phases: [
      {
        id: "design",
        name: "Thiết kế",
        kind: "design",
        skipped: false,
        artifacts: [{ artifactId: "design", path: "specs/012-hoan-tien/design.md", docKey: "project/pay/design" }],
        gates: [],
      },
    ],
    warnings: [],
  }));
  const base = fakeClient();
  const client = { ...base, sdlc: { ...base.sdlc, modes: { ...base.sdlc.modes, save, dryRun } } };
  const env = testEnv(base);
  renderWithEnv(<ModeEditor mode={modeView(ref)} />, {
    ...env,
    api: createTanstackQueryUtils(client) as unknown as typeof env.api,
    can: { ...env.can, manageModes: canWrite },
  });
  return { save, dryRun };
}
describe("cấu hình chế độ", () => {
  it("preset lưu thành bản sao và không sửa preset", async () => {
    const { save } = open();
    await userEvent.setup().click(screen.getByRole("button", { name: "Lưu chế độ" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]?.[0]).toMatchObject({ slug: "small-copy", basePreset: "small", teamId: null });
    expect(save.mock.calls[0]?.[0]).not.toHaveProperty("id");
  });
  it("FR-056 báo tại giai đoạn requirements của chế độ nặng", async () => {
    const { save } = open("speckit");
    const user = userEvent.setup();
    const phase = screen
      .getAllByLabelText("Loại giai đoạn")
      .find((el) => (el as HTMLSelectElement).value === "requirements")
      ?.closest("section");
    const toggle = phase && within(phase).getByRole("checkbox", { name: "Tự duyệt AI" });
    if (!toggle) throw new Error("Thiếu giai đoạn");
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Lưu chế độ" }));
    expect(screen.getByText(/Giai đoạn yêu cầu của chế độ nặng luôn cần người duyệt/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });
  it("đường dẫn cấm không được lưu, chạy thử trả đường dẫn", async () => {
    const { save, dryRun } = open("speckit");
    const user = userEvent.setup();
    const path = screen.getAllByLabelText("Đường dẫn repo")[0];
    if (!path) throw new Error("Thiếu tài liệu");
    await user.clear(path);
    await user.type(path, ".github/workflows/build.yml");
    await user.click(screen.getByRole("button", { name: "Lưu chế độ" }));
    expect(screen.getByText(/Đường dẫn tài liệu phải nằm/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    await user.clear(path);
    await user.type(path, "specs/{NNN}-{slug}/design.md");
    await user.click(screen.getByRole("button", { name: "Chạy thử" }));
    await waitFor(() => expect(dryRun).toHaveBeenCalled());
    expect(await screen.findByText(/specs\/012-hoan-tien\/design.md/)).toBeTruthy();
  });
  it("chỉ đọc khoá cấu hình và nút lưu", () => {
    open("small", false);
    expect(screen.getByRole("button", { name: "Lưu chế độ" }).hasAttribute("disabled")).toBe(true);
  });
  it("gõ nhiều mục bắt buộc giữ được dòng mới và lưu đủ danh sách", async () => {
    const { save } = open("speckit");
    const user = userEvent.setup();
    const sections = screen.getAllByLabelText("Mục bắt buộc (mỗi dòng)")[0];
    if (!sections) throw new Error("Thiếu danh sách mục");
    await user.clear(sections);
    await user.type(sections, "Mục tiêu{Enter}Tiêu chí");
    const artifacts = screen.getAllByLabelText("Mã tài liệu (cách nhau bởi dấu phẩy)")[0];
    if (!artifacts) throw new Error("Thiếu tài liệu của bước");
    await user.clear(artifacts);
    await user.type(artifacts, "spec, plan");
    await user.click(screen.getByRole("button", { name: "Lưu chế độ" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]?.[0].definition.phases[0].artifacts[0].sections).toEqual(["Mục tiêu", "Tiêu chí"]);
    expect(save.mock.calls[0]?.[0].definition.phases[0].steps[0].artifacts).toEqual(["spec", "plan"]);
  });
  it("thêm tài liệu ở hai giai đoạn sinh mã và đường dẫn riêng", async () => {
    const { save } = open("speckit");
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "Thêm tài liệu" })[0] as HTMLElement);
    await user.click(screen.getAllByRole("button", { name: "Thêm tài liệu" })[1] as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Lưu chế độ" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const added = save.mock.calls[0]?.[0].definition.phases
      .flatMap((p: { artifacts: { id: string; path: string }[] }) => p.artifacts)
      .filter((a: { id: string }) => a.id.startsWith("doc-"));
    expect(added?.map((a: { id: string }) => a.id)).toEqual(["doc-1", "doc-2"]);
    expect(new Set(added?.map((a: { path: string }) => a.path)).size).toBe(2);
  });
});
