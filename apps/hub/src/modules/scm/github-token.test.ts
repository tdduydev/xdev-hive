import { afterEach, describe, expect, it } from "vitest";
import { GitProviderError } from "./errors.ts";
import { createGitHubProvider } from "./github.ts";
import { JSON_HEADERS, mockHttp } from "./mock-http.ts";
import type { GitProvider } from "./types.ts";

// Chế độ token: cùng provider với GitHub App, chỉ khác cách xác thực và kiểm quyền.
const API = "https://api.github.com";
const TOKEN = "github_pat_khong_dung_that";
const marker = "hive:prj_1";

let http: ReturnType<typeof mockHttp>;
afterEach(async () => {
  http.agent.assertNoPendingInterceptors();
  await http.agent.close();
});

/** Mọi lời gọi phải mang token, không đổi token cài đặt như GitHub App. */
const auth = { authorization: (v: string) => v.endsWith(TOKEN) };

function setup(baseUrl?: string): { gh: GitProvider; pool: ReturnType<ReturnType<typeof mockHttp>["agent"]["get"]> } {
  http = mockHttp();
  const pool = http.agent.get(baseUrl ? new URL(baseUrl).origin : API);
  const gh = createGitHubProvider({ token: TOKEN, fetch: http.fetch, ...(baseUrl ? { baseUrl } : {}) });
  return { gh, pool };
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

const userReply = (scopes?: string) => ({
  headers: { "content-type": "application/json", ...(scopes === undefined ? {} : { "x-oauth-scopes": scopes }) },
});

describe("GitHub token checkAccess", () => {
  it("PAT cổ điển có scope repo, owner là org thấy được", async () => {
    const { gh, pool } = setup();
    pool
      .intercept({ path: "/user", method: "GET", headers: auth })
      .reply(200, { login: "duy" }, userReply("repo, read:org"));
    pool.intercept({ path: "/orgs/acme", method: "GET" }).reply(200, { login: "acme" }, JSON_HEADERS);
    expect(await gh.checkAccess("acme")).toEqual({ canCreate: true, missingScopes: [] });
  });

  it("PAT cổ điển thiếu scope repo và org không thấy được", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/user", method: "GET" }).reply(200, { login: "duy" }, userReply("read:user"));
    pool.intercept({ path: "/orgs/acme", method: "GET" }).reply(404, { message: "Not Found" }, JSON_HEADERS);
    expect(await gh.checkAccess("acme")).toEqual({ canCreate: false, missingScopes: ["org:acme", "repo"] });
  });

  it("owner là chính chủ token thì không hỏi org", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/user", method: "GET" }).reply(200, { login: "Duy" }, userReply("repo"));
    expect(await gh.checkAccess("duy")).toEqual({ canCreate: true, missingScopes: [] });
  });

  it("fine-grained token: báo các quyền chưa kiểm trước được", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/user", method: "GET" }).reply(200, { login: "duy" }, userReply());
    pool.intercept({ path: "/orgs/acme", method: "GET" }).reply(200, { login: "acme" }, JSON_HEADERS);
    expect(await gh.checkAccess("acme")).toEqual({
      canCreate: true,
      missingScopes: [],
      unverifiedScopes: ["administration:write", "contents:write", "pull_requests:write", "repository_hooks:write"],
    });
  });

  it("token sai thì unauthorized", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/user", method: "GET" }).reply(401, { message: "Bad credentials" }, JSON_HEADERS);
    expect((await rejected(gh.checkAccess("acme"))).code).toBe("unauthorized");
  });

  it("GitHub Enterprise Server dùng baseUrl", async () => {
    const { gh, pool } = setup("https://ghe.example.com/api/v3");
    pool.intercept({ path: "/api/v3/user", method: "GET" }).reply(200, { login: "duy" }, userReply("repo"));
    expect(await gh.checkAccess("duy")).toEqual({ canCreate: true, missingScopes: [] });
  });
});

