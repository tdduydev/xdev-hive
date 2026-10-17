// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DocTreeItem } from "@xdev-hive/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildScopeTree } from "@/pages/knowledge/doc-scope.ts";
import { badgeState, DocTree, repoCommitUrl, withUnhomedDocs } from "@/pages/knowledge/doc-tree.tsx";

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
  scope: { level: "org", teamId: null, projectId: null },
  ...patch,
});
afterEach(cleanup);
describe("cây tài liệu", () => {
  it("giữ tài liệu chưa có nhà và gán trạng thái không nhà", () => {
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
    expect(rows).toHaveLength(3);
    expect(badgeState(rows[2])).toBe("no_home");
  });
  it("đóng mở nút cấp và thư mục, chọn file kèm nhãn PR", () => {
    const select = vi.fn();
    const toggle = vi.fn();
    const nodes = buildScopeTree([item({ state: "pending", prNumber: 128 })], {
      teams: new Map(),
      systems: new Map(),
      projects: new Map(),
    });
    render(<DocTree nodes={nodes} open={new Set(["org"])} onToggle={toggle} onSelect={select} />);
    expect(screen.getByText("Chung toàn tổ chức (1)")).toBeTruthy();
    expect(screen.queryByText("PR #128 đang mở")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mở thư mục docs" }));
    expect(screen.getByText("PR #128 đang mở")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Hướng dẫn/ }));
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ key: "org/guide" }));
    fireEvent.click(screen.getByRole("button", { name: "Thu nhóm Chung toàn tổ chức" }));
    expect(toggle).toHaveBeenCalledWith("org");
  });
  it("nút đóng không vẽ nội dung, nút dự án hiện tên repo", () => {
    const nodes = buildScopeTree([item({ scope: { level: "project", teamId: "A", projectId: "P1" } })], {
      teams: new Map([["A", "Đội A"]]),
      systems: new Map([["S1", { name: "Hệ thống 1", teamId: "A" }]]),
      projects: new Map([["P1", { name: "Dự án P1", systemId: "S1", teamId: "A" }]]),
    });
    render(<DocTree nodes={nodes} open={new Set(["team:A", "system:S1"])} onSelect={vi.fn()} />);
    expect(screen.getByText("Dự án P1 (1)")).toBeTruthy();
    expect(screen.getByText("acme/docs")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mở thư mục docs" })).toBeNull();
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
