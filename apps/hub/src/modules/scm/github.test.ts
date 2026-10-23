import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GitProviderError } from "./errors.ts";
import { createGitHubProvider } from "./github.ts";
import { JSON_HEADERS, mockHttp } from "./mock-http.ts";
import type { GitProvider } from "./types.ts";

const API = "https://api.github.com";
const ref = { owner: "acme", name: "web" };
const marker = "hive:prj_1";

let privateKey: string;
beforeAll(() => {
  // Khoá thật để Octokit ký được JWT của App; không gửi đi đâu ngoài MockAgent.
  privateKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
});

let http: ReturnType<typeof mockHttp>;
afterEach(async () => {
  http.agent.assertNoPendingInterceptors();
  await http.agent.close();
});

function setup(): { gh: GitProvider; pool: ReturnType<ReturnType<typeof mockHttp>["agent"]["get"]> } {
  http = mockHttp();
  const pool = http.agent.get(API);
  pool
    .intercept({ path: "/app/installations/42/access_tokens", method: "POST" })
    .reply(
      201,
      { token: "ghs_test", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {} },
      JSON_HEADERS,
    );
  return { gh: createGitHubProvider({ appId: 1, privateKey, installationId: 42, fetch: http.fetch }), pool };
}

function repo(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    name: "web",
    owner: { login: "acme" },
    default_branch: "main",
    private: true,
    visibility: "private",
    description: `Web [${marker}]`,
    clone_url: "https://github.com/acme/web.git",
    ssh_url: "git@github.com:acme/web.git",
    html_url: "https://github.com/acme/web",
    ...over,
  };
}

async function rejected(p: Promise<unknown>): Promise<GitProviderError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(GitProviderError);
  return e as GitProviderError;
}

describe("GitHub checkAccess", () => {
  it("đủ quyền trong org đã cài App", async () => {
    http = mockHttp();
    const pool = http.agent.get(API);
    pool.intercept({ path: "/app/installations/42", method: "GET" }).reply(
      200,
      {
        account: { login: "Acme", type: "Organization" },
        permissions: { administration: "write", contents: "write", pull_requests: "write", repository_hooks: "write" },
      },
      JSON_HEADERS,
    );
    const gh = createGitHubProvider({ appId: 1, privateKey, installationId: 42, fetch: http.fetch });
    expect(await gh.checkAccess("acme")).toEqual({ canCreate: true, missingScopes: [] });
  });

  it("báo quyền thiếu và owner chưa cài App", async () => {
    http = mockHttp();
    http.agent
      .get(API)
      .intercept({ path: "/app/installations/42", method: "GET" })
      .reply(
        200,
        {
          account: { login: "other", type: "Organization" },
          permissions: { contents: "read", pull_requests: "write" },
        },
        JSON_HEADERS,
      );
    const gh = createGitHubProvider({ appId: 1, privateKey, installationId: 42, fetch: http.fetch });
    expect(await gh.checkAccess("acme")).toEqual({
      canCreate: false,
      missingScopes: ["installation:acme", "administration:write", "contents:write", "repository_hooks:write"],
    });
  });
});

describe("GitHub getRepo", () => {
  it("trả thông tin repo", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/repos/acme/web", method: "GET" }).reply(200, repo(), JSON_HEADERS);
    expect(await gh.getRepo(ref)).toEqual({
      id: "7",
      owner: "acme",
      name: "web",
      defaultBranch: "main",
      visibility: "private",
      description: `Web [${marker}]`,
      httpUrl: "https://github.com/acme/web.git",
      sshUrl: "git@github.com:acme/web.git",
      webUrl: "https://github.com/acme/web",
    });
  });

  it("404 thì trả null", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/repos/acme/web", method: "GET" }).reply(404, { message: "Not Found" }, JSON_HEADERS);
    expect(await gh.getRepo(ref)).toBeNull();
  });

  it("App chưa cài thì báo unauthorized, không coi là repo không có", async () => {
    http = mockHttp();
    http.agent
      .get(API)
      .intercept({ path: "/app/installations/42/access_tokens", method: "POST" })
      .reply(404, { message: "Not Found" }, JSON_HEADERS);
    const gh = createGitHubProvider({ appId: 1, privateKey, installationId: 42, fetch: http.fetch });
    expect((await rejected(gh.getRepo(ref))).code).toBe("unauthorized");
  });
});

describe("GitHub createRepo", () => {
  const input = { ...ref, visibility: "private" as const, defaultBranch: "main", description: "Web", marker };

  it("tạo repo mới kèm dấu hiệu và commit đầu", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/repos/acme/web", method: "GET" }).reply(404, { message: "Not Found" }, JSON_HEADERS);
    pool.intercept({ path: "/orgs/acme/repos", method: "POST" }).reply(201, http.json(repo()), JSON_HEADERS);
    const r = await gh.createRepo(input);
    expect(r.id).toBe("7");
    expect(http.calls[0]?.body).toEqual({
      name: "web",
      description: `Web [${marker}]`,
      visibility: "private",
      auto_init: true,
    });
  });

  it("đổi tên nhánh mặc định cho khớp yêu cầu", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/repos/acme/web", method: "GET" }).reply(404, { message: "Not Found" }, JSON_HEADERS);
    pool
      .intercept({ path: "/orgs/acme/repos", method: "POST" })
      .reply(201, repo({ default_branch: "master" }), JSON_HEADERS);
    pool
      .intercept({ path: "/repos/acme/web/branches/master/rename", method: "POST" })
      .reply(201, http.json({ name: "main" }), JSON_HEADERS);
    expect((await gh.createRepo(input)).defaultBranch).toBe("main");
    expect(http.calls[0]?.body).toEqual({ new_name: "main" });
  });

  it("repo đã có cùng dấu hiệu thì trả lại, không tạo mới", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/repos/acme/web", method: "GET" }).reply(200, repo(), JSON_HEADERS);
    expect((await gh.createRepo(input)).id).toBe("7");
  });

  it("repo đã có nhưng không do Hive tạo thì conflict", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/repos/acme/web", method: "GET" }).reply(200, repo({ description: "khác" }), JSON_HEADERS);
    expect((await rejected(gh.createRepo(input))).code).toBe("conflict");
  });

  it("thua cuộc đua tạo repo (422) thì đọc lại repo", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/repos/acme/web", method: "GET" }).reply(404, { message: "Not Found" }, JSON_HEADERS);
    pool
      .intercept({ path: "/orgs/acme/repos", method: "POST" })
      .reply(422, { message: "name already exists on this account" }, JSON_HEADERS);
    pool.intercept({ path: "/repos/acme/web", method: "GET" }).reply(200, repo(), JSON_HEADERS);
    expect((await gh.createRepo(input)).id).toBe("7");
  });
});