describe("GitHub token createRepo", () => {
  const input = { owner: "acme", name: "web", visibility: "private" as const, defaultBranch: "main", marker };

  it("owner là org thì tạo qua /orgs/{org}/repos", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/user", method: "GET" }).reply(200, { login: "duy" }, JSON_HEADERS);
    pool.intercept({ path: "/repos/acme/web", method: "GET" }).reply(404, { message: "Not Found" }, JSON_HEADERS);
    pool
      .intercept({ path: "/orgs/acme/repos", method: "POST", headers: auth })
      .reply(201, http.json(repo()), JSON_HEADERS);
    expect((await gh.createRepo(input)).id).toBe("7");
    expect(http.calls[0]?.body).toEqual({
      name: "web",
      description: `[${marker}]`,
      visibility: "private",
      auto_init: true,
    });
  });

  it("owner là chính chủ token thì tạo qua /user/repos", async () => {
    const { gh, pool } = setup();
    const mine = { ...input, owner: "duy" };
    pool.intercept({ path: "/user", method: "GET" }).reply(200, { login: "Duy" }, JSON_HEADERS);
    pool.intercept({ path: "/repos/duy/web", method: "GET" }).reply(404, { message: "Not Found" }, JSON_HEADERS);
    pool
      .intercept({ path: "/user/repos", method: "POST" })
      .reply(201, http.json(repo({ owner: { login: "Duy" } })), JSON_HEADERS);
    expect((await gh.createRepo(mine)).owner).toBe("Duy");
    expect(http.calls[0]?.body).toEqual({ name: "web", description: `[${marker}]`, private: true, auto_init: true });
  });

  it("repo internal dưới tài khoản cá nhân thì invalid, không gọi tạo", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/user", method: "GET" }).reply(200, { login: "duy" }, JSON_HEADERS);
    pool.intercept({ path: "/repos/duy/web", method: "GET" }).reply(404, { message: "Not Found" }, JSON_HEADERS);
    expect((await rejected(gh.createRepo({ ...input, owner: "duy", visibility: "internal" }))).code).toBe("invalid");
  });

  it("repo đã có cùng dấu hiệu thì trả lại, không tạo mới (không cần hỏi chủ token)", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/repos/acme/web", method: "GET" }).reply(200, repo(), JSON_HEADERS);
    expect((await gh.createRepo(input)).id).toBe("7");
  });

  it("thua cuộc đua tạo repo (422) thì đọc lại repo", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/user", method: "GET" }).reply(200, { login: "duy" }, JSON_HEADERS);
    pool.intercept({ path: "/repos/acme/web", method: "GET" }).reply(404, { message: "Not Found" }, JSON_HEADERS);
    pool
      .intercept({ path: "/orgs/acme/repos", method: "POST" })
      .reply(422, { message: "name already exists on this account" }, JSON_HEADERS);
    pool.intercept({ path: "/repos/acme/web", method: "GET" }).reply(200, repo(), JSON_HEADERS);
    expect((await gh.createRepo(input)).id).toBe("7");
  });

  it("thiếu quyền (403) báo quyền GitHub đòi qua x-accepted-github-permissions", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/user", method: "GET" }).reply(200, { login: "duy" }, JSON_HEADERS);
    pool.intercept({ path: "/repos/acme/web", method: "GET" }).reply(404, { message: "Not Found" }, JSON_HEADERS);
    pool.intercept({ path: "/orgs/acme/repos", method: "POST" }).reply(
      403,
      { message: "Resource not accessible by personal access token" },
      {
        headers: { "content-type": "application/json", "x-accepted-github-permissions": "administration=write" },
      },
    );
    const e = await rejected(gh.createRepo(input));
    expect(e.code).toBe("forbidden");
    expect(e.missingScopes).toEqual(["administration:write"]);
    expect(e.message).toContain("administration:write");
  });
});

describe("GitHub token openPR", () => {
  it("PR đã mở (422) thì trả lại PR đó", async () => {
    const { gh, pool } = setup();
    pool.intercept({ path: "/repos/acme/web/pulls", method: "POST" }).reply(422, { message: "exists" }, JSON_HEADERS);
    pool
      .intercept({ path: "/repos/acme/web/pulls?head=acme%3Aai%2Ft-1&base=main&state=open", method: "GET" })
      .reply(200, [{ number: 5, html_url: "https://github.com/acme/web/pull/5" }], JSON_HEADERS);
    expect(
      await gh.openPR({ owner: "acme", name: "web" }, { head: "ai/t-1", base: "main", title: "t", body: "b" }),
    ).toEqual({ number: 5, url: "https://github.com/acme/web/pull/5" });
  });
});
