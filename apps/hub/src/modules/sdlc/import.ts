import { implement } from "@orpc/server";
import { contract, DOC_MAX_CHARS, type SdlcItemDetail, type SdlcSize } from "@xdev-hive/contracts";
import { loadProject } from "../catalog/index.ts";
import { BadRequestError, NotFoundError, type RequestContext, type Tx } from "../platform/index.ts";
import { loadConnection } from "../scm/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { requireProjectWrite } from "./access.ts";
import { createItem } from "./items.ts";
import type { SdlcDeps } from "./phases.ts";

/*
 * Nhận thư mục tài liệu có sẵn trong repo làm hạng mục (FR-009, edge case brownfield): `specs/009-hoan-tien` viết tay
 * thành hạng mục số 009, file trong thư mục thành bản nháp đầu. Không file nào thành baseline: bản trong repo chưa qua
 * cổng nên vẫn duyệt như thường.
 */

/** Số file đọc tối đa của một thư mục: thư mục tài liệu một hạng mục hiếm khi quá vài chục file. */
export const IMPORT_MAX_FILES = 100;

/** `<NNN>-<slug>` ở đoạn cuối đường dẫn; null khi tên thư mục không theo mẫu. */
export function parseItemFolder(path: string): { dir: string; number: number; slug: string } | null {
  const dir = path.replace(/\/+$/, "");
  const m = /^(\d{1,4})-([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(dir.split("/").at(-1) ?? "");
  if (!m?.[1] || !m[2]) return null;
  const number = Number(m[1]);
  return number > 0 ? { dir, number, slug: m[2] } : null;
}

const SPEC_PREFIX = /^(?:feature specification|specification|spec|đặc tả(?: tính năng)?)\s*:\s*/i;

/** Tiêu đề từ dòng `# ` đầu của file đặc tả (ưu tiên `spec.md`), không có thì từ slug. */
export function importTitle(files: ReadonlyMap<string, string>, slug: string): string {
  const order = [...files.keys()].sort((a, b) => Number(!a.endsWith("/spec.md")) - Number(!b.endsWith("/spec.md")));
  for (const path of order) {
    if (!path.endsWith(".md")) continue;
    const heading = /^#\s+(.+?)\s*#*\s*$/m
      .exec(files.get(path) ?? "")?.[1]
      ?.replace(SPEC_PREFIX, "")
      .trim();
    if (heading && heading.length >= 3) return heading.slice(0, 200);
  }
  const words = slug.replace(/-/g, " ");
  return words.length >= 3 ? words : `Hạng mục ${slug}`;
}

/**
 * `items.import`: đọc thư mục ở đầu nhánh mặc định của dự án chính rồi tạo hạng mục bằng chính số và slug của thư
 * mục. Đọc Git trong transaction của request vì phải từ chối trước khi ghi, như kiểm trùng đường dẫn lúc tạo.
 */
export async function importItem(
  tx: Tx,
  userId: string,
  input: { projectId: string; path: string; modeRef: string; size: SdlcSize },
  deps: SdlcDeps = {},
): Promise<SdlcItemDetail> {
  const project = await loadProject(tx, input.projectId);
  if (!project) throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án.");
  // Kiểm quyền trước khi đọc repo: người không có quyền không dò được thư mục nào tồn tại.
  await requireProjectWrite(tx, userId, [project.id]);
  const folder = parseItemFolder(input.path);
  if (!folder)
    throw new BadRequestError("SDLC_IMPORT_PATH", "Tên thư mục cần có dạng <số>-<tên>, ví dụ specs/009-hoan-tien.");
  if (!deps.providerFactory || !deps.masterKey)
    throw new BadRequestError("SDLC_IMPORT_NO_GIT", "Hub chưa cấu hình kết nối Git nên không đọc được repo.");
  const conn = await loadConnection(tx, deps.masterKey, project.scmConnectionId);
  if (!conn) throw new BadRequestError("SDLC_IMPORT_NO_GIT", `Dự án ${project.key} không còn kết nối Git.`);
  const provider = deps.providerFactory(conn);
  const repo = { owner: project.repoOwner, name: project.repoName };
  const branch = project.defaultBranch ?? "main";
  const head = await provider.branchHead(repo, branch);
  const paths = head ? (await provider.listFiles(repo, head)).filter((f) => f.startsWith(`${folder.dir}/`)) : [];
  if (!head || !paths.length)
    throw new NotFoundError("SDLC_IMPORT_EMPTY", `Không thấy file nào trong ${folder.dir} ở nhánh ${branch}.`);
  if (paths.length > IMPORT_MAX_FILES)
    throw new BadRequestError(
      "SDLC_IMPORT_TOO_MANY",
      `Thư mục có ${paths.length} file, nhận tối đa ${IMPORT_MAX_FILES}. Tách bớt rồi thử lại.`,
    );
  const contents = new Map<string, string>();
  for (const path of paths) {
    const content = await provider.readFile(repo, path, head);
    if (content === null) continue;
    if (content.length > DOC_MAX_CHARS)
      throw new BadRequestError(
        "SDLC_IMPORT_TOO_LARGE",
        `${path} dài quá ${DOC_MAX_CHARS} ký tự, tách thành nhiều file.`,
      );
    contents.set(path, content);
  }
  return createItem(
    tx,
    userId,
    {
      projectId: project.id,
      participants: [],
      title: importTitle(contents, folder.slug),
      idea: `Nhập từ repo: thư mục ${folder.dir} của dự án ${project.key} (commit ${head.slice(0, 7)}).`,
      modeRef: input.modeRef,
      size: input.size,
    },
    deps,
    { imported: { number: folder.number, slug: folder.slug, path: folder.dir, contents } },
  );
}

/** Hàm đăng ký riêng để router.ts chỉ thêm `import: importRoute(deps)` vào `items` (T070 gộp). */
export function importRoute(deps: OrgDeps & SdlcDeps) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const os = implement(contract.sdlc).$context<RequestContext>().use(authed).use(inOrg);
  return os.items.import.handler(({ context: { tx, user }, input }) => importItem(tx, user.id, input, deps));
}