describe("GitHub commitFiles", () => {
  const files = [
    { path: "AGENTS.md", content: "# A" },
    { path: ".mcp.json", content: "{}" },
  ];

  it("nhánh đã có: một tree, một commit, cập nhật ref không force", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: "/repos/acme/web/git/ref/heads/main", method: "GET" })
      .reply(200, { object: { sha: "p1" } }, JSON_HEADERS);
    pool
      .intercept({ path: "/repos/acme/web/git/commits/p1", method: "GET" })
      .reply(200, { tree: { sha: "t0" } }, JSON_HEADERS);
    pool
      .intercept({ path: "/repos/acme/web/git/trees", method: "POST" })
      .reply(201, http.json({ sha: "t1" }), JSON_HEADERS);
    pool
      .intercept({ path: "/repos/acme/web/git/commits", method: "POST" })
      .reply(201, http.json({ sha: "c1" }), JSON_HEADERS);
    pool
      .intercept({ path: "/repos/acme/web/git/refs/heads/main", method: "PATCH" })
      .reply(200, http.json({ object: { sha: "c1" } }), JSON_HEADERS);
    expect(await gh.commitFiles(ref, { branch: "main", message: "init", files })).toEqual({ sha: "c1" });
    expect(http.calls.map((c) => c.body)).toEqual([
      {
        base_tree: "t0",
        tree: [
          { path: "AGENTS.md", mode: "100644", type: "blob", content: "# A" },
          { path: ".mcp.json", mode: "100644", type: "blob", content: "{}" },
        ],
      },
      { message: "init", tree: "t1", parents: ["p1"] },
      { sha: "c1", force: false },
    ]);
  });

  it("nhánh mới có dấu /: tạo từ fromBranch", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: "/repos/acme/web/git/ref/heads/ai/t-1", method: "GET" })
      .reply(404, { message: "Not Found" }, JSON_HEADERS);
    pool
      .intercept({ path: "/repos/acme/web/git/ref/heads/main", method: "GET" })
      .reply(200, { object: { sha: "p1" } }, JSON_HEADERS);
    pool
      .intercept({ path: "/repos/acme/web/git/commits/p1", method: "GET" })
      .reply(200, { tree: { sha: "t0" } }, JSON_HEADERS);
    pool.intercept({ path: "/repos/acme/web/git/trees", method: "POST" }).reply(201, { sha: "t1" }, JSON_HEADERS);
    pool.intercept({ path: "/repos/acme/web/git/commits", method: "POST" }).reply(201, { sha: "c2" }, JSON_HEADERS);
    pool.intercept({ path: "/repos/acme/web/git/refs", method: "POST" }).reply(201, http.json({}), JSON_HEADERS);
    const out = await gh.commitFiles(ref, { branch: "ai/t-1", fromBranch: "main", message: "m", files });
    expect(out.sha).toBe("c2");
    expect(http.calls[0]?.body).toEqual({ ref: "refs/heads/ai/t-1", sha: "c2" });
  });

  it("nhánh không có và không có fromBranch thì not_found", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: "/repos/acme/web/git/ref/heads/dev", method: "GET" })
      .reply(404, { message: "Not Found" }, JSON_HEADERS);
    expect((await rejected(gh.commitFiles(ref, { branch: "dev", message: "m", files }))).code).toBe("not_found");
  });

  it("repo rỗng (409) thì conflict", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: "/repos/acme/web/git/ref/heads/main", method: "GET" })
      .reply(409, { message: "Git Repository is empty." }, JSON_HEADERS);
    const e = await rejected(gh.commitFiles(ref, { branch: "main", message: "m", files }));
    expect(e.code).toBe("conflict");
    expect(e.status).toBe(409);
  });
});

describe("GitHub protectBranch", () => {
  it("gửi luật bảo vệ nhánh", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: "/repos/acme/web/branches/main/protection", method: "PUT" })
      .reply(200, http.json({}), JSON_HEADERS);
    await gh.protectBranch(ref, "main", {
      requirePullRequest: true,
      requiredApprovals: 1,
      allowForcePush: false,
      requiredChecks: ["ci"],
    });
    expect(http.calls[0]?.body).toEqual({
      required_status_checks: { strict: true, contexts: ["ci"] },
      enforce_admins: false,
      required_pull_request_reviews: { required_approving_review_count: 1 },
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false,
    });
  });

  it("gói không hỗ trợ bảo vệ nhánh (403) thì forbidden", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: "/repos/acme/web/branches/main/protection", method: "PUT" })
      .reply(403, { message: "Upgrade to GitHub Pro or make this repository public" }, JSON_HEADERS);
    const e = await rejected(
      gh.protectBranch(ref, "main", { requirePullRequest: true, requiredApprovals: 0, allowForcePush: false }),
    );
    expect(e.code).toBe("forbidden");
    expect(e.retryAfterMs).toBeNull();
  });
});

describe("GitHub openPR", () => {
  const input = { head: "ai/t-1", base: "main", title: "T", body: "B", labels: ["hive"] };

  it("mở PR rồi gắn nhãn", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: "/repos/acme/web/pulls", method: "POST" })
      .reply(201, http.json({ number: 5, html_url: "https://github.com/acme/web/pull/5" }), JSON_HEADERS);
    pool.intercept({ path: "/repos/acme/web/issues/5/labels", method: "POST" }).reply(200, http.json([]), JSON_HEADERS);
    expect(await gh.openPR(ref, input)).toEqual({ number: 5, url: "https://github.com/acme/web/pull/5" });
    expect(http.calls.map((c) => c.body)).toEqual([
      { head: "ai/t-1", base: "main", title: "T", body: "B", draft: false },
      { labels: ["hive"] },
    ]);
  });

  it("PR đã mở (422) thì trả lại PR đó", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: "/repos/acme/web/pulls", method: "POST" })
      .reply(422, { message: "A pull request already exists for acme:ai/t-1." }, JSON_HEADERS);
    pool
      .intercept({ path: "/repos/acme/web/pulls?head=acme%3Aai%2Ft-1&base=main&state=open", method: "GET" })
      .reply(200, [{ number: 4, html_url: "https://github.com/acme/web/pull/4" }], JSON_HEADERS);
    pool.intercept({ path: "/repos/acme/web/issues/4/labels", method: "POST" }).reply(200, [], JSON_HEADERS);
    expect((await gh.openPR(ref, input)).number).toBe(4);
  });
});

