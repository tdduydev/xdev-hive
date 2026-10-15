// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DocTreeItem } from "@xdev-hive/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { badgeState, buildDocTree, DocTree, repoCommitUrl, withUnhomedDocs } from "@/pages/knowledge/doc-tree.tsx";

const item = (patch: Partial<DocTreeItem> = {}): DocTreeItem => ({
  homeId: "home",
  key: "org/guide",
  title: "Hướng dẫn",
  path: "docs/guide.md",
  kind: "doc",
  state: "synced",
  prNumber: null,
  prUrl: null,
  repoUrl: "https://github.com/acme/docs/blob/main/docs/guide.md",
  repoCommit: "a".repeat(40),
  docId: "doc",
  assetId: null,
  version: 1,
  error: null,
  ...patch,
});
afterEach(cleanup);
describe("cây tài liệu", () => {
  it("tách đường dẫn trùng của hai nhà, giữ tài liệu chưa có nhà", () => {
    const rows = withUnhomedDocs(
      [item(), item({ homeId: "other", key: "org/other" })],
      [
        {
          id: "legacy",
          key: "org/cu",
          title: "Cũ",
          version: 1,
          scope: { level: "org", teamId: null, projectId: null },
          updatedAt: "2026-10-16T00:00:00.000Z",
          updatedBy: { userId: null, runId: null },
        },
      ],
    );
    expect(buildDocTree(rows)).toHaveLength(3);
    expect(badgeState(rows[2])).toBe("no_home");
  });
  it("đóng mở bằng nút và chọn file kèm nhãn PR", () => {
    const select = vi.fn();
    render(<DocTree items={[item({ state: "pending", prNumber: 128 })]} onSelect={select} />);
    expect(screen.getByText("PR #128 đang mở")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Hướng dẫn/ }));
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ key: "org/guide" }));
    fireEvent.click(screen.getByRole("button", { name: "Thu thư mục docs" }));
    expect(screen.queryByText("Hướng dẫn")).toBeNull();
  });
  it("tạo link commit đúng GitHub và GitLab, đổi trạng thái asset thành nhãn", () => {
    expect(repoCommitUrl(item())).toBe(`https://github.com/acme/docs/commit/${"a".repeat(40)}`);
    expect(repoCommitUrl(item({ repoUrl: "https://gitlab.example/acme/docs/-/blob/main/docs/a.md" }))).toBe(
      `https://gitlab.example/acme/docs/-/commit/${"a".repeat(40)}`,
    );
    expect(badgeState(item({ state: "pending_push" }))).toBe("pending");
    expect(badgeState(item({ state: "synced", prNumber: 128 }))).toBe("pending");
    expect(badgeState(item({ state: "missing_lfs" }))).toBe("failed");
  });
});
