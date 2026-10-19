import {
  type DocHome,
  type DocImport,
  type DocImportFile,
  docImport,
  docImportFile,
  docImportScanInput,
  docImportStartInput,
} from "@xdev-hive/contracts";
import { DOC_HOME_ID, type DocsyncFixtureHandler } from "./docsync-settings-fixture.ts";

const ok = (value: unknown) => ({ status: 200, json: { json: value } });
const NOW = "2026-10-15T03:00:00.000Z";
const IMPORT_ID = "20202020-0000-4000-8000-0000000000a1";
const COMMIT = "b".repeat(40);

const file = (path: string, patch: Partial<DocImportFile> = {}): DocImportFile =>
  docImportFile.parse({
    path,
    blobSha: "a".repeat(40),
    key: null,
    existingKey: null,
    kind: "markdown",
    size: 2048,
    warnings: [],
    secretScan: "clean",
    findings: [],
    state: "pending",
    docId: null,
    assetId: null,
    error: null,
    ...patch,
  });

export const DUP_KEY = "project/payment-api/guide/dup";

export function docsyncImportScenario(options: { many?: boolean; failScan?: boolean } = {}) {
  const files: DocImportFile[] = [
    file("docs/a.md"),
    file("docs/guide/b.md"),
    file("docs/guide/secret.md", { secretScan: "found", findings: [{ line: 12, kind: "github_token" }] }),
    file("docs/guide/dup.md", { existingKey: DUP_KEY, warnings: ["Trùng key với tài liệu có sẵn."] }),
    file("docs/slides.pdf", { kind: "office", size: 9_000_000, warnings: ["File quá lớn, chỉ lưu bản đính kèm."] }),
    file("specs/x.md"),
    ...(options.many ? Array.from({ length: 250 }, (_, i) => file(`bulk/n${String(i).padStart(3, "0")}.md`)) : []),
  ];
  const home = {
    id: DOC_HOME_ID,
    scope: "org",
    projectId: null,
    connectionId: "20202020-0000-4000-8000-000000000005",
    owner: "acme",
    name: "handbook",
    branch: "main",
    root: "docs/",
    assetsDir: "assets",
    mode: "direct",
    include: ["docs/**", "specs/**"],
    exclude: ["**/node_modules/**"],
    repoChangesNeedReview: false,
    wordImportConfidential: false,
    lastCommit: COMMIT,
    status: "active",
    statusReason: null,
    error: null,
    webhookUrl: null,
    prNumber: null,
    prUrl: null,
    lfsPatterns: [],
    createdAt: NOW,
    updatedAt: NOW,
  } satisfies DocHome;
  const state = {
    run: null as DocImport | null,
    files,
    scans: [] as unknown[],
    started: null as ReturnType<typeof docImportStartInput.parse> | null,
    confirmed: [] as string[],
    cancelled: false,
    gets: 0,
  };
  const make = (patch: Partial<DocImport>): DocImport =>
    docImport.parse({
      id: IMPORT_ID,
      homeId: DOC_HOME_ID,
      commitSha: COMMIT,
      state: "ready",
      include: [],
      exclude: [],
      progress: { done: 0, total: 0, cursor: null },
      report: null,
      error: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...patch,
    });
  const finish = () => {
    const picked = new Set(state.started?.paths ?? []);
    let imported = 0;
    for (const item of state.files) {
      if (!picked.has(item.path)) continue;
      if (item.secretScan === "found") item.state = "blocked_secret";
      else {
        item.state = "done";
        imported += 1;
      }
    }
    const blocked = state.files.filter((item) => item.state === "blocked_secret").length;
    state.run = make({
      state: "done",
      progress: { done: picked.size, total: picked.size, cursor: null },
      report: { imported, skipped: state.files.length - picked.size, blockedSecret: blocked, failed: 0, warnings: [] },
      updatedAt: "2026-10-15T03:00:09.000Z",
    });
  };
  const rpc: Record<string, DocsyncFixtureHandler> = {
    "docHomes/get": () => ok(home),
    "docImports/list": () =>
      ok({ items: state.run && state.run.state !== "done" ? [state.run] : [], nextCursor: null }),
    "docImports/scan": (input) => {
      state.scans.push(docImportScanInput.parse(input));
      state.run = make({ state: "scanning", updatedAt: NOW });
      state.gets = 0;
      return ok(state.run);
    },
    "docImports/get": () => {
      state.gets += 1;
      const run = state.run;
      if (!run)
        return { status: 404, json: { json: { defined: false, code: "NOT_FOUND", status: 404, message: "x" } } };
      if (run.state === "scanning" && state.gets >= 2) {
        state.run = make({ state: "ready", progress: { done: 0, total: state.files.length, cursor: null } });
      } else if (run.state === "importing") {
        const total = run.progress.total;
        const done = Math.min(total, run.progress.done + Math.ceil(total / 2));
        if (done >= total) finish();
        else
          state.run = make({
            state: "importing",
            progress: { done, total, cursor: null },
            updatedAt: `2026-10-15T03:00:0${done}.000Z`,
          });
      }
      return ok(state.run);
    },
    "docImports/files": (input) => {
      const { cursor } = input as { cursor?: string };
      const from = cursor ? Number(cursor) : 0;
      const items = state.files.slice(from, from + 200);
      return ok({ items, nextCursor: from + 200 < state.files.length ? String(from + 200) : null });
    },
    "docImports/start": (input) => {
      state.started = docImportStartInput.parse(input);
      state.run = make({
        state: "importing",
        progress: { done: 0, total: state.started.paths.length, cursor: null },
        updatedAt: "2026-10-15T03:00:01.000Z",
      });
      return ok(state.run);
    },
    "docImports/cancel": () => {
      state.cancelled = true;
      state.run = make({
        state: "cancelled",
        report: { imported: 0, skipped: 0, blockedSecret: 0, failed: 0, warnings: [] },
        updatedAt: "2026-10-15T03:00:09.000Z",
      });
      return ok(state.run);
    },
    "docImports/confirmSecret": (input) => {
      const { path } = input as { path: string };
      state.confirmed.push(path);
      const item = state.files.find((candidate) => candidate.path === path);
      if (item) Object.assign(item, { secretScan: "clean", findings: [], state: "pending" });
      return ok({ queued: true });
    },
    "docs/get": () =>
      ok({
        id: IMPORT_ID,
        key: DUP_KEY,
        title: "Dup",
        scope: { level: "project", teamId: null, projectId: "20202020-0000-4000-8000-000000000003" },
        version: 3,
        updatedAt: NOW,
        updatedBy: { userId: "u1", runId: null },
        content: "x",
      }),
    "projects/list": () => ok([]),
  };
  return { state, rpc };
}

export function docsyncImportFixture(): Record<string, DocsyncFixtureHandler> {
  return {};
}
