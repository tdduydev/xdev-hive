import { describe, expect, it } from "vitest";
import { createMemoryProvider, type ResolvedConnection } from "../scm/index.ts";
import { applyWebhookRefresh } from "./webhook-refresh.ts";

const conn = { id: "00000000-0000-4000-8000-000000000001", kind: "gitlab" } as ResolvedConnection;
const url = "https://hive.example/hooks/git/p1";

describe("applyWebhookRefresh", () => {
  it("cập nhật webhook cùng URL thêm pipeline, job, không tạo webhook mới; lỗi một dự án không chặn dự án khác", async () => {
    const scm = createMemoryProvider("gitlab", ["grp"]);
    const repo = scm.seedRepo({ owner: "grp", name: "web" });
    const { id } = await scm.addWebhook(
      { owner: "grp", name: "web" },
      { url, secret: "s", events: ["push", "pull_request", "issues", "issue_comment"] },
    );
    const result = await applyWebhookRefresh(
      () => scm,
      [
        { project: "mat", conn, ref: { owner: "grp", name: "mat-repo" }, url: "https://hive.example/x", secret: "s" },
        { project: "web", conn, ref: { owner: "grp", name: "web" }, url, secret: "s2" },
        { project: "het-ket-noi", conn: null, ref: { owner: "grp", name: "web" }, url, secret: "s" },
      ],
    );
    expect(result.updated).toBe(1);
    expect(result.failed.map((f) => f.project)).toEqual(["mat", "het-ket-noi"]);
    expect(result.failed[1]?.error).toBe("Kết nối Git của dự án không còn.");
    expect([...repo.hooks.keys()]).toEqual([id]);
    expect(repo.hooks.get(id)).toEqual({
      url,
      secret: "s2",
      events: ["push", "pull_request", "issues", "issue_comment", "pipeline", "job"],
    });
  });
});
