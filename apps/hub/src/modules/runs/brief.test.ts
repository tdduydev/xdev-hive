import { describe, expect, it } from "vitest";
import { briefStaleness } from "../knowledge/index.ts";
import { briefBlock, briefRunPrompt } from "./brief.ts";

const sha = "a".repeat(40);
const head = "b".repeat(40);
const brief = {
  content: "# Repo\nHub ở apps/hub.",
  commitSha: sha,
  source: "agent" as const,
  headSha: sha,
  commitsBehind: 0,
};

describe("briefBlock", () => {
  it("đặt brief trước chỉ dẫn khảo sát, nhắc memory_search và tin code hơn brief", () => {
    const text = briefBlock(brief, { memorySearch: true, memoryWrite: null });
    expect(text).toMatch(/^# Brief của dự án \(bản tóm tắt repo, viết ở commit a{12}\)\n\n# Repo/);
    expect(text).toContain("memory_search");
    expect(text).toContain("tin code");
    expect(text).not.toContain("memory_write");
    expect(text).not.toContain("đi trước");
  });

  it("brief cũ hơn nhánh chính thì ghi cả hai commit và số commit lệch", () => {
    const text = briefBlock({ ...brief, headSha: head, commitsBehind: 12 }, { memorySearch: true, memoryWrite: null });
    expect(text).toContain(`nhánh chính đã tới ${head.slice(0, 12)}, đi trước 12 commit`);
  });

  it("leader không có memory_search; run được ghi memory thì nói giới hạn và việc duyệt", () => {
    expect(briefBlock(null, { memorySearch: false, memoryWrite: null })).not.toContain("memory_search");
    const text = briefBlock(null, { memorySearch: true, memoryWrite: { mode: "propose", maxPerRun: 3 } });
    expect(text).toMatch(/^# Cách khảo sát repo/);
    expect(text).toContain("tối đa 3");
    expect(text).toContain("người trong đội duyệt");
    expect(briefBlock(null, { memorySearch: true, memoryWrite: { mode: "direct", maxPerRun: 3 } })).not.toContain(
      "duyệt",
    );
  });
});

describe("briefRunPrompt", () => {
  it("đưa brief hiện tại vào để giữ phần người viết tay", () => {
    const text = briefRunPrompt({ projectKey: "hd", baseBranch: "main", current: { ...brief, source: "user" } });
    expect(text).toContain("brief_submit");
    expect(text).toContain("người trong đội đã sửa tay");
    expect(text).toContain("Hub ở apps/hub.");
    expect(briefRunPrompt({ projectKey: "hd", baseBranch: "main", current: null })).not.toContain("Brief hiện tại");
  });
});

describe("briefStaleness", () => {
  const now = new Date("2026-10-13T00:00:00Z");
  const row = { commitSha: sha, commitsBehind: 0, updatedAt: now, source: "agent" as const };
  const settings = { refreshCommits: 50, refreshDays: 7 };

  it("chưa có, hay chỉ có bản viết tay chưa có commit, thì cần agent viết", () => {
    expect(briefStaleness(null, settings, now)).toBe("missing");
    expect(briefStaleness({ ...row, commitSha: null, source: "user" }, settings, now)).toBe("missing");
  });

  it("làm mới khi nhánh chính đi trước đủ số commit hoặc brief đủ số ngày", () => {
    expect(briefStaleness(row, settings, now)).toBeNull();
    expect(briefStaleness({ ...row, commitsBehind: 49 }, settings, now)).toBeNull();
    expect(briefStaleness({ ...row, commitsBehind: 50 }, settings, now)).toBe("commits");
    const old = new Date(now.getTime() - 7 * 86_400_000);
    expect(briefStaleness({ ...row, updatedAt: old }, settings, now)).toBe("age");
  });
});
