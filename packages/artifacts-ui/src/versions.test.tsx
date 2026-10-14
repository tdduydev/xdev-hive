import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { asFake, editClient, versionMeta, writeResult } from "./test-edit-fixtures.tsx";
import { detail, ID_A, renderWithEnv, testEnv } from "./test-fixtures.tsx";
import { VersionHistory } from "./versions.tsx";

const user = userEvent.setup({ delay: null });
const access = { write: true, manage: true, owner: true };
const TOMBSTONED = "2026-10-14T03:42:00.000Z";

describe("VersionHistory", () => {
  it("liệt kê phiên bản mới nhất trước, đánh dấu bản đang xem, bản mới nhất, lỗi biên dịch và bản bị xoá", async () => {
    const client = editClient({}, [
      versionMeta(3, { name: "bản duyệt" }),
      versionMeta(2, { tombstonedAt: TOMBSTONED }),
      versionMeta(1, { hasCompileError: true }),
    ]);
    renderWithEnv(
      <VersionHistory artifactId={ID_A} current={3} access={access} onOpen={vi.fn()} />,
      testEnv(asFake(client)),
    );
    expect(await screen.findByText("v3 · bản duyệt", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText("mới nhất")).toBeTruthy();
    expect(screen.getByText("đang xem")).toBeTruthy();
    expect(screen.getAllByText("Lỗi biên dịch").length).toBeGreaterThan(0);
    expect(screen.getByText("Phiên bản này đã bị xoá vì chứa bí mật.")).toBeTruthy();
    // Chỉ v1 khôi phục được: v2 đã bị xoá nội dung, v3 là bản mới nhất.
    expect(screen.getAllByRole("button", { name: "Khôi phục bản này" })).toHaveLength(1);
  });

  it("mặc định so bản mới nhất với bản liền trước và hiện diff dòng", async () => {
    const client = editClient(
      {
        [`${ID_A}@1`]: detail({ version: 1, content: "a\nb\n" }),
        [`${ID_A}@2`]: detail({ version: 2, content: "a\nb\nc\n" }),
      },
      [versionMeta(2), versionMeta(1)],
    );
    renderWithEnv(
      <VersionHistory artifactId={ID_A} current={2} access={access} onOpen={vi.fn()} />,
      testEnv(asFake(client)),
    );
    expect(await screen.findByRole("heading", { name: "v1 → v2" })).toBeTruthy();
    expect(screen.getByText("c")).toBeTruthy();
  });

  it("đặt tên phiên bản", async () => {
    const client = editClient({}, [versionMeta(1)]);
    renderWithEnv(
      <VersionHistory artifactId={ID_A} current={1} access={access} onOpen={vi.fn()} />,
      testEnv(asFake(client)),
    );
    await user.click(await screen.findByRole("button", { name: "Đặt tên bản" }));
    await user.type(screen.getByLabelText("Tên phiên bản"), "  bản duyệt ");
    await user.click(screen.getByRole("button", { name: "Lưu tên" }));
    await waitFor(() => expect(client.artifacts.versions.rename).toHaveBeenCalled());
    expect(client.artifacts.versions.rename.mock.calls[0]?.[0]).toMatchObject({
      id: ID_A,
      version: 1,
      name: "bản duyệt",
    });
    expect(await screen.findByText("Đã lưu tên phiên bản.")).toBeTruthy();
  });

  it("khôi phục cần xác nhận, gửi baseVersion là bản mới nhất và mở bản vừa tạo", async () => {
    const client = editClient({}, [versionMeta(2), versionMeta(1)]);
    client.artifacts.versions.restore.mockResolvedValue(writeResult(3, { restoredFrom: 1 }));
    const onOpen = vi.fn();
    renderWithEnv(
      <VersionHistory artifactId={ID_A} current={2} access={access} onOpen={onOpen} />,
      testEnv(asFake(client)),
    );
    await user.click(await screen.findByRole("button", { name: "Khôi phục bản này" }));
    expect(screen.getByText("Tạo v3 từ bản đã chọn; không xoá các phiên bản giữa.")).toBeTruthy();
    expect(client.artifacts.versions.restore).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Khôi phục" }));
    await waitFor(() => expect(client.artifacts.versions.restore).toHaveBeenCalled());
    expect(client.artifacts.versions.restore.mock.calls[0]?.[0]).toMatchObject({
      id: ID_A,
      version: 1,
      baseVersion: 2,
    });
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(3));
  });

  it("không có quyền ghi thì không có nút đặt tên và khôi phục", async () => {
    const client = editClient({}, [versionMeta(2), versionMeta(1)]);
    renderWithEnv(
      <VersionHistory artifactId={ID_A} current={2} access={{ ...access, write: false }} onOpen={vi.fn()} />,
      testEnv(asFake(client)),
    );
    await screen.findByText("v1", { selector: "strong" });
    expect(screen.queryByRole("button", { name: "Đặt tên bản" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Khôi phục bản này" })).toBeNull();
    expect(screen.getByRole("button", { name: "Mở" })).toBeTruthy();
  });

  it("offline thì mời kết nối hub, không gọi API", () => {
    const client = editClient();
    renderWithEnv(
      <VersionHistory artifactId={ID_A} current={1} access={access} onOpen={vi.fn()} />,
      testEnv(asFake(client), { offline: true }),
    );
    expect(screen.getByText("Đang offline — kết nối hub để dùng thao tác này.")).toBeTruthy();
    expect(client.artifacts.versions.list).not.toHaveBeenCalled();
  });
});
