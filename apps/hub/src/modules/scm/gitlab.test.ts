import { afterEach, describe, expect, it } from "vitest";
import { GitProviderError } from "./errors.ts";
import { createGitLabProvider } from "./gitlab.ts";
import { JSON_HEADERS, mockHttp } from "./mock-http.ts";
import type { GitProvider } from "./types.ts";

const HOST = "https://gitlab.example";
const P = "/api/v4/projects/grp%2Fsub%2Fweb";
const ref = { owner: "grp/sub", name: "web" };
const marker = "hive:prj_1";

let http: ReturnType<typeof mockHttp>;
afterEach(async () => {
  http.agent.assertNoPendingInterceptors();
  await http.agent.close();
});

function setup(): { gl: GitProvider; pool: ReturnType<ReturnType<typeof mockHttp>["agent"]["get"]> } {
  http = mockHttp();
  // Dấu / ở cuối URL tự host không được làm hỏng đường dẫn API.
  return {
    gl: createGitLabProvider({ url: `${HOST}/`, token: "glpat-test", fetch: http.fetch }),
    pool: http.agent.get(HOST),
  };
}

function project(over: Record<string, unknown> = {}) {
  return {
    id: 11,
    path: "web",
    namespace: { full_path: "grp/sub" },
    default_branch: "main",
    visibility: "private",
    description: `Web [${marker}]`,
    http_url_to_repo: "https://gitlab.example/grp/sub/web.git",
    ssh_url_to_repo: "git@gitlab.example:grp/sub/web.git",
    web_url: "https://gitlab.example/grp/sub/web",
    ...over,
  };
}

const notFound = { message: "404 Not found" };

async function rejected(p: Promise<unknown>): Promise<GitProviderError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(GitProviderError);
  return e as GitProviderError;
}

describe("GitLab checkAccess", () => {
  it("maintainer của group, token có scope api", async () => {
    const { gl, pool } = setup();
    pool
      .intercept({ path: "/api/v4/user", method: "GET", headers: { "private-token": "glpat-test" } })
      .reply(200, { id: 5, username: "lan" }, JSON_HEADERS);
    pool
      .intercept({ path: "/api/v4/personal_access_tokens/self", method: "GET" })
      .reply(200, { scopes: ["api", "read_user"] }, JSON_HEADERS);
    pool
      .intercept({ path: "/api/v4/namespaces/grp", method: "GET" })
      .reply(200, { id: 2, kind: "group", full_path: "grp" }, JSON_HEADERS);
    pool
      .intercept({ path: "/api/v4/groups/2/members/all/5", method: "GET" })
      .reply(200, { access_level: 40 }, JSON_HEADERS);
    pool
      .intercept({ path: "/api/v4/groups/2", method: "GET" })
      .reply(200, { id: 2, project_creation_level: "maintainer" }, JSON_HEADERS);
    expect(await gl.checkAccess("grp")).toEqual({ canCreate: true, missingScopes: [] });
  });

  it("developer, token thiếu scope api", async () => {
    const { gl, pool } = setup();
    pool.intercept({ path: "/api/v4/user", method: "GET" }).reply(200, { id: 5, username: "lan" }, JSON_HEADERS);
    pool
      .intercept({ path: "/api/v4/personal_access_tokens/self", method: "GET" })
      .reply(200, { scopes: ["read_api"] }, JSON_HEADERS);
    pool
      .intercept({ path: "/api/v4/namespaces/grp", method: "GET" })
      .reply(200, { id: 2, kind: "group", full_path: "grp" }, JSON_HEADERS);
    pool
      .intercept({ path: "/api/v4/groups/2/members/all/5", method: "GET" })
      .reply(200, { access_level: 30 }, JSON_HEADERS);
    pool
      .intercept({ path: "/api/v4/groups/2", method: "GET" })
      .reply(200, { id: 2, project_creation_level: "maintainer" }, JSON_HEADERS);
    expect(await gl.checkAccess("grp")).toEqual({ canCreate: false, missingScopes: ["api", "group:maintainer"] });
  });

  it("namespace của chính mình; token OAuth không kiểm được scope", async () => {
    const { gl, pool } = setup();
    pool.intercept({ path: "/api/v4/user", method: "GET" }).reply(200, { id: 5, username: "lan" }, JSON_HEADERS);
    pool.intercept({ path: "/api/v4/personal_access_tokens/self", method: "GET" }).reply(404, notFound, JSON_HEADERS);
    pool
      .intercept({ path: "/api/v4/namespaces/lan", method: "GET" })
      .reply(200, { id: 9, kind: "user", full_path: "lan" }, JSON_HEADERS);
    expect(await gl.checkAccess("lan")).toEqual({ canCreate: true, missingScopes: [] });
  });

  it("namespace không thấy", async () => {
    const { gl, pool } = setup();
    pool.intercept({ path: "/api/v4/user", method: "GET" }).reply(200, { id: 5, username: "lan" }, JSON_HEADERS);
    pool
      .intercept({ path: "/api/v4/personal_access_tokens/self", method: "GET" })
      .reply(200, { scopes: ["api"] }, JSON_HEADERS);
    pool.intercept({ path: "/api/v4/namespaces/x", method: "GET" }).reply(404, notFound, JSON_HEADERS);
    expect(await gl.checkAccess("x")).toEqual({ canCreate: false, missingScopes: ["namespace:x"] });
  });
});

