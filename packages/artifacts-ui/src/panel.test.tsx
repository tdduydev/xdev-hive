import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactRef, ArtifactsEnv } from "./env.tsx";
import { ArtifactPanel, type ArtifactSelection, panelTabs } from "./panel.tsx";
import { asFake, editClient } from "./test-edit-fixtures.tsx";
import { detail, fakeClient, ID_A, ID_B, ID_C, renderWithEnv, testEnv } from "./test-fixtures.tsx";

const user = userEvent.setup({ delay: null });

const refA: ArtifactRef = { id: ID_A, version: 1, title: "Checklist", type: "markdown" };
const refB: ArtifactRef = { id: ID_B, version: 1, title: "Máy tính phí", type: "react" };
const refC: ArtifactRef = { id: ID_C, version: 1, title: "Luồng hoàn tiền", type: "mermaid" };

const details = {
  [ID_A]: detail({ id: ID_A, title: "Checklist", type: "markdown" }),
  [ID_B]: detail({ id: ID_B, title: "Máy tính phí", type: "react", content: "export default () => <b/>" }),
  [ID_C]: detail({ id: ID_C, title: "Luồng hoàn tiền", type: "mermaid", content: "flowchart TD" }),
};

/** Màn chủ giữ lựa chọn như trang Leader: `onValueChange` đặt lại `value`. */
function setup(items: ArtifactRef[], env: ArtifactsEnv, initial: ArtifactSelection | null = null) {
  const state = { value: initial, items, setValue: (_: ArtifactSelection) => {}, setItems: (_: ArtifactRef[]) => {} };
  const onValueChange = vi.fn((next: ArtifactSelection) => state.setValue(next));
  function Host() {
    const [value, setValue] = useState(initial);
    const [list, setList] = useState(items);
    state.value = value;
    state.setValue = setValue;
    state.setItems = setList;
    return <ArtifactPanel items={list} value={value} onValueChange={onValueChange} />;
  }
  renderWithEnv(<Host />, env);
  return {
    onValueChange,
    value: () => state.value,
    setItems: (next: ArtifactRef[]) => act(() => state.setItems(next)),
  };
}

describe("panelTabs", () => {
  it("mỗi artifact một tab theo thứ tự xuất hiện, giữ bản mới nhất", () => {
    expect(panelTabs([refA, refB, { ...refA, version: 3 }, { ...refA, version: 2 }])).toEqual([
      { ...refA, version: 3 },
      refB,
    ]);
  });
});

