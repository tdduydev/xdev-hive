import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArtifactLibrary } from "./library.tsx";
import { libraryDetailClient, NOW } from "./library-detail.test-fixtures.tsx";
import { detail, ID_A, ID_B, renderWithEnv, testEnv } from "./test-fixtures.tsx";

function first(elements: HTMLElement[]) {
  const element = elements[0];
  if (!element) throw new Error("Không tìm thấy phần tử kiểm thử.");
  return element;
}

describe("ArtifactLibrary", () => {
  it("gửi tìm kiếm và bộ lọc đến hub, dùng key dự án và không lọc nội dung tại client", async () => {
    const client = libraryDetailClient();
    renderWithEnv(<ArtifactLibrary />, testEnv(client));
    await screen.findAllByText("Luồng hoàn tiền");
    fireEvent.change(screen.getByLabelText("Tìm theo tiêu đề hoặc nội dung"), { target: { value: "  checklist  " } });
    fireEvent.change(screen.getByLabelText("Phạm vi"), { target: { value: "project" } });
    fireEvent.change(screen.getByLabelText("Loại"), { target: { value: "markdown" } });
    fireEvent.change(screen.getByLabelText("Nguồn"), { target: { value: "mcp" } });
    fireEvent.change(screen.getByLabelText("Dự án"), { target: { value: "payment-api" } });
    fireEvent.click(screen.getByLabelText("Của tôi"));
    await waitFor(() =>
      expect(client.artifacts.list).toHaveBeenLastCalledWith(
        {
          query: "checklist",
          scope: "project",
          type: "markdown",
          origin: "mcp",
          projectKey: "payment-api",
          mine: true,
          trash: false,
          limit: 30,
        },
        expect.anything(),
      ),
    );
    // Đổi bộ lọc là khoá truy vấn mới nên danh sách trống tới khi hub trả về; assert đồng bộ sẽ chạy đua với lần tải đó.
    expect(await screen.findAllByText("Luồng hoàn tiền")).toHaveLength(2);
  });

  it("tải con trỏ, bỏ dòng trùng, rồi bỏ trang cũ khi đổi bộ lọc", async () => {
    const client = libraryDetailClient();
    const first = detail().artifact;
    const second = detail({ id: ID_B, title: "Checklist" }).artifact;
    client.artifacts.list.mockImplementation(async (input) =>
      input.scope
        ? { items: [second], nextCursor: null }
        : input.cursor
          ? { items: [first, second], nextCursor: null }
          : { items: [first], nextCursor: "next-page" },
    );
    renderWithEnv(<ArtifactLibrary />, testEnv(client));
    fireEvent.click(await screen.findByRole("button", { name: "Tải thêm" }));
    await screen.findAllByText("Checklist");
    expect(client.artifacts.list.mock.calls.some(([input]) => input.cursor === "next-page")).toBe(true);
    expect(screen.getAllByText("Luồng hoàn tiền")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Tải thêm" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Phạm vi"), { target: { value: "private" } });
    await waitFor(() => expect(screen.queryByText("Luồng hoàn tiền")).toBeNull());
    expect(client.artifacts.list.mock.calls.at(-1)?.[0].cursor).toBeUndefined();
  });

  it("thùng rác chỉ khôi phục id đã chọn và làm mới danh sách", async () => {
    const client = libraryDetailClient();
    let restored = false;
    client.artifacts.list.mockImplementation(async (input) => ({
      items: input.trash && !restored ? [detail({ deletedAt: NOW }).artifact] : [],
      nextCursor: null,
    }));
    client.artifacts.restore.mockImplementation(async () => {
      restored = true;
      return detail().artifact;
    });
    renderWithEnv(<ArtifactLibrary />, testEnv(client));
    fireEvent.click(screen.getByRole("button", { name: "Thùng rác" }));
    fireEvent.click(first(await screen.findAllByRole("button", { name: "Khôi phục" })));
    await screen.findByText("Đã khôi phục artifact.");
    await screen.findByText("Thùng rác trống");
    expect(client.artifacts.restore.mock.calls[0]?.[0]).toEqual({ id: ID_A });
  });

  it("giữ dòng thùng rác và báo lỗi khi khôi phục thất bại", async () => {
    const client = libraryDetailClient();
    client.artifacts.restore.mockRejectedValueOnce(new Error("Bạn không có quyền khôi phục."));
    renderWithEnv(<ArtifactLibrary />, testEnv(client));
    fireEvent.click(screen.getByRole("button", { name: "Thùng rác" }));
    fireEvent.click(first(await screen.findAllByRole("button", { name: "Khôi phục" })));
    expect((await screen.findByRole("alert")).textContent).toContain("Bạn không có quyền khôi phục.");
    expect(screen.getAllByText("Luồng hoàn tiền")).toHaveLength(2);
  });

  it("thẻ dùng callback phiên bản mới nhất, mặc định dùng link của app chủ", async () => {
    const client = libraryDetailClient();
    const onOpen = vi.fn();
    const result = renderWithEnv(<ArtifactLibrary onOpen={onOpen} />, testEnv(client));
    fireEvent.click(first(await screen.findAllByRole("button", { name: "Luồng hoàn tiền" })));
    expect(onOpen).toHaveBeenCalledWith({ id: ID_A, title: "Luồng hoàn tiền", type: "markdown", version: 3 });
    result.rerender(<ArtifactLibrary />);
    expect(screen.getAllByRole("link", { name: "Luồng hoàn tiền" })[0]?.getAttribute("href")).toBe("#artifact");
  });

  it("phân biệt thư viện rỗng và không khớp bộ lọc; bỏ lọc gửi lại trang đầu", async () => {
    const client = libraryDetailClient();
    client.artifacts.list.mockResolvedValue({ items: [], nextCursor: null });
    renderWithEnv(<ArtifactLibrary />, testEnv(client));
    await screen.findByText("Chưa có artifact");
    fireEvent.change(screen.getByLabelText("Loại"), { target: { value: "react" } });
    await screen.findByText("Không có kết quả phù hợp");
    fireEvent.click(screen.getByRole("button", { name: "Bỏ bộ lọc" }));
    await screen.findByText("Chưa có artifact");
    expect((screen.getByLabelText("Loại") as HTMLSelectElement).value).toBe("");
  });

  it("lỗi tải có thử lại và tải thêm lỗi vẫn giữ trang đã tải", async () => {
    const client = libraryDetailClient();
    client.artifacts.list.mockRejectedValueOnce(new Error("Không kết nối được hub."));
    const result = renderWithEnv(<ArtifactLibrary />, testEnv(client));
    expect((await screen.findByRole("alert")).textContent).toContain("Không kết nối được hub.");
    fireEvent.click(screen.getByRole("button", { name: "Thử lại" }));
    await screen.findAllByText("Luồng hoàn tiền");
    result.unmount();
    client.artifacts.list.mockImplementation(async (input) => {
      if (input.cursor) throw new Error("Không tải được trang sau.");
      return { items: [detail().artifact], nextCursor: "next" };
    });
    renderWithEnv(<ArtifactLibrary />, testEnv(client));
    fireEvent.click(await screen.findByRole("button", { name: "Tải thêm" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Không tải được trang sau.");
    expect(screen.getAllByText("Luồng hoàn tiền")).toHaveLength(2);
  });

  it("offline không gọi hub, giữ dữ liệu đã tải và tắt khôi phục", async () => {
    const client = libraryDetailClient();
    const env = testEnv(client);
    const result = renderWithEnv(<ArtifactLibrary />, env);
    fireEvent.click(screen.getByRole("button", { name: "Thùng rác" }));
    await screen.findAllByRole("button", { name: "Khôi phục" });
    client.artifacts.list.mockClear();
    client.projects.list.mockClear();
    env.offline = true;
    result.rerender(<ArtifactLibrary />);
    for (const button of screen.getAllByRole("button", { name: "Khôi phục" }))
      expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(client.artifacts.list).not.toHaveBeenCalled();
    expect(client.projects.list).not.toHaveBeenCalled();
    expect(screen.getAllByText("Luồng hoàn tiền")).toHaveLength(2);
  });

  it("offline chưa tải và từ điển tiếng Anh không làm màn bị kẹt tải", () => {
    const client = libraryDetailClient();
    renderWithEnv(<ArtifactLibrary />, testEnv(client, { offline: true, lang: "en" }));
    expect(screen.getByText("Offline — connect to the hub to use this action.")).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(client.artifacts.list).not.toHaveBeenCalled();
  });
});