describe("GitLab getRepo", () => {
  it("trả thông tin repo trong group lồng", async () => {
    const { gl, pool } = setup();
    pool.intercept({ path: P, method: "GET" }).reply(200, project(), JSON_HEADERS);
    expect(await gl.getRepo(ref)).toEqual({
      id: "11",
      owner: "grp/sub",
      name: "web",
      defaultBranch: "main",
      visibility: "private",
      description: `Web [${marker}]`,
      httpUrl: "https://gitlab.example/grp/sub/web.git",
      sshUrl: "git@gitlab.example:grp/sub/web.git",
      webUrl: "https://gitlab.example/grp/sub/web",
    });
  });

  it("404 thì trả null", async () => {
    const { gl, pool } = setup();
    pool.intercept({ path: P, method: "GET" }).reply(404, notFound, JSON_HEADERS);
    expect(await gl.getRepo(ref)).toBeNull();
  });
});

describe("GitLab createRepo", () => {
  const input = { ...ref, visibility: "internal" as const, defaultBranch: "trunk", description: "Web", marker };

  it("tạo project mới trong namespace, có README và nhánh mặc định", async () => {
    const { gl, pool } = setup();
    pool.intercept({ path: P, method: "GET" }).reply(404, notFound, JSON_HEADERS);
    pool.intercept({ path: "/api/v4/namespaces/grp%2Fsub", method: "GET" }).reply(200, { id: 3 }, JSON_HEADERS);
    pool
      .intercept({ path: "/api/v4/projects", method: "POST" })
      .reply(201, http.json(project({ default_branch: "trunk", visibility: "internal" })), JSON_HEADERS);
    const r = await gl.createRepo(input);
    expect(r).toMatchObject({ id: "11", defaultBranch: "trunk", visibility: "internal" });
    expect(http.calls[0]?.body).toEqual({
      name: "web",
      path: "web",
      namespace_id: 3,
      visibility: "internal",
      description: `Web [${marker}]`,
      initialize_with_readme: true,
      default_branch: "trunk",
    });
  });

  it("repo đã có cùng dấu hiệu thì trả lại", async () => {
    const { gl, pool } = setup();
    pool.intercept({ path: P, method: "GET" }).reply(200, project(), JSON_HEADERS);
    expect((await gl.createRepo(input)).id).toBe("11");
  });

  it("repo đã có nhưng không do Hive tạo thì conflict", async () => {
    const { gl, pool } = setup();
    pool.intercept({ path: P, method: "GET" }).reply(200, project({ description: null }), JSON_HEADERS);
    expect((await rejected(gl.createRepo(input))).code).toBe("conflict");
  });

  it("thua cuộc đua (400 has already been taken) thì đọc lại", async () => {
    const { gl, pool } = setup();
    pool.intercept({ path: P, method: "GET" }).reply(404, notFound, JSON_HEADERS);
    pool.intercept({ path: "/api/v4/namespaces/grp%2Fsub", method: "GET" }).reply(200, { id: 3 }, JSON_HEADERS);
    pool
      .intercept({ path: "/api/v4/projects", method: "POST" })
      .reply(400, { message: { name: ["has already been taken"] } }, JSON_HEADERS);
    pool.intercept({ path: P, method: "GET" }).reply(200, project(), JSON_HEADERS);
    expect((await gl.createRepo(input)).id).toBe("11");
  });
});

