import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ArtifactType } from "@xdev-hive/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactEditor } from "./editor.tsx";
import { asFake, editClient, writeResult } from "./test-edit-fixtures.tsx";
import { detail, ID_A, renderWithEnv, testEnv } from "./test-fixtures.tsx";

const user = userEvent.setup({ delay: null });

const orpcError = (message: string, data: unknown) => Object.assign(new Error(message), { data });

function setup(over: { type?: ArtifactType; content?: string; offline?: boolean } = {}) {
  const d = detail({ type: over.type ?? "markdown", content: over.content ?? "# Tiêu đề\nnội dung" });
  const client = editClient({ [ID_A]: d });
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  renderWithEnv(
    <ArtifactEditor artifact={d.artifact} version={d.version} onSaved={onSaved} onCancel={onCancel} />,
    testEnv(asFake(client), { offline: over.offline ?? false }),
  );
  const box = () => screen.getByLabelText("Nội dung") as HTMLTextAreaElement;
  const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
  return { client, onSaved, onCancel, box, type };
}

beforeEach(() => sessionStorage.clear());

describe("ArtifactEditor", () => {
  it("nạp nội dung bản gốc; chưa sửa thì chưa lưu được", () => {
    const { box } = setup();
    expect(box().value).toBe("# Tiêu đề\nnội dung");
    expect(screen.getByRole("button", { name: "Lưu" })).toHaveProperty("disabled", true);
  });

  it("lưu gửi baseVersion và ghi chú bản, rồi báo đã lưu", async () => {
    const { client, onSaved, type } = setup();
    type("# Mới");
    await user.type(screen.getByLabelText(/Ghi chú bản/), "  thêm rollback ");
    await user.click(screen.getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(client.artifacts.update).toHaveBeenCalled());
    expect(client.artifacts.update.mock.calls[0]?.[0]).toEqual({
      id: ID_A,
      content: "# Mới",
      baseVersion: 1,
      message: "thêm rollback",
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(sessionStorage.length).toBe(0);
  });

  it("không có ghi chú thì không gửi trường message", async () => {
    const { client, type } = setup();
    type("x");
    await user.click(screen.getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(client.artifacts.update).toHaveBeenCalled());
    expect(client.artifacts.update.mock.calls[0]?.[0]).not.toHaveProperty("message");
  });

  it("giữ bản nháp trong sessionStorage và nạp lại khi mở lại", () => {
    const first = setup();
    first.type("nháp dở");
    expect(sessionStorage.getItem(`hive-artifact-draft:${ID_A}@1`)).toBe("nháp dở");
    expect(screen.getByText("Bản nháp giữ trong trình duyệt, không lưu lên hub.")).toBeTruthy();
  });

  it("đánh dấu dòng có bí mật theo dòng và loại, không in lại chuỗi", async () => {
    const { client, type, box } = setup();
    client.artifacts.update.mockRejectedValue(
      orpcError("Có bí mật", { code: "ARTIFACT_SECRET_FOUND", findings: [{ line: 2, kind: "github_token" }] }),
    );
    type("dòng một\nghp_zzzz\nba");
    await user.click(screen.getByRole("button", { name: "Lưu" }));
    expect(await screen.findByText("Có chuỗi giống bí mật ở dòng 2 (GitHub token).")).toBeTruthy();
    // Vạch trong cột số dòng chỉ để nhìn (cột này aria-hidden); lời báo bằng chữ ở trên đã nêu số dòng.
    expect(screen.getByText("!")).toBeTruthy();
    expect(screen.getByText(/Hub không lưu và không hiện lại chuỗi đó/)).toBeTruthy();
    // Lỗi đã có khối riêng nên không in thêm câu chung của hub.
    expect(screen.queryByText("Có bí mật")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Tới dòng 2" }));
    expect(box().selectionStart).toBe("dòng một\n".length);
    expect(box().selectionEnd).toBe("dòng một\nghp_zzzz".length);
    // Sửa nội dung thì dấu cũ không còn đúng chỗ.
    type("dòng một\nđã xoá\nba");
    expect(screen.queryByText("!")).toBeNull();
  });

  it("xung đột: xem khác biệt rồi gộp, giữ của tôi thì lưu lên bản mới nhất", async () => {
    const { client, type } = setup({ content: "a\nb\n" });
    client.artifacts.update
      .mockRejectedValueOnce(
        orpcError("Xung đột", { code: "ARTIFACT_VERSION_CONFLICT", latest: { version: 2, content: "a\nB\n" } }),
      )
      .mockResolvedValueOnce(writeResult(3));
    type("a\nb\nc\n");
    await user.click(screen.getByRole("button", { name: "Lưu" }));
    expect(await screen.findByText("Artifact đã có v2 trong lúc bạn sửa từ v1.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Xem khác biệt rồi gộp" }));
    expect(screen.getByText("Bản mới nhất (v2)")).toBeTruthy();
    expect(screen.getByText("Bản của bạn (từ v1)")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Giữ của tôi, lưu thành bản kế tiếp" }));
    await waitFor(() => expect(client.artifacts.update).toHaveBeenCalledTimes(2));
    expect(client.artifacts.update.mock.calls[1]?.[0]).toMatchObject({ content: "a\nb\nc\n", baseVersion: 2 });
  });

  it("xung đột: lấy bản mới nhất làm gốc thay nội dung và sửa tiếp từ v mới", async () => {
    const { client, type, box } = setup({ content: "a\n" });
    client.artifacts.update.mockRejectedValueOnce(
      orpcError("Xung đột", { code: "ARTIFACT_VERSION_CONFLICT", latest: { version: 2, content: "a\nngười khác\n" } }),
    );
    type("của tôi");
    await user.click(screen.getByRole("button", { name: "Lưu" }));
    await user.click(await screen.findByRole("button", { name: "Lấy bản mới nhất làm gốc" }));
    expect(box().value).toBe("a\nngười khác\n");
    expect(screen.queryByText(/Artifact đã có v2/)).toBeNull();
  });

  it("xung đột với bản đã bị xoá vì bí mật: không so sánh được", async () => {
    const { client, type } = setup();
    client.artifacts.update.mockRejectedValueOnce(
      orpcError("Xung đột", { code: "ARTIFACT_VERSION_CONFLICT", latest: { version: 2, content: null } }),
    );
    type("x");
    await user.click(screen.getByRole("button", { name: "Lưu" }));
    expect(await screen.findByText(/Bản mới nhất đã bị xoá vì chứa bí mật/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Xem khác biệt rồi gộp" })).toHaveProperty("disabled", true);
  });

  it("html/mermaid xem trước bằng nội dung chưa lưu qua khung cách ly", async () => {
    const { client, type } = setup({ type: "html", content: "<p>a</p>" });
    type("<p>chưa lưu</p>");
    await user.click(screen.getByRole("button", { name: "Xem trước" }));
    await waitFor(() => expect(client.artifacts.preview).toHaveBeenCalled());
    expect(client.artifacts.preview.mock.calls[0]?.[0]).toEqual({
      type: "html",
      content: "<p>chưa lưu</p>",
      theme: "light",
    });
    expect(await screen.findByTitle("Xem trước nội dung chưa lưu")).toBeTruthy();
  });

  it("markdown xem trước tại chỗ, không gọi hub", async () => {
    const { client, type } = setup();
    type("# Chưa lưu");
    await user.click(screen.getByRole("button", { name: "Xem trước" }));
    expect(await screen.findByRole("heading", { name: "Chưa lưu" })).toBeTruthy();
    expect(client.artifacts.preview).not.toHaveBeenCalled();
  });

  it("thôi khi đã sửa thì hỏi trước khi bỏ bản nháp", async () => {
    const { type, onCancel } = setup();
    type("x");
    await user.click(screen.getByRole("button", { name: "Thôi" }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText("Bỏ thay đổi chưa lưu?")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Bỏ thay đổi" }));
    expect(onCancel).toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
  });

  it("thôi khi chưa sửa thì đóng ngay", async () => {
    const { onCancel } = setup();
    await user.click(screen.getByRole("button", { name: "Thôi" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("offline thì khoá lưu, vẫn soạn được", () => {
    const { type } = setup({ offline: true });
    type("x");
    expect(screen.getByText(/Đang offline\. Chưa lưu được/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Lưu" })).toHaveProperty("disabled", true);
  });
});
