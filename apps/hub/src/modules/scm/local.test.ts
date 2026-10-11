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

  it("getPR tính mergeable bằng git, mergePR merge thật vào nhánh chính", async () => {
    const repo = { owner: "e2e", name: "mq" };
    await scm.createRepo({ ...repo, visibility: "private", defaultBranch: "main", marker });
    const mqDir = join(opts.root, "e2e", "mq.git");
    const head = await scm.commitFiles(repo, {
      branch: "ai/MQ-1",
      fromBranch: "main",
      message: "feat: một",
      files: [{ path: "a.txt", content: "một\n" }],
    });
    const pr = await scm.openPR(repo, { head: "ai/MQ-1", base: "main", title: "MQ-1", body: "" });
    expect(await scm.getPR(repo, pr.number)).toMatchObject({
      number: pr.number,
      state: "open",
      head: "ai/MQ-1",
      headSha: head.sha,
      base: "main",
      mergeable: "clean",
    });
    expect(await scm.getPR(repo, 999_999_999)).toBeNull();
    expect(await scm.checksFor(repo, head.sha)).toBe("none");

    // Nhánh chính tiến nhưng không đụng file của PR: vẫn clean, squash giữ cả hai thay đổi.
    await scm.commitFiles(repo, { branch: "main", message: "chore: b", files: [{ path: "b.txt", content: "b\n" }] });
    expect((await scm.getPR(repo, pr.number))?.mergeable).toBe("clean");
    const stale = await scm.mergePR(repo, pr.number, { method: "squash", sha: "0".repeat(40) }).catch((e) => e);
    expect(isGitProviderError(stale, "conflict")).toBe(true);
    const { sha } = await scm.mergePR(repo, pr.number, { method: "squash", sha: head.sha });
    expect(git("--git-dir", mqDir, "rev-parse", "main")).toBe(sha);
    expect(git("--git-dir", mqDir, "rev-list", "--parents", "-n1", "main").split(" ")).toHaveLength(2);
    expect(git("--git-dir", mqDir, "show", "main:a.txt")).toBe("một");
    expect(git("--git-dir", mqDir, "show", "main:b.txt")).toBe("b");
    expect(await scm.getPR(repo, pr.number)).toMatchObject({ state: "merged" });
    const saved = JSON.parse(readFileSync(fileURLToPath(pr.url), "utf8")) as LocalPullRequest;
    expect(saved).toMatchObject({ state: "merged", mergeSha: sha });
    const again = await scm.mergePR(repo, pr.number, { method: "squash", sha: head.sha }).catch((e) => e);
    expect(isGitProviderError(again, "conflict")).toBe(true);
  });

  it("xung đột với nhánh chính thì conflict; merge giữ head làm cha thứ hai", async () => {
    const repo = { owner: "e2e", name: "mq2" };
    await scm.createRepo({ ...repo, visibility: "private", defaultBranch: "main", marker });
    const mqDir = join(opts.root, "e2e", "mq2.git");
    const x = await scm.commitFiles(repo, {
      branch: "ai/X",
      fromBranch: "main",
      message: "x",
      files: [{ path: "README.md", content: "x\n" }],
    });
    const y = await scm.commitFiles(repo, {
      branch: "ai/Y",
      fromBranch: "main",
      message: "y",
      files: [{ path: "y.txt", content: "y\n" }],
    });
    const px = await scm.openPR(repo, { head: "ai/X", base: "main", title: "X", body: "" });
    const py = await scm.openPR(repo, { head: "ai/Y", base: "main", title: "Y", body: "" });
    await scm.commitFiles(repo, { branch: "main", message: "đổi", files: [{ path: "README.md", content: "z\n" }] });
    expect((await scm.getPR(repo, px.number))?.mergeable).toBe("conflict");
    const err = await scm.mergePR(repo, px.number, { method: "squash", sha: x.sha }).catch((e) => e);
    expect(isGitProviderError(err, "conflict")).toBe(true);
    await scm.mergePR(repo, py.number, { method: "merge", sha: y.sha });
    const parents = git("--git-dir", mqDir, "rev-list", "--parents", "-n1", "main").split(" ");
    expect(parents).toHaveLength(3);
    expect(parents[2]).toBe(y.sha);
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
