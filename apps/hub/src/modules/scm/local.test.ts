import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createProviderFactory, type ResolvedConnection } from "./connections.ts";
import { isGitProviderError } from "./errors.ts";
import { createLocalProvider, type LocalPullRequest, localProviderFromEnv } from "./local.ts";

// Provider chỉ để thử của scripts/e2e-smoke.ts: gọi git thật trên thư mục tạm.
const root = mkdtempSync(join(tmpdir(), "hive-local-scm-"));
const opts = { root: join(root, "repos"), prDir: join(root, "prs") };
const marker = "hive:prj_local";
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

afterAll(() => rmSync(root, { recursive: true, force: true }));

const conn = (baseUrl: string | null): ResolvedConnection => ({
  id: "00000000-0000-4000-8000-000000000001",
  kind: "gitlab",
  name: "e2e",
  baseUrl,
  defaultOwner: "e2e",
  authMode: "token",
  appId: null,
  installationId: null,
  createdAt: new Date(),
  secret: { token: "khong-dung-that" },
});

describe("localProviderFromEnv", () => {
  it("chỉ bật khi có cả HIVE_E2E=1 và HIVE_E2E_GIT_ROOT", () => {
    expect(localProviderFromEnv({})).toBeUndefined();
    expect(localProviderFromEnv({ HIVE_E2E_GIT_ROOT: "/tmp/x" })).toBeUndefined();
    expect(localProviderFromEnv({ HIVE_E2E: "1" })).toBeUndefined();
    expect(localProviderFromEnv({ HIVE_E2E: "1", HIVE_E2E_GIT_ROOT: "/tmp/x" })).toEqual({
      root: "/tmp/x",
      prDir: join("/tmp/x", "_prs"),
    });
    expect(() => localProviderFromEnv({ HIVE_E2E: "1", HIVE_E2E_GIT_ROOT: "tuong-doi" })).toThrow(/tuyệt đối/);
  });
});

describe("createProviderFactory với provider local", () => {
  // fetch luôn lỗi: provider GitLab thật sẽ gọi mạng, còn provider local thì không.
  const offline = () => Promise.reject(new Error("không có mạng"));

  it("chỉ dùng provider local cho host hive-e2e.invalid khi đã bật", async () => {
    const enabled = createProviderFactory({ fetch: offline, local: opts });
    expect(await enabled(conn("https://hive-e2e.invalid")).checkAccess("e2e")).toEqual({
      canCreate: true,
      missingScopes: [],
    });
    await expect(enabled(conn("https://gitlab.com")).checkAccess("e2e")).rejects.toThrow();
    // Tắt chế độ thử thì kết nối hive-e2e.invalid chỉ là kết nối GitLab không tới được.
    const disabled = createProviderFactory({ fetch: offline });
    await expect(disabled(conn("https://hive-e2e.invalid")).checkAccess("e2e")).rejects.toThrow();
  });
});

describe("createLocalProvider", () => {
  const scm = createLocalProvider("gitlab", opts);
  const ref = { owner: "e2e", name: "web" };

  it("tạo bare repo có README trên nhánh chính, clone được qua file://", async () => {
    const repo = await scm.createRepo({ ...ref, visibility: "private", defaultBranch: "main", marker });
    expect(repo).toMatchObject({ owner: "e2e", name: "web", defaultBranch: "main", visibility: "private" });
    expect(repo.description).toContain(`[${marker}]`);
    expect(repo.httpUrl).toMatch(/^file:\/\//);
    expect(await scm.getRepo(ref)).toEqual(repo);
    expect(await scm.getRepo({ owner: "e2e", name: "chua-co" })).toBeNull();
    const clone = join(root, "clone");
    git("clone", "--quiet", repo.httpUrl, clone);
    expect(readFileSync(join(clone, "README.md"), "utf8")).toBe("# web\n");
  });

  it("tạo lại cùng marker trả repo cũ, khác marker báo conflict", async () => {
    const again = await scm.createRepo({ ...ref, visibility: "private", defaultBranch: "main", marker });
    expect(again.name).toBe("web");
    const err = await scm
      .createRepo({ ...ref, visibility: "private", defaultBranch: "main", marker: "hive:khac" })
      .catch((e: unknown) => e);
    expect(isGitProviderError(err, "conflict")).toBe(true);
  });

  it("commit file vào nhánh có sẵn và nhánh mới tạo từ nhánh chính", async () => {
    const dir = join(opts.root, "e2e", "web.git");
    const { sha } = await scm.commitFiles(ref, {
      branch: "main",
      message: "chore: file mẫu",
      files: [{ path: "AGENTS.md", content: "# Agent\n" }],
    });
    expect(git("--git-dir", dir, "rev-parse", "main")).toBe(sha);
    expect(git("--git-dir", dir, "show", "main:AGENTS.md")).toBe("# Agent");
    expect(git("--git-dir", dir, "show", "main:README.md")).toBe("# web");
    const branch = await scm.commitFiles(ref, {
      branch: "ai/WEB-1",
      fromBranch: "main",
      message: "feat: đổi",
      files: [{ path: "README.md", content: "# web đổi\n" }],
    });
    expect(git("--git-dir", dir, "rev-parse", "ai/WEB-1^")).toBe(sha);
    expect(branch.sha).not.toBe(sha);
    const missing = await scm
      .commitFiles(ref, { branch: "x", fromBranch: "khong-co", message: "m", files: [] })
      .catch((e: unknown) => e);
    expect(isGitProviderError(missing, "not_found")).toBe(true);
  });

  it("openPR ghi file JSON, gọi lại cùng head trả PR cũ", async () => {
    const pr = await scm.openPR(ref, { head: "ai/WEB-1", base: "main", title: "WEB-1: đổi", body: "Nội dung" });
    const file = fileURLToPath(pr.url);
    const saved = JSON.parse(readFileSync(file, "utf8")) as LocalPullRequest;
    expect(saved).toMatchObject({ number: pr.number, owner: "e2e", name: "web", head: "ai/WEB-1", base: "main" });
    expect(saved.headSha).toBe(git("--git-dir", join(opts.root, "e2e", "web.git"), "rev-parse", "ai/WEB-1"));
    expect(await scm.openPR(ref, { head: "ai/WEB-1", base: "main", title: "lại", body: "" })).toEqual(pr);
    const noBranch = await scm.openPR(ref, { head: "ai/khong-co", base: "main", title: "t", body: "" }).catch((e) => e);
    expect(isGitProviderError(noBranch, "not_found")).toBe(true);
  });

  it("chặn owner hoặc tên repo thoát khỏi thư mục gốc", async () => {
    for (const bad of [
      { owner: "..", name: "web" },
      { owner: "e2e", name: ".." },
      { owner: "e2e/../..", name: "web" },
    ]) {
      const err = await scm.getRepo(bad).catch((e: unknown) => e);
      expect(isGitProviderError(err, "invalid")).toBe(true);
    }
  });
});
