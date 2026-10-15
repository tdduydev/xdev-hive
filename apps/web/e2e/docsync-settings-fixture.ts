import {
  type DocHome,
  defaultProjectSettings,
  docHomeConfigureOrgInput,
  docHomeConfigureProjectInput,
  docHomeStatusOutput,
  type Project,
} from "@xdev-hive/contracts";
// Fixture tự chứa vì fake-hub nạp các fixture này; import ngược sẽ tạo vòng phụ thuộc.
export type DocsyncFixtureHandler = (input: unknown) => { status: number; json: unknown };
const ok = (value: unknown) => ({ status: 200, json: { json: value } });
const fail = (code: string, status: number, message: string, data: unknown) => ({
  status,
  json: { json: { defined: true, code, status, message, data } },
});
const PAYMENT: Project = {
  id: "20202020-0000-4000-8000-000000000003",
  systemId: "20202020-0000-4000-8000-000000000004",
  teamId: "5a5a5a5a-0000-4000-8000-000000000001",
  key: "payment-api",
  name: "Payment API",
  state: "active",
  repo: {
    mode: "existing",
    connectionId: "20202020-0000-4000-8000-000000000005",
    kind: "github",
    owner: "acme",
    name: "payment-api",
    defaultBranch: "main",
    visibility: "private",
    httpUrl: null,
    sshUrl: null,
    webUrl: null,
  },
  settings: defaultProjectSettings(),
  createdBy: "u1",
  createdAt: "2026-10-15T03:00:00.000Z",
  updatedAt: "2026-10-15T03:00:00.000Z",
};

export const DOC_HOME_ID = "20202020-0000-4000-8000-000000000001";
export const DOC_ORG_HOME_ID = "20202020-0000-4000-8000-000000000002";
const NOW = "2026-10-15T03:00:00.000Z";

export function docsyncSettingsFixture(
  options: {
    home?: boolean;
    provider?: "github" | "gitlab";
    error?: "overlap" | "permission" | "protected";
    pages?: boolean;
  } = {},
) {
  const project = structuredClone(PAYMENT);
  project.repo.kind = options.provider ?? "github";
  project.settings.docs.enabled = options.home ?? true;
  const base: DocHome = {
    id: DOC_HOME_ID,
    scope: "project",
    projectId: project.id,
    connectionId: project.repo.connectionId,
    owner: "acme",
    name: project.key,
    branch: "main",
    root: "docs/",
    assetsDir: "assets",
    mode: "pr",
    include: project.settings.docs.include,
    exclude: project.settings.docs.exclude,
    repoChangesNeedReview: false,
    lastCommit: "a".repeat(40),
    status: "active",
    statusReason: null,
    error: null,
    webhookUrl: null,
    prNumber: 128,
    prUrl: `https://${options.provider === "gitlab" ? "gitlab" : "github"}.com/acme/payment-api/${options.provider === "gitlab" ? "-/merge_requests" : "pull"}/128`,
    lfsPatterns: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  const state = {
    project,
    home: options.home === false ? null : (base as DocHome | null),
    orgHome: null as DocHome | null,
    adopted: [] as string[],
    configured: [] as unknown[],
  };
  const find = (input: unknown) =>
    (input as { homeId: string }).homeId === DOC_ORG_HOME_ID ? state.orgHome : state.home;
  const rpc: Record<string, DocsyncFixtureHandler> = {
    "projects/list": () => ok([state.project]),
    "reviewWorkflows/list": () => ok([]),
    "policies/get": () => ok({}),
    "sdlc/modes/list": () => ok([]),
    "machines/list": () => ok([]),
    "docHomes/get": (input) => ok((input as { project?: unknown })?.project ? state.home : state.orgHome),
    "docHomes/status": (input) =>
      ok(
        docHomeStatusOutput.parse({
          home: find(input),
          counts: { synced: 128, pending: 3, conflict: 1, failed: 0, deletedInRepo: 0, blockedSecret: 0, excluded: 2 },
          batches: [],
        }),
      ),
    "docHomes/configureProject": (input) => {
      const parsed = docHomeConfigureProjectInput.parse(input);
      if (options.error === "overlap")
        return fail("CONFLICT", 409, "Thư mục chồng với kho SDLC.", { code: "DOCSYNC_HOME_OVERLAP" });
      if (options.error === "permission")
        return fail("FORBIDDEN", 403, "Kết nối không có quyền đọc và ghi repo tài liệu.", {
          code: "DOCSYNC_NO_ACCESS",
        });
      state.configured.push(parsed);
      state.project.settings.docs = parsed.settings;
      state.home = {
        ...base,
        root: parsed.settings.root,
        assetsDir: parsed.settings.assetsDir,
        include: parsed.settings.include,
        exclude: parsed.settings.exclude,
        mode: parsed.settings.repoSync,
        repoChangesNeedReview: parsed.settings.repoChangesNeedReview,
      };
      return ok(state.home);
    },
    "docHomes/configureOrg": (input) => {
      const parsed = docHomeConfigureOrgInput.parse(input);
      state.configured.push(parsed);
      state.orgHome = {
        ...base,
        ...parsed,
        id: DOC_ORG_HOME_ID,
        projectId: null,
        scope: "org",
        branch: parsed.branch ?? "trunk",
        prUrl: null,
        prNumber: null,
      };
      return ok(state.orgHome);
    },
    "docHomes/syncNow": () =>
      options.error === "protected"
        ? fail("CONFLICT", 409, "Nhánh được bảo vệ. Hãy chuyển sang chế độ mở PR.", {
            code: "DOCSYNC_BRANCH_PROTECTED",
          })
        : ok({ queued: true }),
    "docHomes/pause": (input) => {
      const home = find(input);
      if (home) home.status = "paused";
      return ok(home);
    },
    "docHomes/resume": (input) => {
      const home = find(input);
      if (home) home.status = "active";
      return ok(home);
    },
    "docHomes/acceptBranch": (input) => {
      const home = find(input);
      if (home) {
        home.branch = (input as { branch: string }).branch;
        home.lastCommit = null;
        home.status = "active";
      }
      return ok(home);
    },
    "docHomes/adoptPreview": (input) =>
      ok({
        items: [
          {
            key: (input as { cursor?: string }).cursor ? "project/payment-api/second" : "project/payment-api/guide",
            repoPath: (input as { cursor?: string }).cursor ? "docs/second.md" : "docs/guide.md",
            existsInRepo: true,
            warnings: ["Cần kiểm tra nội dung trước khi ghi."],
          },
        ],
        nextCursor: options.pages && !(input as { cursor?: string }).cursor ? "second" : null,
      }),
    "docHomes/adopt": (input) => {
      state.adopted = (input as { keys: string[] }).keys;
      return ok({ batchId: DOC_HOME_ID });
    },
    "scmConnections/list": () =>
      ok([
        {
          id: base.connectionId,
          kind: options.provider ?? "github",
          name: "Git của Acme",
          baseUrl: null,
          defaultOwner: "acme",
          authMode: "token",
          appId: null,
          installationId: null,
          createdAt: NOW,
        },
      ]),
    "skills/list": () => ok([]),
    "skillRepo/get": () => ok(null),
    "skillLearning/list": () => ok([]),
    "skills/pack": () => ok({ source: { repo: "https://github.com/acme/skills", commit: "a".repeat(40) }, skills: [] }),
  };
  return { state, rpc };
}

export function docsyncSettingsDefaults(): Record<string, DocsyncFixtureHandler> {
  return { "docHomes/get": () => ok(null), "scmConnections/list": () => ok([]) };
}
