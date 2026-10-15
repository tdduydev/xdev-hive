// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it } from "vitest";
import { DocEditorProvider } from "./env.tsx";
import { type DocSyncState, SyncBadge, syncStateLabel } from "./sync-badge.tsx";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(node));
  return host;
}

describe("SyncBadge", () => {
  it("hiện đủ bảy trạng thái của FR-040 bằng tiếng Việt", () => {
    const states: [DocSyncState, string][] = [
      ["synced", "Đã đồng bộ"],
      ["pending", "Chờ đồng bộ"],
      ["conflict", "Xung đột"],
      ["failed", "Lỗi"],
      ["deleted_in_repo", "Đã xoá trên repo"],
      ["no_home", "Chưa có nhà"],
      ["blocked_secret", "Bị chặn vì bí mật"],
    ];
    for (const [state, label] of states) expect(syncStateLabel(state, "vi")).toBe(label);
  });

  it("chờ đồng bộ kèm PR đang mở thì hiện số PR, chỉ khi ở trạng thái chờ", async () => {
    expect((await render(<SyncBadge state="pending" prNumber={128} />)).textContent).toBe("PR #128 đang mở");
    expect((await render(<SyncBadge state="synced" prNumber={128} />)).textContent).toBe("Đã đồng bộ");
    expect(syncStateLabel("pending", "en", 128)).toBe("PR #128 open");
  });

  it("lấy ngôn ngữ từ DocEditorProvider, không có thì dùng prop `lang`, mặc định tiếng Việt", async () => {
    const env = { lang: "en" } as never;
    const inProvider = await render(
      <DocEditorProvider env={env}>
        <SyncBadge state="conflict" />
      </DocEditorProvider>,
    );
    expect(inProvider.textContent).toBe("Conflict");
    expect((await render(<SyncBadge state="conflict" lang="en" />)).textContent).toBe("Conflict");
    expect((await render(<SyncBadge state="conflict" />)).textContent).toBe("Xung đột");
  });

  it("gắn trạng thái vào thuộc tính để màn danh sách và test lọc được", async () => {
    const host = await render(<SyncBadge state="deleted_in_repo" />);
    expect(host.querySelector("[data-sync-state]")?.getAttribute("data-sync-state")).toBe("deleted_in_repo");
  });
});
