import { deployCompare, deployVersion } from "@xdev-hive/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubProvider, createGitLabProvider, createMemoryProvider, GitProviderError } from "../scm/index.ts";
import type { ScmTarget } from "./ci/feed.ts";
import { setDeliveryOutbound } from "./clients/outbound.ts";
import { readDeployCompare } from "./compare.ts";

const version = (commit: string | null) =>
  deployVersion.parse({ commit, tag: null, jenkinsBuild: null, image: null, images: [], revision: null });
const comparison = () => ({ from: version("old"), to: version("new"), commits: [], incomplete: true });
const commit = { sha: "abcdef123", title: "Sửa lỗi\nChi tiết", author: "Lan", authoredAt: "2026-10-23T01:00:00.000Z" };
const target = (): ScmTarget => ({
  provider: createMemoryProvider(),
  ref: { owner: "acme", name: "app" },
  source: "gitlab",
  connectionName: "Git",
});
afterEach(() => setDeliveryOutbound(true));

describe("commit cho người duyệt", () => {
  it("giữ from/to, chuẩn hoá dòng đầu và giờ theo hợp đồng", async () => {
    const t = target();
    t.provider.compare = vi.fn().mockResolvedValue({ commits: [commit], files: [], incomplete: false });
    const result = await readDeployCompare(comparison(), t);
    expect(deployCompare.parse(result)).toEqual({
      ...comparison(),
      commits: [{ sha: commit.sha, title: "Sửa lỗi", author: "Lan", at: commit.authoredAt }],
      incomplete: false,
    });
    expect(t.provider.compare).toHaveBeenCalledWith(t.ref, "old", "new");
  });

  it("giới hạn 100 commit và giữ dấu cắt từ nguồn", async () => {
    const t = target();
    t.provider.compare = vi.fn().mockResolvedValue({
      commits: Array.from({ length: 101 }, (_, i) => ({ ...commit, sha: String(i) })),
      files: [],
      incomplete: false,
    });
    const result = await readDeployCompare(comparison(), t);
    expect(result.commits).toHaveLength(100);
    expect(result.incomplete).toBe(true);
    t.provider.compare = vi.fn().mockResolvedValue({ commits: [], files: [], incomplete: true });
    expect((await readDeployCompare(comparison(), t)).incomplete).toBe(true);
  });

  it("không bịa giờ cho commit thiếu dữ liệu", async () => {
    const t = target();
    t.provider.compare = vi.fn().mockResolvedValue({
      commits: [
        { ...commit, authoredAt: null },
        { ...commit, authoredAt: "sai" },
      ],
      files: [],
      incomplete: false,
    });
    expect(await readDeployCompare(comparison(), t)).toMatchObject({ commits: [], incomplete: true });
  });

  it("không mở mạng khi tắt outbound, không có bản trước, không có revision hay kết nối", async () => {
    const t = target();
    t.provider.compare = vi.fn();
    setDeliveryOutbound(false);
    await readDeployCompare(comparison(), t);
    setDeliveryOutbound(true);
    await readDeployCompare({ ...comparison(), from: null }, t);
    await readDeployCompare({ ...comparison(), to: version(null) }, t);
    expect(await readDeployCompare(comparison(), null)).toMatchObject({ commits: [], incomplete: true });
    expect(t.provider.compare).not.toHaveBeenCalled();
  });

  it.each([
    new Error("mất mạng"),
    new GitProviderError("not_found", "không có bản"),
    new GitProviderError("rate_limited", "chờ"),
  ])("nguồn lỗi trả danh sách chưa đầy đủ: %s", async (error) => {
    const t = target();
    t.provider.compare = vi.fn().mockRejectedValue(error);
    expect(await readDeployCompare(comparison(), t)).toMatchObject({ commits: [], incomplete: true });
  });

  it.each(["forbidden", "unauthorized"] as const)("giữ lỗi quyền nguồn %s theo CI", async (code) => {
    const t = target();
    t.provider.compare = vi.fn().mockRejectedValue(new GitProviderError(code, "thiếu quyền"));
    await expect(readDeployCompare(comparison(), t)).rejects.toMatchObject({
      code: code === "forbidden" ? "CI_SOURCE_FORBIDDEN" : "CI_SOURCE_UNAUTHORIZED",
    });
  });

  it.each(["gitlab", "github"] as const)("đọc API %s bằng provider sẵn có", async (source) => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return new Response(
        JSON.stringify(
          source === "gitlab"
            ? {
                diffs: [],
                commits: [
                  { id: commit.sha, title: "Sửa lỗi", author_name: commit.author, authored_date: commit.authoredAt },
                ],
                compare_timeout: true,
              }
            : {
                files: [],
                commits: [
                  {
                    sha: commit.sha,
                    commit: { message: "Sửa lỗi", author: { name: commit.author, date: commit.authoredAt } },
                  },
                ],
                total_commits: 101,
              },
        ),
        { headers: { "content-type": "application/json" } },
      );
    });
    const provider =
      source === "gitlab"
        ? createGitLabProvider({ token: "test-token", url: "https://git.example", fetch: fetcher })
        : createGitHubProvider({ token: "test-token", fetch: fetcher });
    const result = await readDeployCompare(comparison(), { ...target(), source, provider });
    expect(result.commits[0]).toMatchObject({ sha: commit.sha, author: "Lan" });
    expect(result.incomplete).toBe(true);
    expect(fetcher.mock.calls[0]?.[1]?.method ?? "GET").toBe("GET");
    expect(calls[0]).toContain(
      source === "gitlab" ? "/repository/compare?from=old&to=new" : "/compare/old...new?per_page=100",
    );
  });
});
