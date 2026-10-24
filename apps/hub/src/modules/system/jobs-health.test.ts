import { healthOutput, jobsHealthOutput } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import type { HubConfig, Jobs } from "../platform/index.ts";
import { jobsOnlyFetch } from "./jobs-app.ts";
import { JOBS_HEARTBEAT_CRON, JOBS_HEARTBEAT_QUEUE, JobsHeartbeat } from "./jobs-health.ts";

function fakeJobs() {
  const handlers = new Map<string, () => Promise<void>>();
  const schedules = new Map<string, string>();
  const jobs = {
    work: async (queue: string, handler: () => Promise<void>) => void handlers.set(queue, handler),
    schedule: async (queue: string, cron: string) => void schedules.set(queue, cron),
  } as unknown as Jobs;
  return { jobs, handlers, schedules };
}

function clock(start = "2026-10-24T00:00:00Z") {
  let t = Date.parse(start);
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const config = (roles: HubConfig["roles"]): HubConfig => ({ port: 0, version: "1.2.3", roles });

const get = (fetch: (r: Request) => Promise<Response>, path: string) => fetch(new Request(`http://hub${path}`));

describe("health của vai trò jobs", () => {
  it("tiến trình không chạy jobs trả 503", async () => {
    const res = await get(jobsOnlyFetch(config(["api"]), new JobsHeartbeat()), "/api/v1/health/jobs");
    expect(res.status).toBe(503);
  });

  it("đăng ký nhịp theo lịch pg-boss rồi trả 200 cùng lần nhịp cuối", async () => {
    const c = clock();
    const heartbeat = new JobsHeartbeat(c.now);
    const { jobs, handlers, schedules } = fakeJobs();
    await heartbeat.register(jobs);
    expect(schedules.get(JOBS_HEARTBEAT_QUEUE)).toBe(JOBS_HEARTBEAT_CRON);
    const fetch = jobsOnlyFetch(config(["jobs"]), heartbeat);

    // Vừa khởi động chưa có nhịp: vẫn khoẻ để healthcheck không báo hỏng oan.
    let res = await get(fetch, "/api/v1/health/jobs");
    expect(res.status).toBe(200);
    expect(jobsHealthOutput.parse(await res.json())).toEqual({ ok: true, lastTickAt: null });

    c.advance(60_000);
    await handlers.get(JOBS_HEARTBEAT_QUEUE)?.();
    res = await get(fetch, "/api/v1/health/jobs");
    expect(jobsHealthOutput.parse(await res.json()).lastTickAt).toBe("2026-10-24T00:01:00.000Z");
  });

  it("quá ba phút không có nhịp thì trả 503", async () => {
    const c = clock();
    const heartbeat = new JobsHeartbeat(c.now);
    const { jobs, handlers } = fakeJobs();
    await heartbeat.register(jobs);
    await handlers.get(JOBS_HEARTBEAT_QUEUE)?.();
    c.advance(3 * 60_000 + 1);
    const res = await get(jobsOnlyFetch(config(["jobs"]), heartbeat), "/api/v1/health/jobs");
    expect(res.status).toBe(503);
    expect(heartbeat.status()).toMatchObject({ ok: false, lastTickAt: "2026-10-24T00:00:00.000Z" });
  });

  it("tiến trình chỉ có jobs trả health kèm vai trò, không mở API khác", async () => {
    const fetch = jobsOnlyFetch(config(["jobs"]), new JobsHeartbeat());
    const res = await get(fetch, "/api/v1/health");
    expect(res.status).toBe(200);
    expect(healthOutput.parse(await res.json())).toMatchObject({ status: "ok", version: "1.2.3", roles: ["jobs"] });
    expect((await get(fetch, "/api/v1/projects")).status).toBe(404);
    expect((await get(fetch, "/")).status).toBe(404);
  });
});
