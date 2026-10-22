import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeHttp, startFakeHttp } from "../testing/fake-http.ts";
import {
  CI_POLL_BACKOFF_MAX_MS,
  CI_POLL_BUSY_MS,
  CI_POLL_IDLE_MS,
  ciNotice,
  nextPollDelay,
  onDefaultBranch,
  readJenkinsBuilds,
} from "./poll.ts";

const TOKEN = "jenkins-token-watcher-unit-0123456789";

describe("chu kỳ hỏi Jenkins", () => {
  it("rảnh 5 phút (Q4), có build chạy 15 giây", () => {
    expect(CI_POLL_IDLE_MS).toBe(5 * 60_000);
    expect(nextPollDelay({ failures: 0, building: false })).toBe(CI_POLL_IDLE_MS);
    expect(nextPollDelay({ failures: 0, building: true })).toBe(CI_POLL_BUSY_MS);
    expect(CI_POLL_BUSY_MS).toBe(15_000);
  });

  it("lỗi thì lùi dần, không quá trần, kể cả khi đang có build chạy", () => {
    const delays = [1, 2, 3, 4, 10].map((failures) => nextPollDelay({ failures, building: true }));
    expect(delays).toEqual([5 * 60_000, 10 * 60_000, 20 * 60_000, CI_POLL_BACKOFF_MAX_MS, CI_POLL_BACKOFF_MAX_MS]);
    expect(CI_POLL_BACKOFF_MAX_MS).toBe(30 * 60_000);
  });
});

describe("báo đỏ/xanh", () => {
  it("chuyển sang đỏ thì báo một lần, đỏ tiếp thì im", () => {
    expect(ciNotice(null, "failed")).toBe("ci.failed");
    expect(ciNotice("success", "failed")).toBe("ci.failed");
    expect(ciNotice("failed", "failed")).toBeNull();
  });

  it("chỉ báo xanh lại khi trước đó đã báo đỏ", () => {
    expect(ciNotice("failed", "success")).toBe("ci.recovered");
    expect(ciNotice("success", "success")).toBeNull();
    expect(ciNotice(null, "success")).toBeNull();
  });

  it("trạng thái khác (huỷ, unstable, chưa xong) không báo", () => {
    expect(ciNotice("failed", null)).toBeNull();
    expect(ciNotice(null, null)).toBeNull();
  });

  it("nhánh mặc định: dự án chưa ghi nhánh thì là main; build Jenkins không rõ nhánh tính là của dự án", () => {
    expect(onDefaultBranch("main", null)).toBe(true);
    expect(onDefaultBranch("develop", "develop")).toBe(true);
    expect(onDefaultBranch("feature/x", "main")).toBe(false);
    expect(onDefaultBranch(null, "main")).toBe(true);
  });
});

describe("đọc build Jenkins theo lịch", () => {
  let jenkins: FakeHttp;
  const build = (n: number, building: boolean) => ({
    number: n,
    url: `${jenkins.baseUrl}/job/a/${n}/`,
    result: building ? null : "FAILURE",
    building,
    timestamp: Date.parse("2026-10-20T10:00:00Z"),
    duration: building ? 0 : 1_000,
    actions: [{ lastBuiltRevision: { SHA1: `sha${n}`, branch: [{ name: "refs/remotes/origin/main" }] } }],
  });

  beforeAll(async () => {
    jenkins = await startFakeHttp({
      "GET /job/a/api/json": () => ({ json: { builds: [build(2, true), build(1, false)] } }),
      "GET /job/gone/api/json": { status: 404 },
      "GET /job/locked/api/json": { status: 401 },
    });
  });
  afterAll(() => jenkins.close());

  const auth = () => ({ baseUrl: jenkins.baseUrl, user: "watcher", token: TOKEN });
  const fetchLike = (input: string | URL | Request, init?: RequestInit) => fetch(input, init);

  it("job đã xoá trên Jenkins chỉ là lỗi của job đó, các job khác vẫn đọc", async () => {
    const out = await readJenkinsBuilds({ fetch: fetchLike }, auth(), [
      { id: "j-gone", jobPath: "gone" },
      { id: "j-a", jobPath: "a" },
    ]);
    expect(out.fatal).toBeNull();
    expect(out.results[0]).toMatchObject({ jobId: "j-gone", builds: null });
    expect(out.results[0]?.error).toMatch(/^Job gone: /);
    expect(out.results[1]?.builds?.map((b) => [b.number, b.building])).toEqual([
      [2, true],
      [1, false],
    ]);
  });

  it("Jenkins không nhận token người theo dõi: dừng cả lượt, lỗi nói rõ, không lộ token", async () => {
    const out = await readJenkinsBuilds({ fetch: fetchLike }, auth(), [
      { id: "j-locked", jobPath: "locked" },
      { id: "j-a", jobPath: "a" },
    ]);
    expect(out.fatal).toMatch(/người theo dõi/);
    expect(out.fatal).not.toContain(TOKEN);
    // Lần gọi duy nhất tới /job/a là của test trước: lỗi token thì không hỏi tiếp job khác.
    expect(jenkins.callsTo("GET /job/a/api/json")).toHaveLength(1);
  });
});
