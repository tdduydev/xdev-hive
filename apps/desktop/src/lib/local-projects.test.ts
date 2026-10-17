import type { Project } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import type { GitGroup, GitHost } from "@/lib/git-groups.ts";
import {
  bindingState,
  filterRepoSections,
  groupLocalRepos,
  type LocalProject,
  matchLegacy,
  type RepoSection,
  sameRepo,
} from "@/lib/local-projects.ts";

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

const shape = (sections: RepoSection[]) => sections.map((s) => [s.title, s.host, s.repos.map((r) => r.name)]);

describe("gom repo trên máy theo nhóm", () => {
  const hisApi = local({
    name: "his-api",
    folder: "/w/his-api",
    origin: "https://gitlab.fis.vn/ehospital-ai/his/his-api.git",
  });
  const hisWeb = local({
    name: "his-web",
    folder: "/w/his-web",
    origin: "git@gitlab.fis.vn:ehospital-ai/his/his-web.git",
  });
  const emr = local({
    name: "emr-core",
    folder: "/w/emr-core",
    origin: "https://gitlab.fis.vn/ehospital-ai/emr/emr-core.git",
  });
  const pay = local({ name: "pay", folder: "/w/pay", origin: "git@github.com:acme/pay.git" });

  it("theo namespace của remote (cả group lồng của GitLab), sắp mục và repo theo tên", () => {
    const x = local({ name: "x", folder: "/w/x", origin: "https://gitlab.com/acme/x.git" });
    expect(shape(groupLocalRepos([hisWeb, emr, hisApi, x, pay], null))).toEqual([
      ["acme", "github.com", ["pay"]],
      ["acme", "gitlab.com", ["x"]],
      ["ehospital-ai/emr", "gitlab.fis.vn", ["emr-core"]],
      ["ehospital-ai/his", "gitlab.fis.vn", ["his-api", "his-web"]],
    ]);
  });

  it("không có remote, hoặc remote không đọc được, thì theo thư mục cha và xếp sau các mục theo remote", () => {
    const got = groupLocalRepos(
      [
        local({ name: "notes", folder: "/srv/work/notes", origin: undefined }),
        local({ name: "Tool", folder: "/srv/work/tool/", origin: "/srv/bare/tool.git" }),
        local({ name: "legacy", folder: "/srv/old/legacy", origin: undefined }),
        pay,
      ],
      null,
    );
    expect(shape(got)).toEqual([
      ["acme", "github.com", ["pay"]],
      ["/srv/old", null, ["legacy"]],
      ["/srv/work", null, ["notes", "Tool"]],
    ]);
  });

  it("thư mục cha trên Windows, rút gọn thư mục nhà", () => {
    const got = groupLocalRepos(
      [local({ name: "a", folder: "C:\\Users\\ha\\Code\\scratch\\a", origin: undefined })],
      null,
    );
    expect(shape(got)).toEqual([["~\\Code\\scratch", null, ["a"]]]);
  });

  it("repo thuộc Nhóm Git theo dõi lấy tên theo nhóm; máy chủ đã kết nối hiện tên kết nối", () => {
    const hosts: GitHost[] = [{ id: "h1", kind: "gitlab", url: "https://gitlab.fis.vn", name: "GitLab FIS" }];
    const groups: GitGroup[] = [
      {
        id: "g1",
        hostId: "h1",
        path: "ehospital-ai",
        root: "E:\\Codes\\ehospital-ai",
        protocol: "https",
        repos: [
          {
            path: "ehospital-ai/his/his-admin",
            name: "his-admin",
            httpUrl: "https://gitlab.fis.vn/ehospital-ai/his/his-admin.git",
            sshUrl: "git@gitlab.fis.vn:ehospital-ai/his/his-admin.git",
          },
        ],
      },
    ];
    const got = groupLocalRepos(
      [
        // Chưa có trong danh sách nhóm đọc lần trước, chữ hoa khác: vẫn chung mục với repo của nhóm.
        local({ name: "his-api", folder: "/w/his-api", origin: "https://gitlab.fis.vn/EHospital-AI/HIS/his-api.git" }),
        local({
          name: "his-admin",
          folder: "/w/his-admin",
          origin: "git@gitlab.fis.vn:EHospital-AI/HIS/his-admin.git",
        }),
        emr,
        pay,
      ],
      { hosts, groups },
    );
    expect(shape(got)).toEqual([
      ["acme", "github.com", ["pay"]],
      ["ehospital-ai/emr", "GitLab FIS", ["emr-core"]],
      ["ehospital-ai/his", "GitLab FIS", ["his-admin", "his-api"]],
    ]);
  });

  it("lọc theo tên mục, máy chủ, tên repo, thư mục hoặc remote; ô trống thì giữ nguyên", () => {
    const sections = groupLocalRepos([hisApi, hisWeb, emr, pay], null);
    expect(filterRepoSections(sections, "  ")).toEqual(sections);
    expect(shape(filterRepoSections(sections, "HIS"))).toEqual([
      ["ehospital-ai/his", "gitlab.fis.vn", ["his-api", "his-web"]],
    ]);
    expect(shape(filterRepoSections(sections, "github"))).toEqual([["acme", "github.com", ["pay"]]]);
    expect(shape(filterRepoSections(sections, "web"))).toEqual([["ehospital-ai/his", "gitlab.fis.vn", ["his-web"]]]);
    expect(shape(filterRepoSections(sections, "/w/emr"))).toEqual([
      ["ehospital-ai/emr", "gitlab.fis.vn", ["emr-core"]],
    ]);
    expect(shape(filterRepoSections(sections, "his-web.git"))).toEqual([
      ["ehospital-ai/his", "gitlab.fis.vn", ["his-web"]],
    ]);
    expect(filterRepoSections(sections, "khong-co")).toEqual([]);
  });
});
