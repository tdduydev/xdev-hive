import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ArtifactSummary } from "@xdev-hive/contracts";
import { describe, expect, it, vi } from "vitest";
import { ConvertDialog, slugOf } from "./convert-dialog.tsx";
import type { ArtifactRef } from "./env.tsx";
import { ArtifactPanel } from "./panel.tsx";
import { detail, fakeClient, ID_A, renderWithEnv, testEnv } from "./test-fixtures.tsx";

const user = userEvent.setup({ delay: null });
const PROPOSAL = "00000000-0000-4000-8000-0000000000aa";

const summary = (over: Partial<ArtifactSummary> = {}): ArtifactSummary => ({
  ...detail({ title: "Quy trình hoàn tiền" }).artifact,
  ...over,
});

function convertClient() {
  const base = fakeClient();
  return {
    ...base,
    artifacts: {
      ...base.artifacts,
      toDoc: vi.fn(async (_input: { id: string; version: number; key: string; title?: string }) => ({
        proposalId: PROPOSAL,
      })),
    },
  };
}

function open(artifact: ArtifactSummary, over: { offline?: boolean } = {}) {
  const client = convertClient();
  renderWithEnv(<ConvertDialog artifact={artifact} version={2} open onOpenChange={vi.fn()} />, testEnv(client, over));
  return client;
}

describe("slugOf", () => {
  it("bỏ dấu tiếng Việt và ký tự lạ thành một đoạn key hợp lệ", () => {
    expect(slugOf("Quy trình hoàn tiền (v2)!")).toBe("quy-trinh-hoan-tien-v2");
    expect(slugOf("Đường đi")).toBe("duong-di");
    expect(slugOf("???")).toBe("");
  });
});

describe("ConvertDialog", () => {
  it("gợi ý key theo dự án của artifact và gửi đề xuất với phiên bản đang xem", async () => {
    const client = open(summary({ project: { id: ID_A, key: "payment-api", name: "Payment" } }));
    const key = await screen.findByLabelText(/Key tài liệu/);
    expect(key).toHaveProperty("value", "project/payment-api/quy-trinh-hoan-tien");
    await user.click(screen.getByRole("button", { name: "Gửi đề xuất" }));
    await waitFor(() => expect(client.artifacts.toDoc).toHaveBeenCalled());
    expect(client.artifacts.toDoc.mock.calls[0]?.[0]).toEqual({
      id: ID_A,
      version: 2,
      key: "project/payment-api/quy-trinh-hoan-tien",
    });
    expect((await screen.findByRole("status")).textContent).toContain("Đã gửi đề xuất tài liệu");
    expect(screen.getByText(`Mã đề xuất: ${PROPOSAL}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Gửi đề xuất" })).toHaveProperty("disabled", true);
  });

  it("tiêu đề nhập tay đi kèm, key sai dạng thì chặn gửi và báo lỗi", async () => {
    const client = open(summary({ project: { id: ID_A, key: "payment-api", name: "Payment" } }));
    const key = await screen.findByLabelText(/Key tài liệu/);
    await user.clear(key);
    await user.type(key, "Quy Trinh");
    expect(screen.getByRole("alert").textContent).toContain("Key chưa đúng dạng");
    expect(screen.getByRole("button", { name: "Gửi đề xuất" })).toHaveProperty("disabled", true);
    await user.clear(key);
    await user.type(key, "org/quy-trinh");
    await user.type(screen.getByLabelText(/Tiêu đề tài liệu/), "  Hoàn tiền  ");
    await user.click(screen.getByRole("button", { name: "Gửi đề xuất" }));
    await waitFor(() => expect(client.artifacts.toDoc).toHaveBeenCalled());
    expect(client.artifacts.toDoc.mock.calls[0]?.[0]).toEqual({
      id: ID_A,
      version: 2,
      key: "org/quy-trinh",
      title: "Hoàn tiền",
    });
  });

  it("hiện lỗi của hub khi không đủ quyền đề xuất", async () => {
    const client = open(summary({ project: { id: ID_A, key: "payment-api", name: "Payment" } }));
    client.artifacts.toDoc.mockRejectedValueOnce(new Error("Bạn không có quyền đề xuất ở đội này."));
    await user.click(await screen.findByRole("button", { name: "Gửi đề xuất" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Bạn không có quyền đề xuất ở đội này.");
    // Còn gửi lại được sau lỗi.
    expect(screen.getByRole("button", { name: "Gửi đề xuất" })).toHaveProperty("disabled", false);
  });

  it("ngoại tuyến thì tắt nút gửi", async () => {
    open(summary({ project: { id: ID_A, key: "payment-api", name: "Payment" } }), { offline: true });
    expect(await screen.findByText(/Đang ngoại tuyến/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Gửi đề xuất" })).toHaveProperty("disabled", true);
  });
});

describe("nút trong panel", () => {
  const ref = (type: ArtifactRef["type"]): ArtifactRef => ({ id: ID_A, version: 1, title: "Tài liệu", type });
  const show = (type: "markdown" | "mermaid", content: string | null = "# Nội dung") => {
    const client = fakeClient({ [ID_A]: detail({ type, content }) });
    renderWithEnv(
      <ArtifactPanel items={[ref(type)]} value={{ id: ID_A, version: 1 }} onValueChange={vi.fn()} />,
      testEnv(client),
    );
  };

  it("chỉ artifact Markdown có nội dung mới có nút chuyển thành tài liệu", async () => {
    show("markdown");
    expect(await screen.findByRole("button", { name: "Chuyển thành tài liệu" })).toBeTruthy();
  });

  it("loại khác không có nút", async () => {
    show("mermaid", "flowchart TD");
    await screen.findByRole("button", { name: "Nhân bản thành bản cá nhân" });
    expect(screen.queryByRole("button", { name: "Chuyển thành tài liệu" })).toBeNull();
  });
});
