import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArtifactDetail } from "./detail.tsx";
import { auditItem, libraryDetailClient, NOW } from "./library-detail.test-fixtures.tsx";
import { detail, ID_A, ID_B, renderWithEnv, testEnv } from "./test-fixtures.tsx";
import type { VersionHistoryProps } from "./versions.tsx";

// T021 sở hữu phần lịch sử; kiểm hợp đồng mở bản ở T022 mà không điền file của làn đó.
vi.mock("./versions.tsx", () => ({
  VersionHistory: ({ artifactId, current, access, onOpen }: VersionHistoryProps) => (
    <div>
      <p>
        {artifactId} · v{current} · {access.write ? "Có quyền sửa" : "Chỉ đọc"}
      </p>
      <button type="button" onClick={() => onOpen(1)}>
        Mở bản 1
      </button>
    </div>
  ),
}));

describe("ArtifactDetail", () => {
  it("đổi tab giữ nguyên khung tương tác để không mất trạng thái trang hoặc bản đang sửa", async () => {
    const client = libraryDetailClient();
    client.artifacts.get.mockResolvedValue(detail({ type: "html" }));
    renderWithEnv(<ArtifactDetail id={ID_A} />, testEnv(client));
    const frame = await screen.findByTitle("Trang của artifact Luồng hoàn tiền");
    fireEvent.click(screen.getByRole("tab", { name: "Liên kết" }));
    await screen.findByText("Artifact chưa có liên kết.");
    expect(frame.isConnected).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Nội dung" }));
    expect(screen.getByTitle("Trang của artifact Luồng hoàn tiền")).toBe(frame);
  });

  it("mặc định tải mới nhất, mở bản lịch sử và gọi app cập nhật route", async () => {
    const client = libraryDetailClient();
    const onVersionChange = vi.fn();
    renderWithEnv(<ArtifactDetail id={ID_A} onVersionChange={onVersionChange} />, testEnv(client));
    await screen.findByRole("heading", { level: 1, name: "Luồng hoàn tiền" });
    await screen.findByRole("heading", { name: "Nội dung bản 3" });
    expect(client.artifacts.get.mock.calls[0]?.[0]).toEqual({ id: ID_A });
    fireEvent.click(screen.getByRole("tab", { name: "Phiên bản" }));
    expect(screen.getByText(`${ID_A} · v3 · Có quyền sửa`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mở bản 1" }));
    await screen.findByRole("heading", { name: "Nội dung bản 1" });
    expect(onVersionChange).toHaveBeenCalledWith(1);
    expect(screen.getByRole("tab", { name: "Nội dung" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Có bản mới hơn (v3)")).toBeTruthy();
  });

  it("route ghim bản và đổi route reset tab, không dùng bản của artifact trước", async () => {
    const client = libraryDetailClient();
    const result = renderWithEnv(<ArtifactDetail id={ID_A} version={1} />, testEnv(client));
    await screen.findByRole("heading", { name: "Nội dung bản 1" });
    expect(client.artifacts.get.mock.calls[0]?.[0]).toEqual({ id: ID_A, version: 1 });
    fireEvent.click(screen.getByRole("tab", { name: "Liên kết" }));
    await screen.findByText("Artifact chưa có liên kết.");
    result.rerender(<ArtifactDetail id={ID_A} version={2} />);
    await screen.findByRole("heading", { name: "Nội dung bản 2" });
    expect(screen.getByRole("tab", { name: "Nội dung" }).getAttribute("aria-selected")).toBe("true");
    result.rerender(<ArtifactDetail id={ID_B} />);
    await screen.findByText("Artifact không còn truy cập được.");
    expect(screen.queryByRole("heading", { name: "Nội dung bản 2" })).toBeNull();
  });

  it("Liên kết chỉ tải khi mở tab; không tạo link hoặc lộ id của đích không đọc được", async () => {
    const client = libraryDetailClient();
    client.artifacts.links.list.mockResolvedValue([
      {
        targetKind: "chat_thread",
        targetId: ID_B,
        title: "Trao đổi hoàn tiền",
        createdAt: NOW,
        createdByUserId: "u1",
        createdByRunId: null,
      },
      {
        targetKind: "run",
        targetId: ID_A,
        title: "Run hoàn tiền",
        createdAt: NOW,
        createdByUserId: "u1",
        createdByRunId: null,
      },
      {
        targetKind: "doc",
        targetId: ID_A,
        title: "Tài liệu hoàn tiền",
        createdAt: NOW,
        createdByUserId: "u1",
        createdByRunId: null,
      },
      {
        targetKind: "chat_thread",
        targetId: "hidden-target",
        title: null,
        createdAt: NOW,
        createdByUserId: null,
        createdByRunId: null,
      },
    ]);
    const env = testEnv(client);
    renderWithEnv(<ArtifactDetail id={ID_A} version={1} />, env);
    await screen.findByRole("heading", { level: 1, name: "Luồng hoàn tiền" });
    expect(client.artifacts.links.list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Liên kết" }));
    expect((await screen.findByRole("link", { name: "Trao đổi hoàn tiền" })).getAttribute("href")).toBe("#thread");
    expect(screen.getByRole("link", { name: "Run hoàn tiền" }).getAttribute("href")).toBe("#run");
    expect(screen.getByText("Tài liệu hoàn tiền")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Tài liệu hoàn tiền" })).toBeNull();
    expect(screen.getByText("Không còn truy cập được đích liên kết.")).toBeTruthy();
    expect(screen.queryByText("hidden-target")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Link công khai" }));
    expect(env.onPublicLinks).toHaveBeenCalledWith(expect.objectContaining({ id: ID_A }), 1);
  });

  it("không mời tạo link công khai cho người không phải chủ", async () => {
    const client = libraryDetailClient();
    client.artifacts.get.mockResolvedValue(detail({ owner: false, manage: false, write: false }));
    renderWithEnv(<ArtifactDetail id={ID_A} />, testEnv(client));
    await screen.findByRole("heading", { level: 1, name: "Luồng hoàn tiền" });
    fireEvent.click(screen.getByRole("tab", { name: "Liên kết" }));
    await screen.findByText("Artifact chưa có liên kết.");
    expect(screen.queryByRole("button", { name: "Link công khai" })).toBeNull();
  });

  it("Hoạt động dùng audit thật, kiểm id chính xác và phân trang", async () => {
    const client = libraryDetailClient();
    const first = auditItem();
    client.audit.list.mockResolvedValueOnce({
      items: [first, auditItem({ id: ID_B, targetId: `${ID_A}-other`, actor: "Không được lẫn" })],
      nextCursor: "audit-next",
    });
    client.audit.list.mockResolvedValueOnce({
      items: [auditItem({ id: ID_B, action: "artifact.version", result: "denied" })],
      nextCursor: null,
    });
    renderWithEnv(<ArtifactDetail id={ID_A} />, testEnv(client));
    await screen.findByRole("heading", { level: 1, name: "Luồng hoàn tiền" });
    expect(client.audit.list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Hoạt động" }));
    await screen.findByText("Tạo artifact · An · Thành công");
    expect(screen.queryByText(/Không được lẫn/)).toBeNull();
    expect(client.audit.list.mock.calls[0]?.[0]).toEqual({ q: ID_A, range: 365, limit: 30 });
    fireEvent.click(screen.getByRole("button", { name: "Tải thêm" }));
    await screen.findByText("Lưu phiên bản · An · Bị từ chối");
    expect(client.audit.list.mock.calls.at(-1)?.[0]).toEqual({ q: ID_A, range: 365, limit: 30, cursor: "audit-next" });
  });

  it("tab hỗ trợ bàn phím và lỗi quyền audit có thử lại", async () => {
    const client = libraryDetailClient();
    client.audit.list.mockRejectedValueOnce(new Error("Bạn không có quyền đọc nhật ký."));
    renderWithEnv(<ArtifactDetail id={ID_A} />, testEnv(client));
    await screen.findByRole("heading", { level: 1, name: "Luồng hoàn tiền" });
    const content = screen.getByRole("tab", { name: "Nội dung" });
    content.focus();
    fireEvent.keyDown(content, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Hoạt động" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Bạn không có quyền đọc nhật ký.");
    fireEvent.click(screen.getByRole("button", { name: "Thử lại" }));
    await screen.findByText("Chưa có hoạt động trong thời hạn nhật ký.");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Hoạt động" }), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Nội dung" }));
  });

  it("lỗi get có thử lại, còn đã xoá không mở viewer", async () => {
    const client = libraryDetailClient();
    client.artifacts.get.mockRejectedValueOnce(new Error("Không kết nối được hub."));
    const result = renderWithEnv(<ArtifactDetail id={ID_A} />, testEnv(client));
    expect((await screen.findByRole("alert")).textContent).toContain("Không kết nối được hub.");
    fireEvent.click(screen.getByRole("button", { name: "Thử lại" }));
    await screen.findByRole("heading", { level: 1, name: "Luồng hoàn tiền" });
    result.unmount();
    client.artifacts.get.mockResolvedValue(detail({ deletedAt: NOW }));
    renderWithEnv(<ArtifactDetail id={ID_A} />, testEnv(client));
    await screen.findByText("Artifact không còn truy cập được.");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(client.artifacts.frameUrl).not.toHaveBeenCalled();
  });

  it("offline đọc bản đệm, tắt ghi và không tải lịch sử/liên kết/audit từ hub", async () => {
    const client = libraryDetailClient();
    const cached = { ...detail({ version: 2, latestVersion: 3 }), cachedAt: NOW };
    const cache = { get: vi.fn(async () => cached), put: vi.fn(), frameUrl: () => "hive-artifact://frame/a/2" };
    renderWithEnv(<ArtifactDetail id={ID_A} version={2} />, testEnv(client, { offline: true, offlineCache: cache }));
    await screen.findByRole("heading", { level: 1, name: "Luồng hoàn tiền" });
    await screen.findByRole("heading", { name: "Tiêu đề" });
    expect(cache.get).toHaveBeenCalledWith(ID_A, 2);
    expect((screen.getByRole("button", { name: "Sửa" }) as HTMLButtonElement).disabled).toBe(true);
    for (const name of ["Phiên bản", "Liên kết", "Hoạt động"]) {
      fireEvent.click(screen.getByRole("tab", { name }));
      expect(within(screen.getByRole("tabpanel")).getByText("Cần kết nối hub để mở.")).toBeTruthy();
    }
    expect(client.artifacts.get).not.toHaveBeenCalled();
    expect(client.artifacts.versions.list).not.toHaveBeenCalled();
    expect(client.artifacts.links.list).not.toHaveBeenCalled();
    expect(client.audit.list).not.toHaveBeenCalled();
  });

  it("offline chưa có bản đệm mời kết nối; tiếng Anh dùng cùng bộ tab", async () => {
    const client = libraryDetailClient();
    const result = renderWithEnv(<ArtifactDetail id={ID_A} />, testEnv(client, { offline: true }));
    expect(screen.getByText("Cần kết nối hub để mở.")).toBeTruthy();
    expect(client.artifacts.get).not.toHaveBeenCalled();
    result.unmount();
    renderWithEnv(<ArtifactDetail id={ID_A} />, testEnv(client, { lang: "en" }));
    await screen.findByRole("heading", { level: 1, name: "Luồng hoàn tiền" });
    expect(screen.getByRole("tab", { name: "Content" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Activity" })).toBeTruthy();
  });

  it("bản online được đưa vào bộ đệm của app", async () => {
    const client = libraryDetailClient();
    const cache = { get: vi.fn(async () => null), put: vi.fn(), frameUrl: () => "" };
    renderWithEnv(<ArtifactDetail id={ID_A} version={2} />, testEnv(client, { offlineCache: cache }));
    await waitFor(() =>
      expect(cache.put).toHaveBeenCalledWith(
        expect.objectContaining({ version: expect.objectContaining({ version: 2 }) }),
      ),
    );
  });
});