describe("GitHub commentOnIssue", () => {
  it("bình luận vào issue; PR dùng cùng API của issue", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: "/repos/acme/web/issues/12/comments", method: "POST" })
      .reply(
        201,
        http.json({ id: 901, html_url: "https://github.com/acme/web/issues/12#issuecomment-901" }),
        JSON_HEADERS,
      );
    pool
      .intercept({ path: "/repos/acme/web/issues/5/comments", method: "POST" })
      .reply(201, http.json({ id: 902 }), JSON_HEADERS);
    expect(await gh.commentOnIssue(ref, 12, "Đã tạo task HD-3")).toEqual({ id: "901" });
    expect(await gh.commentOnIssue(ref, 5, "Đã nhận", { pullRequest: true })).toEqual({ id: "902" });
    expect(http.calls.map((c) => c.body)).toEqual([{ body: "Đã tạo task HD-3" }, { body: "Đã nhận" }]);
  });

  it("thiếu quyền issues (403) thì báo lỗi forbidden", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: "/repos/acme/web/issues/12/comments", method: "POST" })
      .reply(403, { message: "Resource not accessible by integration" }, JSON_HEADERS);
    expect((await rejected(gh.commentOnIssue(ref, 12, "x"))).code).toBe("forbidden");
  });
});

describe("GitHub canPush", () => {
  const path = (u: string) => `/repos/acme/web/collaborators/${u}/permission`;

  it("write, admin (maintain gộp vào write) thì push được; read (triage gộp vào read) thì không", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: path("lan"), method: "GET" }).reply(200, { permission: "write" }, JSON_HEADERS);
    pool.intercept({ path: path("chu"), method: "GET" }).reply(200, { permission: "admin" }, JSON_HEADERS);
    pool.intercept({ path: path("khach"), method: "GET" }).reply(200, { permission: "read" }, JSON_HEADERS);
    expect(await gh.canPush(ref, { login: "lan", id: 1 })).toBe(true);
    expect(await gh.canPush(ref, { login: "chu", id: 2 })).toBe(true);
    expect(await gh.canPush(ref, { login: "khach", id: 3 })).toBe(false);
  });

  it("không phải cộng tác viên (404) hoặc thiếu login thì false, không gọi API khi thiếu login", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: path("nguoi-la"), method: "GET" }).reply(404, { message: "is not a user" }, JSON_HEADERS);
    expect(await gh.canPush(ref, { login: "nguoi-la", id: 9 })).toBe(false);
    const before = http.calls.length;
    expect(await gh.canPush(ref, { login: null, id: 9 })).toBe(false);
    expect(http.calls.length).toBe(before);
  });

  it("hết hạn mức thì ném lỗi để người gọi thử lại", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: path("lan"), method: "GET" })
      .reply(429, { message: "rate limit" }, { headers: { ...JSON_HEADERS.headers, "retry-after": "30" } });
    expect((await rejected(gh.canPush(ref, { login: "lan", id: 1 }))).code).toBe("rate_limited");
  });
});