describe("GitLab commitFiles", () => {
  const files = [
    { path: "AGENTS.md", content: "# A" },
    { path: "docs/x.md", content: "x" },
  ];

  it("nhánh đã có: update file có sẵn, create file mới, một commit", async () => {
    const { gl, pool } = setup();
    pool.intercept({ path: `${P}/repository/branches/main`, method: "GET" }).reply(200, { name: "main" }, JSON_HEADERS);
    pool.intercept({ path: `${P}/repository/files/AGENTS.md?ref=main`, method: "HEAD" }).reply(200, "");
    pool.intercept({ path: `${P}/repository/files/docs%2Fx.md?ref=main`, method: "HEAD" }).reply(404, "");
    pool
      .intercept({ path: `${P}/repository/commits`, method: "POST" })
      .reply(201, http.json({ id: "c1" }), JSON_HEADERS);
    expect(await gl.commitFiles(ref, { branch: "main", message: "init", files })).toEqual({ sha: "c1" });
    expect(http.calls[0]?.body).toEqual({
      branch: "main",
      commit_message: "init",
      actions: [
        { action: "update", file_path: "AGENTS.md", content: "# A" },
        { action: "create", file_path: "docs/x.md", content: "x" },
      ],
    });
  });

  it("nhánh mới: kiểm file trên fromBranch và gửi start_branch", async () => {
    const { gl, pool } = setup();
    pool.intercept({ path: `${P}/repository/branches/ai%2Ft-1`, method: "GET" }).reply(404, notFound, JSON_HEADERS);
    pool.intercept({ path: `${P}/repository/files/AGENTS.md?ref=main`, method: "HEAD" }).reply(404, "");
    pool
      .intercept({ path: `${P}/repository/commits`, method: "POST" })
      .reply(201, http.json({ id: "c2" }), JSON_HEADERS);
    const out = await gl.commitFiles(ref, {
      branch: "ai/t-1",
      fromBranch: "main",
      message: "m",
      files: [files[0] as (typeof files)[0]],
    });
    expect(out.sha).toBe("c2");
    expect(http.calls[0]?.body).toMatchObject({ branch: "ai/t-1", start_branch: "main" });
  });

  it("nhánh không có và không có fromBranch thì not_found", async () => {
    const { gl, pool } = setup();
    pool.intercept({ path: `${P}/repository/branches/dev`, method: "GET" }).reply(404, notFound, JSON_HEADERS);
    expect((await rejected(gl.commitFiles(ref, { branch: "dev", message: "m", files }))).code).toBe("not_found");
  });
});

describe("GitLab protectBranch", () => {
  const rules = {
    requirePullRequest: true,
    requiredApprovals: 2,
    allowForcePush: false as const,
    requiredChecks: ["ci"],
  };
  const protectPath = `${P}/protected_branches?push_access_level=0&merge_access_level=30&allow_force_push=false&name=main`;

  it("nhánh đã được bảo vệ sẵn (409): gỡ rồi bảo vệ lại; thêm luật duyệt và pipeline", async () => {
    const { gl, pool } = setup();
    pool
      .intercept({ path: protectPath, method: "POST" })
      .reply(409, { message: "Protected branch 'main' already exists" }, JSON_HEADERS);
    pool.intercept({ path: `${P}/protected_branches/main`, method: "DELETE" }).reply(204, "");
    pool.intercept({ path: protectPath, method: "POST" }).reply(201, { id: 77, name: "main" }, JSON_HEADERS);
    pool.intercept({ path: `${P}/approval_rules`, method: "GET" }).reply(200, [], JSON_HEADERS);
    pool.intercept({ path: `${P}/approval_rules`, method: "POST" }).reply(201, http.json({ id: 1 }), JSON_HEADERS);
    pool.intercept({ path: P, method: "PUT" }).reply(200, http.json(project()), JSON_HEADERS);
    await gl.protectBranch(ref, "main", rules);
    expect(http.calls.map((c) => c.body)).toEqual([
      { name: "Hive", approvals_required: 2, protected_branch_ids: [77] },
      { only_allow_merge_if_pipeline_succeeds: true },
    ]);
  });

  it("luật duyệt đã có thì cập nhật", async () => {
    const { gl, pool } = setup();
    pool.intercept({ path: protectPath, method: "POST" }).reply(201, { id: 77 }, JSON_HEADERS);
    pool.intercept({ path: `${P}/approval_rules`, method: "GET" }).reply(200, [{ id: 8, name: "Hive" }], JSON_HEADERS);
    pool.intercept({ path: `${P}/approval_rules/8`, method: "PUT" }).reply(200, http.json({ id: 8 }), JSON_HEADERS);
    await gl.protectBranch(ref, "main", { ...rules, requiredChecks: [] });
    expect(http.calls[0]?.body).toEqual({ name: "Hive", approvals_required: 2, protected_branch_ids: [77] });
  });

  it("gói Free (403 ở approval_rules) thì bỏ qua luật duyệt", async () => {
    const { gl, pool } = setup();
    pool.intercept({ path: protectPath, method: "POST" }).reply(201, { id: 77 }, JSON_HEADERS);
    pool
      .intercept({ path: `${P}/approval_rules`, method: "GET" })
      .reply(403, { message: "403 Forbidden" }, JSON_HEADERS);
    await gl.protectBranch(ref, "main", { ...rules, requiredChecks: [] });
  });
});

