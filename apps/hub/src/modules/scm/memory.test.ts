import { describe, expect, it } from "vitest";
import { createMemoryProvider } from "./memory.ts";

const ref = { owner: "xdev-team", name: "web" };

describe("memory provider: prFiles và setCommitStatus", () => {
  it("suy file đổi từ nhánh head và base, hoặc dùng danh sách đặt tay", async () => {
    const scm = createMemoryProvider();
    scm.seedRepo(ref, { files: { "a.txt": "một\nhai\n", "gone.txt": "bye\n" } });
    await scm.commitFiles(ref, {
      branch: "ai/T",
      fromBranch: "main",
      message: "t",
      files: [
        { path: "a.txt", content: "một\nHAI\nba\n" },
        { path: "new.txt", content: "mới\n" },
      ],
    });
    const { number } = await scm.openPR(ref, { head: "ai/T", base: "main", title: "T", body: "" });
    const files = await scm.prFiles(ref, number);
    expect(files?.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["a.txt", "modified", 3, 2],
      ["new.txt", "added", 1, 0],
    ]);
    expect(files?.[1]?.patch).toBe("@@ -0,0 +1,1 @@\n+mới");

    scm.setPull(ref, number, {
      files: [{ path: "big.json", status: "modified", additions: 9000, deletions: 1, truncated: true }],
    });
    expect((await scm.prFiles(ref, number))?.[0]?.truncated).toBe(true);
    expect(await scm.prFiles(ref, 99)).toBeNull();
  });

  it("status cùng context của một commit bị ghi đè, khác context hoặc khác sha thì giữ riêng", async () => {
    const scm = createMemoryProvider();
    const repo = scm.seedRepo(ref);
    await scm.setCommitStatus(ref, "sha1", { context: "xdev-hive/review", state: "pending", description: "chờ" });
    await scm.setCommitStatus(ref, "sha1", { context: "xdev-hive/review", state: "success", description: "đạt" });
    await scm.setCommitStatus(ref, "sha1", { context: "khac", state: "failure", description: "" });
    await scm.setCommitStatus(ref, "sha2", {
      context: "xdev-hive/review",
      state: "pending",
      description: "x".repeat(300),
    });
    expect(repo.statuses.get("sha1")?.get("xdev-hive/review")?.state).toBe("success");
    expect(repo.statuses.get("sha1")?.size).toBe(2);
    expect(repo.statuses.get("sha2")?.get("xdev-hive/review")?.description).toHaveLength(140);
  });
});