describe("GitHub PR cho merge queue", () => {
  const PULL = "/repos/acme/web/pulls/5";
  const sha = "a".repeat(40);
  const pull = (over: Record<string, unknown> = {}) => ({
    number: 5,
    html_url: "https://github.com/acme/web/pull/5",
    state: "open",
    merged: false,
    draft: false,
    head: { ref: "ai/t-1", sha },
    base: { ref: "main" },
    mergeable: true,
    mergeable_state: "clean",
    ...over,
  });

  it("getPR đọc trạng thái PR", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: PULL, method: "GET" }).reply(200, pull(), JSON_HEADERS);
    expect(await gh.getPR(ref, 5)).toEqual({
      number: 5,
      url: "https://github.com/acme/web/pull/5",
      state: "open",
      draft: false,
      head: "ai/t-1",
      headSha: sha,
      base: "main",
      mergeable: "clean",
    });
  });

  it.each([
    [{ mergeable_state: "clean" }, "clean"],
    [{ mergeable_state: "unstable" }, "clean"],
    [{ mergeable_state: "has_hooks" }, "clean"],
    [{ mergeable_state: "behind" }, "behind"],
    [{ mergeable: false, mergeable_state: "dirty" }, "conflict"],
    [{ mergeable_state: "blocked" }, "blocked"],
    [{ mergeable_state: "draft" }, "blocked"],
    [{ mergeable_state: "unknown" }, "unknown"],
    [{ mergeable: null, mergeable_state: "unknown" }, "unknown"],
    [{ mergeable: true, mergeable_state: "la" }, "clean"],
    [{ mergeable: false, mergeable_state: "la" }, "conflict"],
  ])("%j → %s", async (fields, mergeable) => {
    const { gh, pool } = setup();
    pool.intercept({ path: PULL, method: "GET" }).reply(200, pull(fields), JSON_HEADERS);
    expect((await gh.getPR(ref, 5))?.mergeable).toBe(mergeable);
  });

  it("merged, closed, không có PR", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: PULL, method: "GET" }).reply(200, pull({ state: "closed", merged: true }), JSON_HEADERS);
    pool.intercept({ path: PULL, method: "GET" }).reply(200, pull({ state: "closed" }), JSON_HEADERS);
    pool.intercept({ path: PULL, method: "GET" }).reply(404, { message: "Not Found" }, JSON_HEADERS);
    expect((await gh.getPR(ref, 5))?.state).toBe("merged");
    expect((await gh.getPR(ref, 5))?.state).toBe("closed");
    expect(await gh.getPR(ref, 5)).toBeNull();
  });

  it("updatePRBranch gửi expected_head_sha; 422 là conflict", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: `${PULL}/update-branch`, method: "PUT" })
      .reply(202, http.json({ message: "Updating pull request branch." }), JSON_HEADERS);
    pool
      .intercept({ path: `${PULL}/update-branch`, method: "PUT" })
      .reply(422, { message: "merge conflict between base and head" }, JSON_HEADERS);
    await gh.updatePRBranch(ref, 5, sha);
    expect(http.calls[0]?.body).toEqual({ expected_head_sha: sha });
    expect((await rejected(gh.updatePRBranch(ref, 5, sha))).code).toBe("conflict");
  });

  const STATUS = `/repos/acme/web/commits/${sha}/status`;
  const RUNS = `/repos/acme/web/commits/${sha}/check-runs?per_page=100`;
  it.each([
    [{ state: "pending", total_count: 0 }, [], "none"],
    [{ state: "success", total_count: 1 }, [], "success"],
    [{ state: "pending", total_count: 1 }, [], "pending"],
    [{ state: "failure", total_count: 2 }, [], "failure"],
    [{ state: "pending", total_count: 0 }, [{ status: "completed", conclusion: "success" }], "success"],
    [{ state: "pending", total_count: 0 }, [{ status: "completed", conclusion: "skipped" }], "success"],
    [{ state: "pending", total_count: 0 }, [{ status: "in_progress", conclusion: null }], "pending"],
    [{ state: "success", total_count: 1 }, [{ status: "completed", conclusion: "timed_out" }], "failure"],
    [
      { state: "success", total_count: 1 },
      [
        { status: "queued", conclusion: null },
        { status: "completed", conclusion: "cancelled" },
      ],
      "failure",
    ],
  ])("checksFor status %j, check run %j → %s", async (status, checkRuns, state) => {
    const { gh, pool } = setup();
    pool.intercept({ path: STATUS, method: "GET" }).reply(200, status, JSON_HEADERS);
    pool.intercept({ path: RUNS, method: "GET" }).reply(200, { check_runs: checkRuns }, JSON_HEADERS);
    expect(await gh.checksFor(ref, sha)).toBe(state);
  });

  it.each([
    [[], "none"],
    [[{ context: "ci/test", state: "success" }], "success"],
    [[{ context: "ci/test", state: "failure" }], "failure"],
    [[{ context: "ci/test", state: "pending" }], "pending"],
  ])("checkpoint CI bỏ qua status của phiên review, giữ CI khác %j → %s", async (other, state) => {
    const { gh, pool } = setup();
    pool.intercept({ path: `${STATUS}?per_page=100&page=1`, method: "GET" }).reply(
      200,
      {
        state: "pending",
        total_count: other.length + 1,
        statuses: [{ context: "xdev-hive/review", state: "pending" }, ...other],
      },
      JSON_HEADERS,
    );
    pool.intercept({ path: RUNS, method: "GET" }).reply(200, { check_runs: [] }, JSON_HEADERS);
    expect(await gh.checksFor(ref, sha, { excludeContexts: ["xdev-hive/review"] })).toBe(state);
  });

  it("mergePR gửi cách merge và sha", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: `${PULL}/merge`, method: "PUT" })
      .reply(200, http.json({ sha: "m".repeat(40), merged: true }), JSON_HEADERS);
    expect(await gh.mergePR(ref, 5, { method: "rebase", sha })).toEqual({ sha: "m".repeat(40) });
    expect(http.calls[0]?.body).toEqual({ merge_method: "rebase", sha });
  });

  it.each([
    [405, "conflict"],
    [409, "conflict"],
    [422, "invalid"],
    [429, "rate_limited"],
  ] as const)("mergePR lỗi %i → %s", async (status, code) => {
    const { gh, pool } = setup();
    pool.intercept({ path: `${PULL}/merge`, method: "PUT" }).reply(status, { message: "x" }, JSON_HEADERS);
    const e = await rejected(gh.mergePR(ref, 5, { method: "squash", sha }));
    expect(e.code).toBe(code);
    expect(e.status).toBe(status);
  });
});

describe("GitHub webhook", () => {
  const input = {
    url: "https://hive.example/hooks/git",
    secret: "s3",
    events: ["push" as const, "pull_request" as const],
  };
  const config = { url: input.url, secret: "s3", content_type: "json", insecure_ssl: "0" };

  it("tạo webhook mới", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/repos/acme/web/hooks?per_page=100", method: "GET" }).reply(200, [], JSON_HEADERS);
    pool.intercept({ path: "/repos/acme/web/hooks", method: "POST" }).reply(201, http.json({ id: 99 }), JSON_HEADERS);
    expect(await gh.addWebhook(ref, input)).toEqual({ id: "99" });
    expect(http.calls[0]?.body).toEqual({ name: "web", active: true, events: ["push", "pull_request"], config });
  });

  it("webhook cùng URL đã có thì cập nhật", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: "/repos/acme/web/hooks?per_page=100", method: "GET" })
      .reply(200, [{ id: 3, config: { url: input.url } }], JSON_HEADERS);
    pool.intercept({ path: "/repos/acme/web/hooks/3", method: "PATCH" }).reply(200, http.json({ id: 3 }), JSON_HEADERS);
    expect(await gh.addWebhook(ref, input)).toEqual({ id: "3" });
    expect(http.calls[0]?.body).toEqual({ active: true, events: ["push", "pull_request"], config });
  });

  it("xoá webhook; không còn (404) cũng coi là xong", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/repos/acme/web/hooks/3", method: "DELETE" }).reply(204, "");
    pool
      .intercept({ path: "/repos/acme/web/hooks/4", method: "DELETE" })
      .reply(404, { message: "Not Found" }, JSON_HEADERS);
    await gh.removeWebhook(ref, "3");
    await gh.removeWebhook(ref, "4");
  });
});

