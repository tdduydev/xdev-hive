import { generateKeyPairSync } from "node:crypto";
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
