import type { Project } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { bindingState, type LocalProject, matchLegacy, sameRepo } from "@/lib/local-projects.ts";

const hubProject = (over: Partial<Project> & { id: string; key: string; name: string }, url: string): Project =>
  ({
    systemId: "s1",
    teamId: "t1",
    state: "active",
    repo: {
      mode: "existing",
      connectionId: "c1",
      kind: "github",
      owner: "acme",
      name: over.key,
      defaultBranch: "main",
      visibility: "private",
      httpUrl: url,
      sshUrl: null,
      webUrl: url.replace(/\.git$/, ""),
    },
    settings: {},
    createdBy: "u1",
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
    ...over,
  }) as Project;

const local = (over: Partial<LocalProject>): LocalProject => ({
  projectId: "",
  name: "app",
  folder: "/Users/ha/Work/app",
  fullPermission: false,
  exists: true,
  isGit: true,
  origin: "git@github.com:acme/app.git",
  ...over,
});

describe("so URL repo như worker", () => {
  it("bỏ giao thức, tên đăng nhập, cổng, đuôi .git và hoa thường", () => {
    expect(sameRepo("https://github.com/acme/payment-api.git", "git@github.com:acme/payment-api.git")).toBe(true);
    expect(sameRepo("https://x-access-token:secret@github.com/Acme/App.git", "https://github.com/acme/app")).toBe(true);
    expect(
      sameRepo("ssh://git@gitlab.example.com:2222/group/sub/app.git", "https://gitlab.example.com/group/sub/app"),
    ).toBe(true);
    expect(sameRepo("https://github.com/acme/app", "https://github.com/acme/app-v2")).toBe(false);
    expect(sameRepo("https://github.com/acme/app", "https://gitlab.com/acme/app")).toBe(false);
    expect(sameRepo(undefined, "https://github.com/acme/app")).toBe(false);
    expect(sameRepo("/Users/ha/app", "/Users/ha/app")).toBe(false);
  });
});

describe("trạng thái gắn", () => {
  const p = hubProject({ id: "p1", key: "app", name: "App" }, "https://github.com/acme/app.git");
  it("chưa gắn, đã gắn, remote không khớp, thư mục mất", () => {
    expect(bindingState(p, undefined)).toBe("unbound");
    expect(bindingState(p, local({ projectId: "p1" }))).toBe("bound");
    expect(bindingState(p, local({ projectId: "p1", origin: "git@github.com:acme/khac.git" }))).toBe("mismatch");
    expect(bindingState(p, local({ projectId: "p1", origin: undefined }))).toBe("mismatch");
    expect(bindingState(p, local({ projectId: "p1", isGit: false }))).toBe("mismatch");
    expect(bindingState(p, local({ projectId: "p1", exists: false }))).toBe("missing");
  });
});

describe("ghép repo của app cũ với dự án hub", () => {
  const app = hubProject({ id: "p1", key: "app", name: "App" }, "https://github.com/acme/app.git");
  const pay = hubProject({ id: "p2", key: "pay", name: "Thanh toán" }, "https://github.com/acme/payment.git");
  const docs = hubProject({ id: "p3", key: "docs", name: "Docs" }, "https://github.com/acme/docs.git");
  it("theo remote origin trước, rồi theo tên khi chỉ một dự án trùng tên", () => {
    const got = matchLegacy(
      [app, pay, docs],
      [
        local({ name: "khong-ten", folder: "/a", origin: "https://github.com/acme/app" }),
        local({ name: "thanh toán", folder: "/b", origin: "git@gitlab.com:x/y.git" }),
        local({ name: "DOCS", folder: "/c", origin: undefined }),
        local({ name: "la", folder: "/d", origin: "git@github.com:acme/la.git" }),
      ],
    );
    expect(got.map((m) => [m.folder, m.project.id])).toEqual([
      ["/a", "p1"],
      ["/b", "p2"],
      ["/c", "p3"],
    ]);
  });
  it("bỏ dự án đã gắn trên máy và không gắn một dự án cho hai repo", () => {
    const got = matchLegacy(
      [app, pay],
      [
        local({ projectId: "p2", folder: "/da-gan", origin: "https://github.com/acme/payment" }),
        local({ folder: "/x", origin: "https://github.com/acme/payment" }),
        local({ folder: "/y", origin: "https://github.com/acme/app" }),
        local({ folder: "/z", origin: "https://github.com/acme/app.git" }),
      ],
    );
    expect(got.map((m) => [m.folder, m.project.id])).toEqual([["/y", "p1"]]);
  });
});