describe("GitHub lỗi HTTP", () => {
  // 401 với token cài đặt mới tạo bị auth-app thử lại vài giây (chờ token đồng bộ), nên kiểm 401 qua JWT của App.
  it("401 → unauthorized", async () => {
    http = mockHttp();
    http.agent
      .get(API)
      .intercept({ path: "/app/installations/42", method: "GET" })
      .reply(401, { message: "Bad credentials" }, JSON_HEADERS);
    const gh = createGitHubProvider({ appId: 1, privateKey, installationId: 42, fetch: http.fetch });
    const e = await rejected(gh.checkAccess("acme"));
    expect(e.code).toBe("unauthorized");
    expect(e.status).toBe(401);
  });

  it("đổi token cài đặt bị 401 → unauthorized", async () => {
    http = mockHttp();
    http.agent
      .get(API)
      .intercept({ path: "/app/installations/42/access_tokens", method: "POST" })
      .reply(401, { message: "A JSON web token could not be decoded" }, JSON_HEADERS);
    const gh = createGitHubProvider({ appId: 1, privateKey, installationId: 42, fetch: http.fetch });
    expect((await rejected(gh.getRepo(ref))).code).toBe("unauthorized");
  });

  it.each([
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [422, "invalid"],
    [500, "unavailable"],
  ] as const)("%i → %s", async (status, code) => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: "/repos/acme/web/hooks?per_page=100", method: "GET" })
      .reply(status, { message: "x" }, JSON_HEADERS);
    const e = await rejected(gh.addWebhook(ref, { url: "u", secret: "s", events: ["push"] }));
    expect(e.code).toBe(code);
    expect(e.status).toBe(status);
  });

  it("429 đọc Retry-After", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: "/repos/acme/web", method: "GET" })
      .reply(429, { message: "slow down" }, { headers: { ...JSON_HEADERS.headers, "retry-after": "30" } });
    const e = await rejected(gh.getRepo(ref));
    expect(e.code).toBe("rate_limited");
    expect(e.retryAfterMs).toBe(30_000);
    expect(e.retryable).toBe(true);
  });

  it("403 hết hạn mức chính đọc x-ratelimit-reset", async () => {
    const { gh, pool } = setup();
    const reset = Math.ceil(Date.now() / 1000) + 60;
    pool.intercept({ path: "/repos/acme/web", method: "GET" }).reply(
      403,
      { message: "API rate limit exceeded" },
      {
        headers: { ...JSON_HEADERS.headers, "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
      },
    );
    const e = await rejected(gh.getRepo(ref));
    expect(e.code).toBe("rate_limited");
    expect(e.retryAfterMs).toBeGreaterThan(55_000);
    expect(e.retryAfterMs).toBeLessThanOrEqual(61_000);
  });

  it("403 hạn mức phụ kèm Retry-After", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: "/repos/acme/web", method: "GET" })
      .reply(
        403,
        { message: "You have exceeded a secondary rate limit" },
        { headers: { ...JSON_HEADERS.headers, "retry-after": "5" } },
      );
    const e = await rejected(gh.getRepo(ref));
    expect(e.code).toBe("rate_limited");
    expect(e.retryAfterMs).toBe(5_000);
  });
});