describe("GitLab openPR", () => {
  const input = { head: "ai/t-1", base: "main", title: "T", body: "B", draft: true, labels: ["hive", "ai"] };

  it("mở merge request nháp kèm nhãn", async () => {
    const { gl, pool } = setup();
    pool
      .intercept({ path: `${P}/merge_requests`, method: "POST" })
      .reply(
        201,
        http.json({ iid: 3, web_url: "https://gitlab.example/grp/sub/web/-/merge_requests/3" }),
        JSON_HEADERS,
      );
    expect(await gl.openPR(ref, input)).toEqual({
      number: 3,
      url: "https://gitlab.example/grp/sub/web/-/merge_requests/3",
    });
    expect(http.calls[0]?.body).toEqual({
      source_branch: "ai/t-1",
      target_branch: "main",
      title: "Draft: T",
      description: "B",
      labels: "hive,ai",
    });
  });

  it("MR đã mở (409) thì trả lại MR đó và thêm nhãn", async () => {
    const { gl, pool } = setup();
    pool
      .intercept({ path: `${P}/merge_requests`, method: "POST" })
      .reply(409, { message: ["Another open merge request already exists for this source branch: !2"] }, JSON_HEADERS);
    pool
      .intercept({
        path: (p) => p.startsWith(`${P}/merge_requests?`) && p.includes("source_branch=ai%2Ft-1"),
        method: "GET",
      })
      .reply(200, [{ iid: 2, web_url: "https://gitlab.example/grp/sub/web/-/merge_requests/2" }], JSON_HEADERS);
    pool.intercept({ path: `${P}/merge_requests/2`, method: "PUT" }).reply(200, http.json({ iid: 2 }), JSON_HEADERS);
    expect((await gl.openPR(ref, input)).number).toBe(2);
    expect(http.calls[0]?.body).toEqual({ add_labels: "hive,ai" });
  });
});

describe("GitLab commentOnIssue", () => {
  it("issue dùng note của issue, merge request dùng note của merge request", async () => {
    const { gl, pool } = setup();
    pool
      .intercept({ path: `${P}/issues/17/notes`, method: "POST", headers: { "private-token": "glpat-test" } })
      .reply(201, http.json({ id: 1241 }), JSON_HEADERS);
    pool
      .intercept({ path: `${P}/merge_requests/3/notes`, method: "POST" })
      .reply(201, http.json({ id: 1242 }), JSON_HEADERS);
    expect(await gl.commentOnIssue(ref, 17, "Đã tạo task HD-3")).toEqual({ id: "1241" });
    expect(await gl.commentOnIssue(ref, 3, "Đã nhận", { pullRequest: true })).toEqual({ id: "1242" });
    expect(http.calls.map((c) => c.body)).toEqual([{ body: "Đã tạo task HD-3" }, { body: "Đã nhận" }]);
  });

  it("issue không còn (404) thì báo not_found", async () => {
    const { gl, pool } = setup();
    pool.intercept({ path: `${P}/issues/17/notes`, method: "POST" }).reply(404, notFound, JSON_HEADERS);
    expect((await rejected(gl.commentOnIssue(ref, 17, "x"))).code).toBe("not_found");
  });
});

describe("GitLab canPush", () => {
  it("Developer (30) trở lên thì push được, Reporter thì không; tra theo id, tính cả quyền từ group", async () => {
    const { gl, pool } = setup();
    pool.intercept({ path: `${P}/members/all/41`, method: "GET" }).reply(200, { access_level: 30 }, JSON_HEADERS);
    pool.intercept({ path: `${P}/members/all/42`, method: "GET" }).reply(200, { access_level: 20 }, JSON_HEADERS);
    expect(await gl.canPush(ref, { login: "lan", id: 41 })).toBe(true);
    expect(await gl.canPush(ref, { login: "khach", id: 42 })).toBe(false);
  });

  it("không phải thành viên (404) hoặc thiếu id thì false", async () => {
    const { gl, pool } = setup();
    pool.intercept({ path: `${P}/members/all/99`, method: "GET" }).reply(404, notFound, JSON_HEADERS);
    expect(await gl.canPush(ref, { login: "nguoi-la", id: 99 })).toBe(false);
    expect(await gl.canPush(ref, { login: "lan", id: null })).toBe(false);
  });
});

