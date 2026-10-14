import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ArtifactSummary } from "@xdev-hive/contracts";
import { describe, expect, it, vi } from "vitest";
import { ShareDialog } from "./share-dialog.tsx";
import { asFake, editClient } from "./test-edit-fixtures.tsx";
import { detail, ID_A, renderWithEnv, testEnv } from "./test-fixtures.tsx";

const user = userEvent.setup({ delay: null });

const summary = (over: Partial<ArtifactSummary> = {}): ArtifactSummary => ({
  ...detail({ latestVersion: 3 }).artifact,
  ...over,
});

function open(artifact: ArtifactSummary, version = 3, over: { offline?: boolean } = {}) {
  const client = editClient();
  renderWithEnv(
    <ShareDialog artifact={artifact} version={version} open onOpenChange={vi.fn()} />,
    testEnv(asFake(client), over),
  );
  return client;
}

describe("ShareDialog", () => {
  it("riêng tư là mặc định và không có gì để lưu cho tới khi đổi", async () => {
    open(summary());
    expect(await screen.findByRole("radio", { name: /Cá nhân/ })).toHaveProperty("checked", true);
    expect(screen.getByRole("button", { name: "Lưu thay đổi" })).toHaveProperty("disabled", true);
    // Chỉ hai phạm vi MVP: team và org chưa có giao diện.
    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });

  it("chia sẻ cho dự án cần chọn dự án và tick đã kiểm tra các phiên bản cũ", async () => {
    const client = open(summary());
    await user.click(screen.getByRole("radio", { name: /Dự án/ }));
    await user.selectOptions(await screen.findByLabelText("Dự án", { selector: "select" }), "refund");
    expect(screen.getByText("Mọi thành viên dự án Hoàn tiền sẽ thấy cả các phiên bản cũ.")).toBeTruthy();
    const save = screen.getByRole("button", { name: "Lưu thay đổi" });
    expect(save).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("checkbox", { name: "Tôi đã kiểm tra các phiên bản cũ." }));
    await user.click(save);
    await waitFor(() => expect(client.artifacts.setScope).toHaveBeenCalled());
    expect(client.artifacts.setScope.mock.calls[0]?.[0]).toEqual({ id: ID_A, scope: "project", projectKey: "refund" });
    expect(await screen.findByText("Đã đổi phạm vi.")).toBeTruthy();
  });

  it("gợi ý dự án đã sinh ra artifact", async () => {
    open(summary({ originProjectId: "p2" }));
    await user.click(screen.getByRole("radio", { name: /Dự án/ }));
    await waitFor(() =>
      expect(screen.getByLabelText("Dự án", { selector: "select" })).toHaveProperty("value", "billing"),
    );
  });

  it("đưa về cá nhân không cần xác nhận", async () => {
    const client = open(summary({ scope: "project", project: { id: "p1", key: "refund", name: "Hoàn tiền" } }));
    await user.click(screen.getByRole("radio", { name: /Cá nhân/ }));
    expect(screen.queryByRole("checkbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Lưu thay đổi" }));
    await waitFor(() => expect(client.artifacts.setScope).toHaveBeenCalled());
    expect(client.artifacts.setScope.mock.calls[0]?.[0]).toEqual({ id: ID_A, scope: "private" });
  });

  it("xem bản cũ thì cảnh báo người được chia sẻ thấy bản mới nhất", () => {
    open(summary(), 1);
    expect(
      screen.getByText("Bạn đang xem v1. Người được chia sẻ sẽ thấy bản mới nhất (v3), không phải bản này."),
    ).toBeTruthy();
  });

  it("offline thì khoá lưu và nói rõ link công khai là việc riêng", () => {
    const client = open(summary(), 3, { offline: true });
    expect(screen.getByText("Đang offline — kết nối hub để dùng thao tác này.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Lưu thay đổi" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/Đổi phạm vi không thay đổi link công khai/)).toBeTruthy();
    expect(client.projects.list).not.toHaveBeenCalled();
  });

  it("hiện lỗi của hub khi đổi phạm vi thất bại", async () => {
    const client = editClient();
    client.artifacts.setScope.mockRejectedValue(new Error("Bạn không phải chủ artifact."));
    renderWithEnv(
      <ShareDialog
        artifact={summary({ scope: "project", project: { id: "p1", key: "refund", name: "Hoàn tiền" } })}
        version={3}
        open
        onOpenChange={vi.fn()}
      />,
      testEnv(asFake(client)),
    );
    await user.click(screen.getByRole("radio", { name: /Cá nhân/ }));
    await user.click(screen.getByRole("button", { name: "Lưu thay đổi" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Bạn không phải chủ artifact.");
  });
});