describe("GitHub đọc cây và file (kho skill)", () => {
  it("liệt kê file của commit, bỏ thư mục; cây bị cắt thì duyệt từng cây con", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/repos/acme/web/git/trees/abc?recursive=1", method: "GET" }).reply(
      200,
      {
        truncated: false,
        tree: [
          { path: "org", type: "tree" },
          { path: "org/review/SKILL.md", type: "blob" },
        ],
      },
      JSON_HEADERS,
    );
    expect(await gh.listFiles(ref, "abc")).toEqual(["org/review/SKILL.md"]);
    pool
      .intercept({ path: "/repos/acme/web/git/trees/big?recursive=1", method: "GET" })
      .reply(200, { truncated: true, tree: [] }, JSON_HEADERS);
    pool
      .intercept({ path: "/repos/acme/web/git/commits/big", method: "GET" })
      .reply(200, { tree: { sha: "tree-big" } }, JSON_HEADERS);
    pool
      .intercept({ path: "/repos/acme/web/git/trees/tree-big", method: "GET" })
      .reply(200, { truncated: false, tree: [{ path: "nested", type: "tree", sha: "tree-nested" }] }, JSON_HEADERS);
    pool
      .intercept({ path: "/repos/acme/web/git/trees/tree-nested", method: "GET" })
      .reply(200, { truncated: false, tree: [{ path: "a.md", type: "blob", sha: "blob-a" }] }, JSON_HEADERS);
    await expect(gh.listFiles(ref, "big")).resolves.toEqual(["nested/a.md"]);
  });

  it("đọc file base64 theo commit; không có file thì null", async () => {
    const { gh, pool } = setup();
    const body = "---\nname: review\n---\nĐọc kỹ diff.\n";
    pool
      .intercept({ path: "/repos/acme/web/contents/org/review/SKILL.md?ref=abc", method: "GET" })
      .reply(200, { encoding: "base64", content: Buffer.from(body).toString("base64") }, JSON_HEADERS);
    expect(await gh.readFile(ref, "org/review/SKILL.md", "abc")).toBe(body);
    pool
      .intercept({ path: "/repos/acme/web/contents/org/none/SKILL.md?ref=abc", method: "GET" })
      .reply(404, { message: "Not Found" }, JSON_HEADERS);
    expect(await gh.readFile(ref, "org/none/SKILL.md", "abc")).toBeNull();
  });

  it("đóng PR đang mở, bỏ qua PR đã đóng", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: "/repos/acme/web/pulls/5", method: "GET" })
      .reply(200, { number: 5, html_url: "u", state: "open", merged: false }, JSON_HEADERS);
    pool.intercept({ path: "/repos/acme/web/pulls/5", method: "PATCH" }).reply(200, { number: 5 }, JSON_HEADERS);
    await gh.closePR(ref, 5);
    pool
      .intercept({ path: "/repos/acme/web/pulls/6", method: "GET" })
      .reply(200, { number: 6, html_url: "u", state: "closed", merged: false }, JSON_HEADERS);
    await gh.closePR(ref, 6);
  });

  describe("prFiles", () => {
    const ghFile = (i: number) => ({
      filename: `f${i}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "@@ -1 +1 @@",
    });

    it("đổi lược đồ GitHub: đổi tên, xoá, nhị phân, file bị bỏ patch", async () => {
      const { gh, pool } = setup();
      const fixture = JSON.parse(readFileSync(new URL("./fixtures/github/pull_files.json", import.meta.url), "utf8"));
      pool
        .intercept({ path: "/repos/acme/web/pulls/5/files?per_page=100&page=1", method: "GET" })
        .reply(200, fixture, JSON_HEADERS);
      const files = await gh.prFiles(ref, 5);
      expect(files?.map((f) => [f.path, f.status, f.truncated])).toEqual([
        ["file1.txt", "added", false],
        ["src/new-name.ts", "renamed", false],
        ["docs/huge.json", "modified", true],
        ["assets/logo.png", "modified", false],
        ["old.txt", "removed", false],
      ]);
      expect(files?.[1]).toMatchObject({ previousPath: "src/old-name.ts", additions: 1, deletions: 1 });
      expect(files?.[2]).not.toHaveProperty("patch");
      expect(files?.[3]).not.toHaveProperty("patch");
      expect(files?.[4]?.patch).toBe("@@ -1,2 +0,0 @@\n-một\n-hai");
    });

    it("đọc hết các trang; trang ngắn là trang cuối", async () => {
      const { gh, pool } = setup();
      pool.intercept({ path: "/repos/acme/web/pulls/5/files?per_page=100&page=1", method: "GET" }).reply(
        200,
        Array.from({ length: 100 }, (_, i) => ghFile(i)),
        JSON_HEADERS,
      );
      pool
        .intercept({ path: "/repos/acme/web/pulls/5/files?per_page=100&page=2", method: "GET" })
        .reply(200, [ghFile(100), ghFile(101)], JSON_HEADERS);
      expect(await gh.prFiles(ref, 5)).toHaveLength(102);
    });

    it("dừng ở 3 000 file dù GitHub còn trang", async () => {
      const { gh, pool } = setup();
      for (let page = 1; page <= 30; page++) {
        pool.intercept({ path: `/repos/acme/web/pulls/5/files?per_page=100&page=${page}`, method: "GET" }).reply(
          200,
          Array.from({ length: 100 }, (_, i) => ghFile(page * 100 + i)),
          JSON_HEADERS,
        );
      }
      expect(await gh.prFiles(ref, 5)).toHaveLength(3000);
    });

    it("PR không có thì null", async () => {
      const { gh, pool } = setup();
      pool
        .intercept({ path: "/repos/acme/web/pulls/9/files?per_page=100&page=1", method: "GET" })
        .reply(404, { message: "Not Found" }, JSON_HEADERS);
      expect(await gh.prFiles(ref, 9)).toBeNull();
    });
  });

  describe("setCommitStatus", () => {
    it("đặt status lên sha, cắt mô tả ở 140 ký tự", async () => {
      const { gh, pool } = setup();
      pool
        .intercept({ path: "/repos/acme/web/statuses/abc123", method: "POST" })
        .reply(201, http.json({ id: 1 }), JSON_HEADERS);
      await gh.setCommitStatus(ref, "abc123", {
        context: "xdev-hive/review",
        state: "pending",
        description: "x".repeat(200),
        targetUrl: "https://hive.example/reviews/1",
      });
      expect(http.calls.at(-1)?.body).toEqual({
        state: "pending",
        context: "xdev-hive/review",
        description: "x".repeat(140),
        target_url: "https://hive.example/reviews/1",
      });
    });

    it("không gửi target_url khi không có; 403 thành forbidden", async () => {
      const { gh, pool } = setup();
      pool
        .intercept({ path: "/repos/acme/web/statuses/abc123", method: "POST" })
        .reply(201, http.json({ id: 1 }), JSON_HEADERS);
      await gh.setCommitStatus(ref, "abc123", { context: "xdev-hive/review", state: "success", description: "ok" });
      expect(http.calls.at(-1)?.body).not.toHaveProperty("target_url");
      pool
        .intercept({ path: "/repos/acme/web/statuses/def456", method: "POST" })
        .reply(403, { message: "Resource not accessible by integration" }, JSON_HEADERS);
      const err = await rejected(
        gh.setCommitStatus(ref, "def456", { context: "xdev-hive/review", state: "failure", description: "no" }),
      );
      expect(err.code).toBe("forbidden");
    });
  });
});

describe("GitHub compare", () => {
  it("compare có danh sách commit: tiêu đề là dòng đầu, tác giả theo git", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/repos/acme/web/compare/v1...v2?per_page=100", method: "GET" }).reply(
      200,
      {
        total_commits: 1,
        commits: [
          {
            sha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
            commit: {
              message: "Fix all the bugs\n\nChi tiết.",
              author: { name: "Monalisa Octocat", email: "support@github.com", date: "2011-04-14T16:00:49Z" },
            },
            author: { login: "octocat" },
          },
        ],
        files: [{ filename: "a.txt", status: "modified", sha: "bbcd538c8e72b8c175046e27cc8f907076331401" }],
      },
      JSON_HEADERS,
    );
    expect(await gh.compare(ref, "v1", "v2")).toEqual({
      files: [{ path: "a.txt", status: "modified", sha: "bbcd538c8e72b8c175046e27cc8f907076331401" }],
      commits: [
        {
          sha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
          title: "Fix all the bugs",
          author: "Monalisa Octocat",
          authoredAt: "2011-04-14T16:00:49.000Z",
        },
      ],
      incomplete: false,
    });
  });
});

// undici đưa header cho callback dạng object hoặc mảng phẳng tuỳ phiên bản.
function headerNames(h: unknown): string[] {
  const keys = Array.isArray(h) ? h.filter((_, i) => i % 2 === 0) : Object.keys((h ?? {}) as object);
  return keys.map((k) => String(k).toLowerCase());
}

describe("GitHub Actions", () => {
  const RUNS = "/repos/acme/web/actions/runs";

  function run(over: Record<string, unknown> = {}) {
    return {
      id: 30433642,
      name: "CI",
      display_title: "Sửa lỗi đăng nhập",
      run_number: 562,
      head_branch: "main",
      head_sha: "acb5820ced9479c074f688cc328bf03f341a511d",
      status: "completed",
      conclusion: "success",
      event: "push",
      html_url: "https://github.com/acme/web/actions/runs/30433642",
      created_at: "2026-01-01T10:00:00Z",
      run_started_at: "2026-01-01T10:00:05Z",
      updated_at: "2026-01-01T10:02:05Z",
      actor: { login: "octocat" },
      triggering_actor: { login: "hubot" },
      ...over,
    };
  }

  function job(over: Record<string, unknown> = {}) {
    return {
      id: 399444496,
      run_id: 30433642,
      name: "build",
      workflow_name: "CI",
      head_branch: "main",
      head_sha: "acb5820ced9479c074f688cc328bf03f341a511d",
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/acme/web/actions/runs/30433642/job/399444496",
      created_at: "2026-01-01T10:00:00Z",
      started_at: "2026-01-01T10:00:10Z",
      completed_at: "2026-01-01T10:01:10Z",
      ...over,
    };
  }

  function pending(over: Record<string, unknown> = {}) {
    return {
      environment: { id: 161088068, name: "production", html_url: "https://github.com/acme/web/deployments" },
      current_user_can_approve: true,
      reviewers: [
        { type: "User", reviewer: { login: "octocat" } },
        { type: "Team", reviewer: { slug: "ops" } },
      ],
      ...over,
    };
  }

  it("liệt kê workflow run theo nhánh và trạng thái, đổi sang dạng CI chung", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: `${RUNS}?per_page=2&page=1&branch=main&status=failure`, method: "GET" })
      .reply(200, { total_count: 3, workflow_runs: [run({ conclusion: "failure" })] }, JSON_HEADERS);
    expect(await gh.listPipelines(ref, { page: 1, perPage: 2, branch: "main", status: "failed" })).toEqual({
      items: [
        {
          id: "30433642",
          ref: "main",
          sha: "acb5820ced9479c074f688cc328bf03f341a511d",
          status: "failed",
          source: "push",
          url: "https://github.com/acme/web/actions/runs/30433642",
          createdAt: "2026-01-01T10:00:00.000Z",
          updatedAt: "2026-01-01T10:02:05.000Z",
          startedAt: "2026-01-01T10:00:05.000Z",
          finishedAt: "2026-01-01T10:02:05.000Z",
          durationSec: 120,
          user: "hubot",
          title: "CI #562",
        },
      ],
      nextPage: 2,
    });
  });

  it("trạng thái chỉ GitLab có thì trả trang rỗng, không gọi GitHub", async () => {
    http = mockHttp();
    const gh = createGitHubProvider({ appId: 1, privateKey, installationId: 42, fetch: http.fetch });
    expect(await gh.listPipelines(ref, { page: 1, status: "preparing" })).toEqual({ items: [], nextPage: null });
  });

  it("đổi trạng thái run: chờ duyệt, đang chạy, đã huỷ", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: `${RUNS}?per_page=20&page=1`, method: "GET" }).reply(
      200,
      {
        total_count: 3,
        workflow_runs: [
          run({ id: 1, status: "waiting", conclusion: null }),
          run({ id: 2, status: "in_progress", conclusion: null }),
          run({ id: 3, conclusion: "cancelled" }),
        ],
      },
      JSON_HEADERS,
    );
    const page = await gh.listPipelines(ref, { page: 1 });
    expect(page.items.map((p) => [p.id, p.status, p.finishedAt])).toEqual([
      ["1", "waiting", null],
      ["2", "running", null],
      ["3", "canceled", "2026-01-01T10:02:05.000Z"],
    ]);
    expect(page.nextPage).toBeNull();
  });

  it("job của run: lần thử mới nhất, đọc hết các trang", async () => {
    const { gh, pool } = setup();
    const first = Array.from({ length: 100 }, (_, i) => job({ id: 1000 + i, name: `j${i}` }));
    pool
      .intercept({ path: `${RUNS}/30433642/jobs?filter=latest&per_page=100&page=1`, method: "GET" })
      .reply(200, { total_count: 101, jobs: first }, JSON_HEADERS);
    pool
      .intercept({ path: `${RUNS}/30433642/jobs?filter=latest&per_page=100&page=2`, method: "GET" })
      .reply(200, { total_count: 101, jobs: [job()] }, JSON_HEADERS);
    const jobs = await gh.pipelineJobs(ref, "30433642");
    expect(jobs).toHaveLength(101);
    expect(jobs[100]).toEqual({
      id: "399444496",
      pipelineId: "30433642",
      name: "build",
      stage: "CI",
      ref: "main",
      sha: "acb5820ced9479c074f688cc328bf03f341a511d",
      status: "failed",
      allowFailure: false,
      failureReason: "failure",
      url: "https://github.com/acme/web/actions/runs/30433642/job/399444496",
      createdAt: "2026-01-01T10:00:00.000Z",
      startedAt: "2026-01-01T10:00:10.000Z",
      finishedAt: "2026-01-01T10:01:10.000Z",
      durationSec: 60,
      user: null,
    });
  });

  it("log job đi theo chuyển hướng, không gửi token sang máy chủ lưu log", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/repos/acme/web/actions/jobs/399444496", method: "GET" }).reply(200, job(), JSON_HEADERS);
    let apiHeaders: unknown;
    pool.intercept({ path: "/repos/acme/web/actions/jobs/399444496/logs", method: "GET" }).reply((o) => {
      apiHeaders = o.headers;
      return {
        statusCode: 302,
        data: "",
        responseOptions: { headers: { location: "https://logs.example.com/job/399444496?sig=abc" } },
      };
    });
    let logHeaders: unknown;
    http.agent
      .get("https://logs.example.com")
      .intercept({ path: "/job/399444496?sig=abc", method: "GET" })
      .reply(200, (o) => {
        logHeaders = o.headers;
        return "dòng 1\ndòng 2\n";
      });
    // "dòng 1\n" dài 8 byte (ò chiếm 2 byte).
    expect(await gh.jobLog(ref, "399444496", 8)).toEqual({ text: "dòng 2\n", next: 16, complete: true });
    expect(JSON.stringify(apiHeaders)).toContain("Bearer ghs_test");
    expect(headerNames(logHeaders)).not.toContain("authorization");
  });

  it("log chưa có: job đang chạy trả rỗng, job đã xong báo not_found", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: "/repos/acme/web/actions/jobs/1", method: "GET" })
      .reply(200, job({ id: 1, status: "in_progress", conclusion: null }), JSON_HEADERS);
    pool
      .intercept({ path: "/repos/acme/web/actions/jobs/1/logs", method: "GET" })
      .reply(404, { message: "Not Found" }, JSON_HEADERS);
    expect(await gh.jobLog(ref, "1", 0)).toEqual({ text: "", next: 0, complete: false });
    pool.intercept({ path: "/repos/acme/web/actions/jobs/2", method: "GET" }).reply(200, job({ id: 2 }), JSON_HEADERS);
    pool
      .intercept({ path: "/repos/acme/web/actions/jobs/2/logs", method: "GET" })
      .reply(404, { message: "Not Found" }, JSON_HEADERS);
    expect((await rejected(gh.jobLog(ref, "2", 0))).code).toBe("not_found");
  });

  it("chạy lại: run lỗi chỉ chạy lại job lỗi, run đạt chạy lại cả run", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: `${RUNS}/1`, method: "GET" })
      .reply(200, run({ id: 1, conclusion: "failure" }), JSON_HEADERS);
    pool.intercept({ path: `${RUNS}/1/rerun-failed-jobs`, method: "POST" }).reply(201, {}, JSON_HEADERS);
    expect(await gh.retryPipeline(ref, "1")).toMatchObject({ id: "1", status: "pending", finishedAt: null });
    pool.intercept({ path: `${RUNS}/2`, method: "GET" }).reply(200, run({ id: 2 }), JSON_HEADERS);
    pool.intercept({ path: `${RUNS}/2/rerun`, method: "POST" }).reply(201, {}, JSON_HEADERS);
    expect(await gh.retryPipeline(ref, "2")).toMatchObject({ id: "2", status: "pending" });
  });

  it("chạy lại một job", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: "/repos/acme/web/actions/jobs/399444496/rerun", method: "POST" })
      .reply(201, {}, JSON_HEADERS);
    pool.intercept({ path: "/repos/acme/web/actions/jobs/399444496", method: "GET" }).reply(200, job(), JSON_HEADERS);
    expect(await gh.retryJob(ref, "399444496")).toMatchObject({
      id: "399444496",
      status: "pending",
      failureReason: null,
      finishedAt: null,
    });
  });

  it("huỷ run còn chạy thì báo đang huỷ", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: `${RUNS}/30433642/cancel`, method: "POST" }).reply(202, {}, JSON_HEADERS);
    pool
      .intercept({ path: `${RUNS}/30433642`, method: "GET" })
      .reply(200, run({ status: "in_progress", conclusion: null }), JSON_HEADERS);
    expect(await gh.cancelPipeline(ref, "30433642")).toMatchObject({ id: "30433642", status: "canceling" });
  });

  it("huỷ hoặc bấm chạy một job báo chưa hỗ trợ, không gọi GitHub", async () => {
    http = mockHttp();
    const gh = createGitHubProvider({ appId: 1, privateKey, installationId: 42, fetch: http.fetch });
    expect((await rejected(gh.cancelJob(ref, "1"))).code).toBe("unsupported");
    expect((await rejected(gh.playJob(ref, "1"))).code).toBe("unsupported");
  });

  it("đọc deployment chờ duyệt", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: `${RUNS}/30433642/pending_deployments`, method: "GET" })
      .reply(
        200,
        [pending(), pending({ environment: { id: 7 }, current_user_can_approve: false, reviewers: [] })],
        JSON_HEADERS,
      );
    expect(await gh.pendingDeployments?.(ref, "30433642")).toEqual([
      {
        environment: "production",
        environmentId: "161088068",
        url: "https://github.com/acme/web/deployments",
        canApprove: true,
        reviewers: ["octocat", "ops"],
      },
      { environment: "7", environmentId: "7", url: null, canApprove: false, reviewers: [] },
    ]);
  });

  it("duyệt deployment gửi id environment; environment không chờ duyệt thì invalid, không gửi", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: `${RUNS}/30433642/pending_deployments`, method: "GET" })
      .reply(200, [pending()], JSON_HEADERS)
      .times(2);
    pool
      .intercept({ path: `${RUNS}/30433642/pending_deployments`, method: "POST" })
      .reply(200, http.json([]), JSON_HEADERS);
    await gh.reviewDeployments?.(ref, "30433642", {
      environments: ["production"],
      decision: "reject",
      comment: "Chưa tới giờ phát hành",
    });
    expect(http.calls[0]?.body).toEqual({
      environment_ids: [161088068],
      state: "rejected",
      comment: "Chưa tới giờ phát hành",
    });
    const review = gh.reviewDeployments?.(ref, "30433642", {
      environments: ["staging"],
      decision: "approve",
      comment: "",
    });
    expect((await rejected(review ?? Promise.resolve())).code).toBe("invalid");
    expect(http.calls).toHaveLength(1);
  });

  it("addWebhook đổi pipeline, job thành workflow_run, workflow_job", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/repos/acme/web/hooks?per_page=100", method: "GET" }).reply(200, [], JSON_HEADERS);
    pool.intercept({ path: "/repos/acme/web/hooks", method: "POST" }).reply(201, http.json({ id: 99 }), JSON_HEADERS);
    await gh.addWebhook(ref, {
      url: "https://hive.example/hooks/git",
      secret: "s3",
      events: ["push", "pipeline", "job"],
    });
    expect(http.calls[0]?.body).toMatchObject({ events: ["push", "workflow_run", "workflow_job"] });
  });
});

describe("GitHub token theo run", () => {
  it("GitHub App cấp token cài đặt chỉ cho repo của run", async () => {
    http = mockHttp();
    const expires = new Date(Date.now() + 3600_000).toISOString();
    http.agent
      .get(API)
      .intercept({ path: "/app/installations/42/access_tokens", method: "POST" })
      .reply(201, http.json({ token: "ghs_run", expires_at: expires }), JSON_HEADERS);
    const gh = createGitHubProvider({ appId: 1, privateKey, installationId: 42, fetch: http.fetch });
    expect(await gh.issueRunToken?.(ref, "hive-run-r1-1")).toEqual({
      host: "github.com",
      username: "x-access-token",
      token: "ghs_run",
      expiresAt: new Date(expires),
      externalId: null,
    });
    expect(http.calls[0]?.body).toEqual({
      repositories: ["web"],
      permissions: { contents: "write", pull_requests: "read" },
    });
  });

  it("PAT không cấp được token theo run", () => {
    http = mockHttp();
    const gh = createGitHubProvider({ token: "ghp_test", fetch: http.fetch });
    expect(gh.issueRunToken).toBeUndefined();
  });
});