describe("ArtifactPanel", () => {
  it("rỗng khi cuộc trò chuyện chưa có artifact", () => {
    renderWithEnv(<ArtifactPanel items={[]} value={null} onValueChange={vi.fn()} />, testEnv(fakeClient()));
    expect(screen.getByText("Chưa có artifact")).toBeTruthy();
  });

  it("mở bản cuối lúc đầu, rồi tự mở artifact mới xuất hiện trong chat", async () => {
    const panel = setup([refA], testEnv(fakeClient(details)));
    expect(panel.value()).toEqual({ id: ID_A, version: 1 });
    expect(await screen.findByRole("heading", { name: "Tiêu đề" })).toBeTruthy();

    panel.setItems([refA, refB]);
    expect(panel.value()).toEqual({ id: ID_B, version: 1 });
    const tabs = screen.getByRole("navigation", { name: "Artifact của cuộc trò chuyện" });
    expect(within(tabs).getByRole("button", { name: /Máy tính phí/, pressed: true })).toBeTruthy();

    // Thẻ cũ vẽ lại (thăm dò) không làm khung nhảy.
    panel.onValueChange.mockClear();
    panel.setItems([refA, refB]);
    expect(panel.onValueChange).not.toHaveBeenCalled();

    // Bản mới của artifact đã có cũng tự mở.
    panel.setItems([refA, refB, { ...refA, version: 2 }]);
    expect(panel.value()).toEqual({ id: ID_A, version: 2 });
  });

  it("đang sửa thì không tự mở, chỉ chấm báo trên tab", async () => {
    // Vào chế độ sửa dựng ô soạn thật, cần thêm thủ tục `update`/`preview` mà fakeClient của khung không có.
    const panel = setup([refA, refB], testEnv(asFake(editClient(details))), { id: ID_A, version: 1 });
    await user.click(await screen.findByRole("button", { name: "Sửa" }));
    panel.onValueChange.mockClear();

    panel.setItems([refA, refB, refC]);
    expect(panel.onValueChange).not.toHaveBeenCalled();
    expect(panel.value()).toEqual({ id: ID_A, version: 1 });
    const tab = screen.getByRole("button", { name: /Luồng hoàn tiền/ });
    expect(within(tab).getByRole("img", { name: "Có artifact mới" })).toBeTruthy();
    // Không chuyển tab giữa chừng khi đang sửa.
    expect((tab as HTMLButtonElement).disabled).toBe(true);
  });

  it("nút Nhờ Leader sửa chỉ hiện khi trang có lỗi", async () => {
    const onAskLeaderFix = vi.fn();
    const withError = {
      ...details,
      [ID_B]: detail({ id: ID_B, title: "Máy tính phí", type: "react", compileError: "Unexpected token (3:4)" }),
    };
    const panel = setup([refA, refB], testEnv(fakeClient(withError), { onAskLeaderFix }), { id: ID_A, version: 1 });
    await screen.findByRole("heading", { name: "Tiêu đề" });
    expect(screen.queryByRole("button", { name: "Nhờ Leader sửa" })).toBeNull();

    await user.click(screen.getByRole("button", { name: /Máy tính phí/ }));
    expect(panel.value()).toEqual({ id: ID_B, version: 1 });
    expect(await screen.findByText("Unexpected token (3:4)", { selector: "li" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Nhờ Leader sửa" }));
    expect(onAskLeaderFix).toHaveBeenCalledWith({
      artifact: withError[ID_B]?.artifact,
      version: 1,
      errors: [{ kind: "compile", message: "Unexpected token (3:4)" }],
    });
  });

  it("lỗi do khung báo cũng bật nút; người không dùng được Leader thấy nút tắt kèm lý do", async () => {
    const html = { [ID_A]: detail({ id: ID_A, title: "Trang", type: "html", content: "<p>x</p>" }) };
    setup([{ ...refA, type: "html" }], testEnv(fakeClient(html), { canAskLeader: false }));
    const frame = (await screen.findByTitle("Trang của artifact Trang")) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(`http://hub.test/_artifact/frame/${ID_A}.1`);
    expect(screen.queryByRole("button", { name: "Nhờ Leader sửa" })).toBeNull();

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "error", kind: "runtime", message: "ReferenceError: foo" },
          source: frame.contentWindow,
        }),
      );
    });
    const button = screen.getByRole("button", { name: "Nhờ Leader sửa" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("Bạn chưa dùng được Leader ở đây.")).toBeTruthy();
  });

  it("báo bản mới hơn và mở được bản đó", async () => {
    const newer = {
      [`${ID_A}@1`]: detail({ id: ID_A, version: 1, latestVersion: 3 }),
      [`${ID_A}@3`]: detail({ id: ID_A, version: 3, content: "# Bản ba" }),
    };
    const panel = setup([refA], testEnv(fakeClient(newer)));
    expect(await screen.findByText("Có bản mới hơn (v3)")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Mở v3" }));
    expect(panel.value()).toEqual({ id: ID_A, version: 3 });
    expect(await screen.findByRole("heading", { name: "Bản ba" })).toBeTruthy();
    expect(screen.queryByText("Có bản mới hơn (v3)")).toBeNull();
  });

  it("artifact đã xoá hoặc không đọc được", async () => {
    setup([refA], testEnv(fakeClient({})));
    expect(await screen.findByText("Artifact không còn truy cập được.")).toBeTruthy();
  });

  it("offline: đọc bản đã đệm, tắt thao tác ghi; chưa đệm thì mời kết nối", async () => {
    const cached = { ...detail({ id: ID_A }), cachedAt: "2026-10-14T03:42:00.000Z" };
    const cache = { get: vi.fn(async () => cached), put: vi.fn(), frameUrl: vi.fn(() => "hive-artifact://x") };
    const client = fakeClient(details);
    const view = setup([refA], testEnv(client, { offline: true, offlineCache: cache }));
    expect(await screen.findByText(/Đang offline — bản đã tải lúc/)).toBeTruthy();
    expect(screen.getByText("Đang offline — kết nối hub để dùng thao tác này.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Sửa" }) as HTMLButtonElement).disabled).toBe(true);
    expect(client.artifacts.get).not.toHaveBeenCalled();
    expect(view.value()).toEqual({ id: ID_A, version: 1 });

    cache.get.mockResolvedValue(null as never);
    act(() => view.onValueChange({ id: ID_B, version: 1 }));
    expect(await screen.findByText("Cần kết nối hub để mở.")).toBeTruthy();
  });

  it("có mạng thì đệm bản vừa tải cho app", async () => {
    const cache = { get: vi.fn(), put: vi.fn(), frameUrl: vi.fn() };
    setup([refA], testEnv(fakeClient(details), { offlineCache: cache }));
    await waitFor(() => expect(cache.put).toHaveBeenCalledWith(details[ID_A]));
  });
});
