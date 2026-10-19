import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeHttp, startFakeHttp } from "../testing/fake-http.ts";
import { createJenkinsClient, JenkinsError, type JenkinsErrorCode, jobUrlPath } from "./jenkins.ts";

const USER = "an.nguyen";
const TOKEN = "s3cret-api-token-1234";
const BASIC = `Basic ${Buffer.from(`${USER}:${TOKEN}`).toString("base64")}`;

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/jenkins/${name}`, import.meta.url), "utf8");
}
function json(name: string): unknown {
  return JSON.parse(fixture(name));
}

async function codeOf(p: Promise<unknown>): Promise<JenkinsErrorCode> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(JenkinsError);
    return (e as JenkinsError).code;
  }
  throw new Error("đáng lẽ phải ném JenkinsError");
}

describe("jobUrlPath", () => {
  it("folder và multibranch: mỗi đoạn một /job/", () => {
    expect(jobUrlPath("a/b/c")).toBe("/job/a/job/b/job/c");
    expect(jobUrlPath("ehospital/build-dev-v3")).toBe("/job/ehospital/job/build-dev-v3");
  });

  it("mã hoá từng đoạn", () => {
    expect(jobUrlPath("nhóm A/job 1")).toBe("/job/nh%C3%B3m%20A/job/job%201");
  });

  it("dạng mảng cho phép đoạn chứa dấu / (nhánh multibranch feature/x)", () => {
    expect(jobUrlPath(["app", "multi", "feature/x"])).toBe("/job/app/job/multi/job/feature%2Fx");
  });

  it("bỏ dấu / ở hai đầu", () => {
    expect(jobUrlPath("/a/b/")).toBe("/job/a/job/b");
  });

  it("từ chối đường dẫn rỗng hoặc đi lùi", () => {
    expect(() => jobUrlPath("")).toThrow(TypeError);
    expect(() => jobUrlPath("a//b")).toThrow(TypeError);
    expect(() => jobUrlPath("a/../b")).toThrow(TypeError);
    expect(() => jobUrlPath("./a")).toThrow(TypeError);
  });
});

describe("JenkinsClient", () => {
  let fake: FakeHttp;
  let client: ReturnType<typeof createJenkinsClient>;

  beforeEach(async () => {
    fake = await startFakeHttp();
    client = createJenkinsClient({ baseUrl: fake.baseUrl, user: USER, token: TOKEN });
  });
  afterEach(async () => {
    await fake.close();
  });

  describe("xác thực và địa chỉ", () => {
    it("gửi Basic user:token và Accept json", async () => {
      fake.route("GET /me/api/json", { json: json("me.json") });
      await client.me();
      const [req] = fake.requests;
      expect(req?.headers.authorization).toBe(BASIC);
      expect(req?.headers.accept).toContain("application/json");
    });

    it("giữ đường dẫn gốc của Jenkins (context path) và bỏ dấu / cuối", async () => {
      fake.route("GET /jenkins/me/api/json", { json: json("me.json") });
      const c = createJenkinsClient({ baseUrl: `${fake.baseUrl}/jenkins/`, user: USER, token: TOKEN });
      await expect(c.me()).resolves.toMatchObject({ id: "an.nguyen" });
    });

    it("dùng fetch được truyền vào", async () => {
      const seen: string[] = [];
      const c = createJenkinsClient({
        baseUrl: "https://jenkins.example.test",
        user: USER,
        token: TOKEN,
        fetch: async (input) => {
          seen.push(String(input));
          return new Response(fixture("me.json"), { headers: { "content-type": "application/json" } });
        },
      });
      await c.me();
      expect(seen).toEqual(["https://jenkins.example.test/me/api/json?tree=id%2CfullName%2CabsoluteUrl"]);
    });
  });

  describe("me", () => {
    it("trả id, tên và đường dẫn người dùng", async () => {
      fake.route("GET /me/api/json", { json: json("me.json") });
      await expect(client.me()).resolves.toEqual({
        id: "an.nguyen",
        fullName: "Nguyễn Văn An",
        url: "https://jenkins.example.test/user/an.nguyen",
      });
    });
  });

  describe("job", () => {
    it("đọc parameterDefinitions qua ?tree= và chuẩn hoá theo kiểu", async () => {
      fake.route("GET /job/ehospital/job/ehosPromote/api/json", { json: json("job-parameterized.json") });
      const job = await client.job("ehospital/ehosPromote");

      const tree = fake.requests[0]?.query.get("tree") ?? "";
      expect(tree).toContain("property[parameterDefinitions[");
      expect(job).toMatchObject({ name: "ehosPromote", fullName: "ehospital/ehosPromote", buildable: true });
      expect(job.parameters).toEqual([
        {
          name: "APP",
          kind: "string",
          type: "StringParameterDefinition",
          description: "Tên ứng dụng",
          default: "his-service",
          choices: null,
        },
        {
          name: "TO_ENV",
          kind: "choice",
          type: "ChoiceParameterDefinition",
          description: "Môi trường đích",
          default: "stg",
          choices: ["stg", "prod"],
        },
        {
          name: "DRY_RUN",
          kind: "boolean",
          type: "BooleanParameterDefinition",
          description: "",
          default: false,
          choices: null,
        },
        {
          name: "REGISTRY_PASSWORD",
          kind: "password",
          type: "PasswordParameterDefinition",
          description: "",
          default: null,
          choices: null,
        },
        {
          name: "NOTES",
          kind: "text",
          type: "TextParameterDefinition",
          description: "Ghi chú",
          default: "",
          choices: null,
        },
      ]);
    });

    it("job không có tham số thì parameters rỗng", async () => {
      fake.route("GET /job/keycloak-theme/api/json", { json: json("job-plain.json") });
      await expect(client.job("keycloak-theme")).resolves.toMatchObject({ parameters: [] });
    });

    it("kiểu tham số lạ thì kind là other, vẫn giữ type gốc", async () => {
      fake.route("GET /job/x/api/json", {
        json: {
          name: "x",
          fullName: "x",
          url: "https://j/job/x/",
          buildable: true,
          property: [
            {
              parameterDefinitions: [
                {
                  name: "GIT",
                  type: "GitParameterDefinition",
                  description: "",
                  defaultParameterValue: { value: "main" },
                },
              ],
            },
          ],
        },
      });
      const job = await client.job("x");
      expect(job.parameters[0]).toMatchObject({ kind: "other", type: "GitParameterDefinition", default: "main" });
    });
  });

  describe("builds", () => {
    it("liệt kê qua ?tree= có giới hạn {0,limit} và chuẩn hoá", async () => {
      fake.route("GET /job/ehospital/job/build-dev-v3/api/json", { json: json("builds.json") });
      const builds = await client.builds("ehospital/build-dev-v3", 5);

      const tree = fake.requests[0]?.query.get("tree") ?? "";
      expect(tree).toMatch(/^builds\[.*\]\{0,5\}$/);
      expect(tree).toContain("number,result,building,timestamp,duration");
      expect(tree).toContain("actions[");

      expect(builds).toHaveLength(2);
      expect(builds[0]).toEqual({
        number: 42,
        url: "https://jenkins.example.test/job/ehospital/job/build-dev-v3/42/",
        result: null,
        building: true,
        startedAt: 1792400000000,
        durationMs: 0,
        causes: [{ description: "Started by user Nguyễn Văn An", userId: "an.nguyen", userName: "Nguyễn Văn An" }],
        commit: { sha: "9947aeb1c0ffee00112233445566778899aabbcc", branch: "main" },
        // Tham số mật khẩu không có value nên bị bỏ.
        parameters: { BRANCH: "main", DRY_RUN: false },
      });
      expect(builds[1]).toMatchObject({
        number: 41,
        result: "FAILURE",
        building: false,
        durationMs: 185000,
        commit: null,
        causes: [{ description: "Started by an SCM change", userId: null, userName: null }],
        parameters: {},
      });
    });

    it("job chưa có build hoặc là folder thì mảng rỗng", async () => {
      fake.route("GET /job/f/api/json", { json: { _class: "com.cloudbees.hudson.plugins.folder.Folder" } });
      await expect(client.builds("f", 10)).resolves.toEqual([]);
    });

    it("limit phải là số nguyên dương", async () => {
      await expect(client.builds("a", 0)).rejects.toThrow(TypeError);
      await expect(client.builds("a", 1.5)).rejects.toThrow(TypeError);
      expect(fake.requests).toHaveLength(0);
    });
  });

  describe("getBuild", () => {
    it("đọc một build theo số", async () => {
      fake.route("GET /job/ehospital/job/build-dev-v3/40/api/json", { json: json("build-success.json") });
      const b = await client.getBuild("ehospital/build-dev-v3", 40);
      expect(fake.requests[0]?.query.get("tree")).toContain("number,result,building,timestamp,duration");
      expect(b).toMatchObject({
        number: 40,
        result: "SUCCESS",
        building: false,
        durationMs: 412345,
        // origin/ bị cắt khỏi tên nhánh, phần release/1.2 còn nguyên.
        commit: { sha: "1111111111111111111111111111111111111111", branch: "release/1.2" },
        causes: [{ userId: "binh.tran" }],
      });
    });

    it("không có build thì NOT_FOUND", async () => {
      fake.route("GET /job/a/9/api/json", { status: 404, body: "Not Found" });
      expect(await codeOf(client.getBuild("a", 9))).toBe("NOT_FOUND");
    });
  });

  describe("stages", () => {
    it("đọc giai đoạn từ wfapi/describe", async () => {
      fake.route("GET /job/a/job/b/42/wfapi/describe", { json: json("wfapi-describe.json") });
      await expect(client.stages("a/b", 42)).resolves.toEqual({
        status: "PAUSED_PENDING_INPUT",
        stages: [
          {
            id: "6",
            name: "Checkout",
            status: "SUCCESS",
            startedAt: 1792400000200,
            durationMs: 4000,
            pausedMs: 0,
            error: null,
          },
          {
            id: "12",
            name: "Trivy scan",
            status: "FAILED",
            startedAt: 1792400004200,
            durationMs: 61000,
            pausedMs: 0,
            error: "script returned exit code 1",
          },
          {
            id: "20",
            name: "Approve prod",
            status: "PAUSED_PENDING_INPUT",
            startedAt: 1792400065200,
            durationMs: 0,
            pausedMs: 30000,
            error: null,
          },
        ],
      });
    });

    it("404 (không có plugin Stage View hoặc job không phải pipeline) thì null", async () => {
      fake.route("GET /job/a/42/wfapi/describe", { status: 404, body: "" });
      await expect(client.stages("a", 42)).resolves.toBeNull();
    });

    it("lỗi khác 404 vẫn ném", async () => {
      fake.route("GET /job/a/42/wfapi/describe", { status: 401, body: "" });
      expect(await codeOf(client.stages("a", 42))).toBe("UNAUTHORIZED");
    });
  });

  describe("log", () => {
    it("đọc từ offset, trả offset kế tiếp và cờ còn dữ liệu", async () => {
      const text = fixture("progressive-log.txt");
      fake.route("GET /job/a/42/logText/progressiveText", {
        headers: {
          "x-text-size": String(Buffer.byteLength(text)),
          "x-more-data": "true",
          "content-type": "text/plain",
        },
        body: text,
      });
      const chunk = await client.log("a", 42, 0);
      expect(fake.requests[0]?.query.get("start")).toBe("0");
      expect(chunk).toEqual({ text, next: Buffer.byteLength(text), more: true });
      // Offset tính theo byte: tiếng Việt có dấu làm byte nhiều hơn ký tự.
      expect(Buffer.byteLength(text)).toBeGreaterThan(text.length);
    });

    it("build đã xong: không có X-More-Data", async () => {
      fake.route("GET /job/a/42/logText/progressiveText", { headers: { "x-text-size": "10" }, body: "hết\n" });
      await expect(client.log("a", 42, 6)).resolves.toEqual({ text: "hết\n", next: 10, more: false });
      expect(fake.requests[0]?.query.get("start")).toBe("6");
    });

    it("thiếu X-Text-Size thì tự cộng số byte đã nhận", async () => {
      fake.route("GET /job/a/42/logText/progressiveText", { body: "hết\n" });
      const chunk = await client.log("a", 42, 100);
      expect(chunk.next).toBe(100 + Buffer.byteLength("hết\n"));
    });

    it("start phải là số nguyên không âm", async () => {
      await expect(client.log("a", 1, -1)).rejects.toThrow(TypeError);
    });
  });

  describe("pendingInputs", () => {
    it("liệt kê bước input đang chờ", async () => {
      fake.route("GET /job/a/42/wfapi/pendingInputActions", { json: json("wfapi-pending-input-actions.json") });
      await expect(client.pendingInputs("a", 42)).resolves.toEqual([
        {
          id: "Approveprod",
          message: "Lên prod?",
          proceedText: "Duyệt",
          inputs: [{ name: "NOTE", type: "StringParameterDefinition", description: "Lý do" }],
        },
      ]);
    });

    it("404 thì không có bước nào chờ", async () => {
      fake.route("GET /job/a/42/wfapi/pendingInputActions", { status: 404, body: "" });
      await expect(client.pendingInputs("a", 42)).resolves.toEqual([]);
    });
  });

  describe("triggerBuild", () => {
    const QUEUE_LOCATION = { location: "https://jenkins.internal.example/queue/item/7001/" };

    it("có tham số: POST buildWithParameters, tham số nằm trong thân form, không nằm trên URL", async () => {
      fake.route("POST /job/ehospital/job/ehosPromote/buildWithParameters", { status: 201, headers: QUEUE_LOCATION });
      fake.route("GET /queue/item/7001/api/json", { json: json("queue-item-started.json") });

      const r = await client.triggerBuild("ehospital/ehosPromote", {
        APP: "his-service",
        TO_ENV: "prod",
        DRY_RUN: false,
      });

      const post = fake.callsTo("POST /job/ehospital/job/ehosPromote/buildWithParameters")[0];
      expect(post?.headers.authorization).toBe(BASIC);
      expect(post?.headers["content-type"]).toContain("application/x-www-form-urlencoded");
      expect(Object.fromEntries(new URLSearchParams(post?.body))).toEqual({
        APP: "his-service",
        TO_ENV: "prod",
        DRY_RUN: "false",
      });
      expect(post?.url).not.toContain("his-service");
      expect(r).toEqual({
        queueId: 7001,
        number: 43,
        url: "https://jenkins.example.test/job/ehospital/job/build-dev-v3/43/",
        cancelled: false,
      });
    });

    it("không truyền tham số: POST build", async () => {
      fake.route("POST /job/a/build", { status: 201, headers: QUEUE_LOCATION });
      fake.route("GET /queue/item/7001/api/json", { json: json("queue-item-started.json") });
      await client.triggerBuild("a");
      expect(fake.callsTo("POST /job/a/build")).toHaveLength(1);
      expect(fake.callsTo("POST /job/a/buildWithParameters")).toHaveLength(0);
    });

    it("truyền {} thì vẫn dùng buildWithParameters (lấy giá trị mặc định)", async () => {
      fake.route("POST /job/a/buildWithParameters", { status: 201, headers: QUEUE_LOCATION });
      fake.route("GET /queue/item/7001/api/json", { json: json("queue-item-started.json") });
      await client.triggerBuild("a", {});
      expect(fake.callsTo("POST /job/a/buildWithParameters")).toHaveLength(1);
    });

    it("đợi trong hàng đợi tới khi có số build, hỏi lại theo pollMs", async () => {
      fake.route("POST /job/a/build", { status: 201, headers: QUEUE_LOCATION });
      fake.route("GET /queue/item/7001/api/json", [
        { json: json("queue-item-waiting.json") },
        { json: json("queue-item-waiting.json") },
        { json: json("queue-item-started.json") },
      ]);
      const r = await client.triggerBuild("a", undefined, { pollMs: 5, waitMs: 2000 });
      expect(r.number).toBe(43);
      expect(fake.callsTo("GET /queue/item/7001/api/json")).toHaveLength(3);
    });

    it("hỏi queue item bằng địa chỉ của Hive, kể cả khi Location trỏ tới tên nội bộ", async () => {
      fake.route("POST /job/a/build", { status: 201, headers: QUEUE_LOCATION });
      fake.route("GET /queue/item/7001/api/json", { json: json("queue-item-started.json") });
      await client.triggerBuild("a");
      expect(fake.callsTo("GET /queue/item/7001/api/json")[0]?.headers.authorization).toBe(BASIC);
    });

    it("hết hạn chờ thì trả number null, không ném (build vẫn nằm trong hàng đợi)", async () => {
      fake.route("POST /job/a/build", { status: 201, headers: QUEUE_LOCATION });
      fake.route("GET /queue/item/7001/api/json", { json: json("queue-item-waiting.json") });
      const t0 = Date.now();
      const r = await client.triggerBuild("a", undefined, { pollMs: 5, waitMs: 60 });
      expect(r).toEqual({ queueId: 7001, number: null, url: null, cancelled: false });
      expect(Date.now() - t0).toBeLessThan(1500);
    });

    it("mục hàng đợi bị huỷ", async () => {
      fake.route("POST /job/a/build", { status: 201, headers: QUEUE_LOCATION });
      fake.route("GET /queue/item/7001/api/json", { json: json("queue-item-cancelled.json") });
      await expect(client.triggerBuild("a")).resolves.toEqual({
        queueId: 7001,
        number: null,
        url: null,
        cancelled: true,
      });
    });

    it("phản hồi thiếu Location thì UNAVAILABLE", async () => {
      fake.route("POST /job/a/build", { status: 201 });
      expect(await codeOf(client.triggerBuild("a"))).toBe("UNAVAILABLE");
    });

    it("Location không phải queue item thì UNAVAILABLE", async () => {
      fake.route("POST /job/a/build", { status: 201, headers: { location: "https://j/job/a/" } });
      expect(await codeOf(client.triggerBuild("a"))).toBe("UNAVAILABLE");
    });

    it("giá trị số được chuyển thành chuỗi", async () => {
      fake.route("POST /job/a/buildWithParameters", { status: 201, headers: QUEUE_LOCATION });
      fake.route("GET /queue/item/7001/api/json", { json: json("queue-item-started.json") });
      await client.triggerBuild("a", { BUILD: 12 });
      const body = fake.callsTo("POST /job/a/buildWithParameters")[0]?.body;
      expect(new URLSearchParams(body).get("BUILD")).toBe("12");
    });
  });

  describe("stop", () => {
    it("POST /stop; Jenkins trả 302 về trang build cũng là thành công", async () => {
      fake.route("POST /job/a/job/b/42/stop", { status: 302, headers: { location: "/job/a/job/b/42/" } });
      await expect(client.stop("a/b", 42)).resolves.toBeUndefined();
      expect(fake.callsTo("POST /job/a/job/b/42/stop")[0]?.headers.authorization).toBe(BASIC);
    });

    it("200 cũng được", async () => {
      fake.route("POST /job/a/42/stop", { status: 200 });
      await expect(client.stop("a", 42)).resolves.toBeUndefined();
    });
  });

  describe("input", () => {
    it("inputProceed không tham số", async () => {
      fake.route("POST /job/a/42/input/Approveprod/proceed", { status: 200 });
      await client.inputProceed("a", 42, "Approveprod");
      expect(fake.callsTo("POST /job/a/42/input/Approveprod/proceed")).toHaveLength(1);
    });

    it("inputProceed có tham số gửi json={parameter:[…]}", async () => {
      fake.route("POST /job/a/42/input/Approveprod/proceed", { status: 200 });
      await client.inputProceed("a", 42, "Approveprod", { NOTE: "đã xem", OK: true });
      const body = new URLSearchParams(fake.requests[0]?.body);
      expect(JSON.parse(body.get("json") ?? "")).toEqual({
        parameter: [
          { name: "NOTE", value: "đã xem" },
          { name: "OK", value: true },
        ],
      });
    });

    it("inputAbort", async () => {
      fake.route("POST /job/a/42/input/Approveprod/abort", { status: 302, headers: { location: "/job/a/42/" } });
      await expect(client.inputAbort("a", 42, "Approveprod")).resolves.toBeUndefined();
    });

    it("mã hoá id của input", async () => {
      fake.route("POST /job/a/42/input/A%20B%2FC/abort", { status: 200 });
      await client.inputAbort("a", 42, "A B/C");
      expect(fake.requests[0]?.pathname).toBe("/job/a/42/input/A%20B%2FC/abort");
    });
  });

  describe("lỗi", () => {
    const cases: Array<[number, JenkinsErrorCode, boolean]> = [
      [401, "UNAUTHORIZED", false],
      [403, "FORBIDDEN", false],
      [404, "NOT_FOUND", false],
      [500, "UNAVAILABLE", true],
      [502, "UNAVAILABLE", true],
      [503, "UNAVAILABLE", true],
      [429, "UNAVAILABLE", true],
      [400, "BAD_REQUEST", false],
      [409, "BAD_REQUEST", false],
    ];
    for (const [status, code, retryable] of cases) {
      it(`HTTP ${status} thành ${code}`, async () => {
        fake.route("GET /me/api/json", { status, body: "x" });
        const err = await client.me().then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(JenkinsError);
        expect((err as JenkinsError).code).toBe(code);
        expect((err as JenkinsError).status).toBe(status);
        expect((err as JenkinsError).retryable).toBe(retryable);
      });
    }

    it("403 do thiếu crumb tách riêng khỏi FORBIDDEN", async () => {
      fake.route("POST /job/a/build", {
        status: 403,
        headers: { "content-type": "text/html" },
        body: fixture("forbidden-crumb.txt"),
      });
      const err = await client.triggerBuild("a").then(
        () => null,
        (e: unknown) => e as JenkinsError,
      );
      expect(err?.code).toBe("CRUMB_REQUIRED");
      expect(err?.status).toBe(403);
    });

    it("thông báo tiếng Việt, có cách sửa", async () => {
      fake.route("GET /me/api/json", { status: 401, body: "" });
      const err = await client.me().then(
        () => null,
        (e: unknown) => e as JenkinsError,
      );
      expect(err?.message).toMatch(/token/i);
      expect(err?.message).toMatch(/Jenkins/);
    });

    it("chuyển hướng về trang đăng nhập khi đọc: UNAUTHORIZED", async () => {
      fake.route("GET /me/api/json", { status: 302, headers: { location: "/login?from=%2Fme%2Fapi%2Fjson" } });
      expect(await codeOf(client.me())).toBe("UNAUTHORIZED");
    });

    it("200 nhưng không phải JSON (trang đăng nhập HTML) thì UNAVAILABLE", async () => {
      fake.route("GET /me/api/json", { headers: { "content-type": "text/html" }, body: "<html>login</html>" });
      expect(await codeOf(client.me())).toBe("UNAVAILABLE");
    });

    it("hết giờ thì UNAVAILABLE", async () => {
      fake.route("GET /me/api/json", { json: json("me.json"), delayMs: 400 });
      const c = createJenkinsClient({ baseUrl: fake.baseUrl, user: USER, token: TOKEN, timeoutMs: 50 });
      const err = await c.me().then(
        () => null,
        (e: unknown) => e as JenkinsError,
      );
      expect(err?.code).toBe("UNAVAILABLE");
      expect(err?.retryable).toBe(true);
    });

    it("không kết nối được thì UNAVAILABLE", async () => {
      const c = createJenkinsClient({ baseUrl: "http://127.0.0.1:1", user: USER, token: TOKEN, timeoutMs: 2000 });
      expect(await codeOf(c.me())).toBe("UNAVAILABLE");
    });

    it("lỗi không chứa token hay header Authorization", async () => {
      fake.route("GET /me/api/json", { status: 401, body: "Unauthorized" });
      const err = (await client.me().then(
        () => null,
        (e: unknown) => e,
      )) as JenkinsError;
      const dump = `${err.message} ${err.stack ?? ""} ${JSON.stringify(err)} ${String(err.cause ?? "")}`;
      expect(dump).not.toContain(TOKEN);
      expect(dump).not.toContain(Buffer.from(`${USER}:${TOKEN}`).toString("base64"));
      expect(dump.toLowerCase()).not.toContain("authorization");
    });

    it("lỗi mạng cũng không lộ token", async () => {
      const c = createJenkinsClient({ baseUrl: "http://127.0.0.1:1", user: USER, token: TOKEN, timeoutMs: 2000 });
      const err = (await c.me().then(
        () => null,
        (e: unknown) => e,
      )) as JenkinsError;
      const dump = `${err.message} ${err.stack ?? ""} ${JSON.stringify(err)} ${String(err.cause ?? "")}`;
      expect(dump).not.toContain(TOKEN);
    });
  });
});