describe("GitLab webhook", () => {
  const input = {
    url: "https://hive.example/hooks/git",
    secret: "s3",
    events: ["push" as const, "pull_request" as const, "issues" as const, "issue_comment" as const],
  };
  const body = {
    url: input.url,
    token: "s3",
    push_events: true,
    merge_requests_events: true,
    issues_events: true,
    note_events: true,
    enable_ssl_verification: true,
  };

  it("tạo webhook mới, pull_request đổi thành merge_requests_events, issue_comment thành note_events", async () => {
    const { gl, pool } = setup();
    pool.intercept({ path: `${P}/hooks`, method: "GET" }).reply(200, [], JSON_HEADERS);
    pool.intercept({ path: `${P}/hooks`, method: "POST" }).reply(201, http.json({ id: 21 }), JSON_HEADERS);
    expect(await gl.addWebhook(ref, input)).toEqual({ id: "21" });
    expect(http.calls[0]?.body).toEqual(body);
  });

  it("webhook cùng URL đã có thì cập nhật", async () => {
    const { gl, pool } = setup();
    pool.intercept({ path: `${P}/hooks`, method: "GET" }).reply(200, [{ id: 4, url: input.url }], JSON_HEADERS);
    pool.intercept({ path: `${P}/hooks/4`, method: "PUT" }).reply(200, http.json({ id: 4 }), JSON_HEADERS);
    expect(await gl.addWebhook(ref, input)).toEqual({ id: "4" });
    expect(http.calls[0]?.body).toEqual(body);
  });

  it("xoá webhook; không còn (404) cũng coi là xong", async () => {
    const { gl, pool } = setup();
    pool.intercept({ path: `${P}/hooks/4`, method: "DELETE" }).reply(204, "");
    pool.intercept({ path: `${P}/hooks/5`, method: "DELETE" }).reply(404, notFound, JSON_HEADERS);
    await gl.removeWebhook(ref, "4");
    await gl.removeWebhook(ref, "5");
  });
});

describe("GitLab lỗi HTTP", () => {
  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [400, "invalid"],
    [502, "unavailable"],
  ] as const)("%i → %s", async (status, code) => {
    const { gl, pool } = setup();
    pool.intercept({ path: `${P}/hooks`, method: "GET" }).reply(status, { message: `${status}` }, JSON_HEADERS);
    const e = await rejected(gl.addWebhook(ref, { url: "u", secret: "s", events: ["push"] }));
    expect(e.code).toBe(code);
    expect(e.status).toBe(status);
  });

  it("429 đọc Retry-After, không tự thử lại", async () => {
    const { gl, pool } = setup();
    pool
      .intercept({ path: P, method: "GET" })
      .reply(429, "Retry later", { headers: { "content-type": "text/plain", "retry-after": "12" } });
    const e = await rejected(gl.getRepo(ref));
    expect(e.code).toBe("rate_limited");
    expect(e.retryAfterMs).toBe(12_000);
    expect(e.message).toContain("Retry later");
  });

  it("429 không có Retry-After thì đọc RateLimit-Reset", async () => {
    const { gl, pool } = setup();
    const reset = Math.ceil(Date.now() / 1000) + 30;
    pool
      .intercept({ path: P, method: "GET" })
      .reply(429, { message: "x" }, { headers: { ...JSON_HEADERS.headers, "ratelimit-reset": String(reset) } });
    const e = await rejected(gl.getRepo(ref));
    expect(e.code).toBe("rate_limited");
    expect(e.retryAfterMs).toBeGreaterThan(25_000);
    expect(e.retryAfterMs).toBeLessThanOrEqual(31_000);
  });

  it("lỗi mạng → unavailable", async () => {
    const gl = createGitLabProvider({
      url: HOST,
      token: "t",
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    http = mockHttp();
    const e = await rejected(gl.getRepo(ref));
    expect(e.code).toBe("unavailable");
    expect(e.retryable).toBe(true);
  });
});
