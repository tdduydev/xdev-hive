import { expect, type Page } from "@playwright/test";
import { doc, docEditorState, docSearchOutput, docTreeItem, docTreeMoveInput, submitInput } from "@xdev-hive/contracts";
import { DOC_HOME_ID, type DocsyncFixtureHandler } from "./docsync-settings-fixture.ts";

const ok = (value: unknown) => ({ status: 200, json: { json: value } });
const fail = (code: string, status: number, message: string, data?: unknown) => ({
  status,
  json: { json: { defined: true, code, status, message, data } },
});
const NOW = "2026-10-16T03:00:00.000Z";
export const GUIDE_KEY = "org/huong-dan";
const actor = { userId: "u1", runId: null, name: "Người soạn" };
const CONTENT =
  "## Cài đặt\n\nHướng dẫn cài đặt.\n\n![Sơ đồ](assets/so-do.png)\n\n![Logo](assets/logo.png)\n\n[Báo cáo](files/bao-cao.pdf)\n\n[Tài liệu khác](khac.md)\n";

export function docsyncDocsScenario(
  options: {
    provider?: "github" | "gitlab";
    many?: boolean;
    secret?: boolean;
    failMove?: boolean;
    failRetry?: boolean;
    mode?: "keyword" | "hybrid";
  } = {},
) {
  const baseUrl = `https://${options.provider ?? "github"}.com/acme/handbook`;
  const base = doc.parse({
    id: "22222222-0000-4000-8000-000000000001",
    key: GUIDE_KEY,
    title: "Hướng dẫn cài đặt",
    scope: { level: "org", teamId: null, projectId: null },
    version: 3,
    updatedAt: NOW,
    updatedBy: { userId: "u1", runId: null },
    content: CONTENT,
  });
  const orgScope = { level: "org", teamId: null, projectId: null };
  const makeItem = (
    key: string,
    title: string,
    path: string,
    state: "synced" | "pending" | "failed",
    i: number,
    scope: unknown = orgScope,
  ) =>
    docTreeItem.parse({
      homeId: DOC_HOME_ID,
      path,
      key,
      title,
      kind: "doc",
      state,
      prNumber: state === "pending" ? 128 : null,
      prUrl:
        state === "pending" ? `${baseUrl}/${options.provider === "gitlab" ? "-/merge_requests" : "pull"}/128` : null,
      repoUrl: `${baseUrl}/${options.provider === "gitlab" ? "-/blob" : "blob"}/main/${path}`,
      repoCommit: "a".repeat(40),
      docId: `22222222-0000-4000-8000-${String(i).padStart(12, "0")}`,
      assetId: null,
      version: 3,
      error: state === "failed" ? "Không kết nối được repo." : null,
      scope,
    });
  const state = {
    items: [
      makeItem(GUIDE_KEY, base.title, "docs/huong-dan.md", "pending", 1),
      makeItem("org/khac", "Quy trình phát hành", "docs/guide/khac.md", "synced", 2),
      makeItem("org/loi", "Tài liệu lỗi", "docs/loi.md", "failed", 3),
      ...(options.many
        ? Array.from({ length: 205 }, (_, i) =>
            makeItem(`org/bulk-${i}`, `Tài liệu ${i}`, `docs/bulk/${i}.md`, "synced", i + 10),
          )
        : []),
    ],
    archived: new Set<string>(),
    moves: [] as unknown[],
    retries: [] as unknown[],
    searches: [] as unknown[],
    resolves: [] as { docKey: string; hrefs: string[] }[],
    submissions: [] as unknown[],
    draft: docEditorState.parse({
      draft: {
        key: GUIDE_KEY,
        title: base.title,
        content: CONTENT,
        scope: base.scope,
        baseVersion: 3,
        latestVersion: 3,
        revision: 2,
        updatedAt: NOW,
        updatedBy: actor,
        canEdit: true,
      },
      presence: [],
      workflow: null,
      review: null,
      stage: "drafting",
      draftNumber: 1,
      openComments: 0,
      pendingSuggestions: 0,
    }),
  };
  // Sau khi push thành công, API trả synced kèm PR cho tới khi nhánh chính nhận commit.
  if (state.items[0]) state.items[0].state = "synced";
  const docs = () => [
    ...state.items.map((item) => ({ ...base, id: item.docId, key: item.key, title: item.title })),
    { ...base, id: "22222222-0000-4000-8000-000000000004", key: "org/cu", title: "Tài liệu chưa có nhà" },
  ];
  const rpc: Record<string, DocsyncFixtureHandler> = {
    "projects/list": () => ok([]),
    "systems/list": () => ok([]),
    "projectMembers/mine": () => ok({ projectIds: [], teamIds: [] }),
    "docs/list": (input) =>
      ok(
        docs().filter(
          (item) => state.archived.has(item.key as string) === !!(input as { archived?: boolean }).archived,
        ),
      ),
    "docs/get": (input) => ok(docs().find((item) => item.key === (input as { key: string }).key) ?? base),
    "docs/history": () =>
      ok([
        {
          version: 3,
          title: base.title,
          author: base.updatedBy,
          message: "Cập nhật",
          proposalId: null,
          chars: CONTENT.length,
          createdAt: NOW,
        },
      ]),
    "docTree/list": (input) => {
      const { cursor, limit = 200 } = input as { cursor?: string; limit?: number };
      const from = Number(cursor ?? 0);
      const rows = state.items.filter((item) => !state.archived.has(item.key as string));
      return ok({
        items: rows.slice(from, from + limit),
        nextCursor: from + limit < rows.length ? String(from + limit) : null,
      });
    },
    "docTree/move": (input) => {
      const parsed = docTreeMoveInput.parse(input);
      state.moves.push(parsed);
      if (options.failMove)
        return fail("CONFLICT", 409, "Tài liệu đã ở phiên bản 4. Tải lại rồi thử lại.", { code: "VERSION_CONFLICT" });
      const item = state.items.find((item) => item.key === parsed.key);
      if (item) {
        item.path = parsed.repoPath;
        item.state = "pending";
      }
      return ok(item);
    },
    "docHomes/syncNow": (input) => {
      state.retries.push(input);
      return options.failRetry ? fail("FORBIDDEN", 403, "Kết nối đã mất quyền ghi repo.") : ok({ queued: true });
    },
    "docs/archive": (input) => {
      state.archived.add((input as { key: string }).key);
      return ok({ ok: true });
    },
    "docs/restore": (input) => {
      const key = (input as { key: string }).key;
      state.archived.delete(key);
      return ok(docs().find((d) => d.key === key));
    },
    "docs/search": (input) => {
      state.searches.push(input);
      return ok(
        docSearchOutput.parse({
          mode: options.mode ?? "keyword",
          hits: [
            {
              key: GUIDE_KEY,
              title: base.title,
              headingPath: ["Cài đặt", "Postgres"],
              snippet: "Khởi động cơ sở dữ liệu bằng Docker.",
              repoPath: "docs/huong-dan.md",
              extractId: null,
            },
          ],
        }),
      );
    },
    "docAssets/resolve": (input) => {
      const parsed = input as { docKey: string; hrefs: string[] };
      state.resolves.push(parsed);
      return ok(
        parsed.hrefs.map((href) =>
          href.endsWith(".md")
            ? { kind: "doc", href, key: "org/khac" }
            : {
                kind: "asset",
                href,
                assetId: "22222222-0000-4000-8000-0000000000aa",
                url: `/api/v1/docs/assets/image?org=test&file=${encodeURIComponent(href)}`,
              },
        ),
      );
    },
    "docEditor/state": () => ok(state.draft),
    "docEditor/save": (input) => {
      const value = input as { content: string; title?: string; revision: number };
      state.draft.draft = { ...state.draft.draft, ...value, revision: value.revision + 1 };
      return ok(state.draft.draft);
    },
    "docEditor/suggestions/list": () => ok([]),
    "docEditor/comments/list": () => ok([]),
    "docEditor/snapshots/list": () => ok([]),
    "docEditor/presence": () => ok({ ok: true }),
    "docEditor/submitPreview": () => ok({ workflow: null, gates: [], addedLines: 2, deletedLines: 0 }),
    "docEditor/submit": (input) => {
      const parsed = submitInput.parse(input);
      state.submissions.push(parsed);
      if (options.secret && !parsed.acknowledgeSecrets)
        return fail("DOC_SECRET_FOUND", 400, "Có dấu hiệu bí mật.", {
          code: "DOC_SECRET_FOUND",
          findings: [{ kind: "github_token", line: 12 }],
        });
      return ok({
        snapshot: {
          id: "22222222-0000-4000-8000-0000000000bb",
          key: GUIDE_KEY,
          number: 1,
          name: "Gửi duyệt",
          title: base.title,
          content: CONTENT,
          baseVersion: 3,
          draftRevision: 2,
          chars: CONTENT.length,
          submission: null,
          author: actor,
          createdAt: NOW,
        },
        proposalId: "22222222-0000-4000-8000-0000000000cc",
        reviewId: null,
      });
    },
  };
  return { state, rpc };
}

export function docsyncDocsFixture(): Record<string, DocsyncFixtureHandler> {
  return {
    "docTree/list": () => ok({ items: [], nextCursor: null }),
    // Trang Tài liệu hỏi thêm ba danh mục này để dựng cây theo đơn vị; mặc định chưa thuộc dự án nào.
    "projectMembers/mine": () => ok({ projectIds: [], teamIds: [] }),
    "systems/list": () => ok([]),
  };
}

/** Cây tài liệu chỉ mở sẵn nhánh tới dự án của người dùng, nên test cần mở hết trước khi tìm một dòng. */
export async function expandDocTree(page: Page) {
  await expect(page.getByRole("list", { name: "Cây tài liệu" })).toBeVisible({ timeout: 20_000 });
  const closed = page.getByRole("list", { name: "Cây tài liệu" }).locator('button[aria-expanded="false"]');
  while ((await closed.count()) > 0) await closed.first().click();
}
